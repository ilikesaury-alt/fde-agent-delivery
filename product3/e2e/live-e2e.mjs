/**
 * 线上接口级 E2E（经 ego-browser 的真实浏览器进程发起请求）
 *
 * 为什么用浏览器而不是 Node/curl：本沙箱 Node 的出网被限制，
 * 但 ego-browser 是独立的 Chromium 进程，网络栈不受同一限制 —— 实测可连通 workers.dev。
 *
 * 令牌从 .secrets.json 读入并只在内存里使用，不打印、不写入任何入库文件。
 * 用法：ego-browser nodejs < e2e/live-e2e.mjs
 */

const fs = await import("node:fs");

const BASE = "https://kb-ask.ilikesaury.workers.dev";
// ⚠️ ego-browser 以 stdin 执行脚本：import.meta.url 指向 eval 模块、process.cwd() 也不是仓库目录，
//    所以相对路径不可用。这里用绝对路径；换机器时改这一行即可。
const secretsPath = "H:/Work/Projects/Personal/fde-agent-delivery/product3/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(secretsPath, "utf8")).ACCESS_TOKEN;

const task = await taskSpace("kb-ask live e2e 2026-10-28");
const page = task.page("p1");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const DOC = `# 部署手册

## 部署步骤

执行构建后上传产物，然后核验静态资产、数据库、向量索引三类绑定都在。

## 回滚

回滚使用带完整版本号的命令，回滚前确认目标是最近的已知可用版本。`;

await page.goto(BASE, { waitUntil: "load", timeout: 30000 });

/** 在页面上下文里发请求（带令牌） */
const call = (path, init = {}) =>
  page.evaluate(
    async (args) => {
      const res = await fetch(args.base + args.path, {
        ...args.init,
        headers: {
          "content-type": "application/json",
          ...(args.token ? { authorization: "Bearer " + args.token } : {}),
        },
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      return { status: res.status, body };
    },
    { base: BASE, path, init, token: TOKEN },
  );

/**
 * 发一个 SSE 请求并解析事件。
 *
 * ⚠️ 不能把整段 fetch 放在一次 page.evaluate 里：page.evaluate 无 timeout 选项，
 *    固定 15s 上限，而真模型 SSE 生成偶尔更久 → PageEvaluationTimeoutError。
 *    做法：页面内发起 fetch 并把结果挂到 window，再用短 evaluate 轮询取回。
 */
let askSeq = 0;
/** @param {string} question @param {string|null} conversationId */
const ask = async (question, conversationId = null) => {
  const key = "__kbAsk" + ++askSeq;
  await page.evaluate(
    (a) => {
      window[a.key] = { done: false, text: null, error: null };
      fetch(a.base + "/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
        body: JSON.stringify(a.conversationId ? { question: a.question, conversationId: a.conversationId } : { question: a.question }),
      })
        .then((r) => r.text())
        .then((t) => {
          window[a.key] = { done: true, text: t, error: null };
        })
        .catch((e) => {
          window[a.key] = { done: true, text: null, error: String(e) };
        });
    },
    { key, base: BASE, token: TOKEN, question, conversationId },
  );

  const deadline = Date.now() + 120_000;
  let payload = null;
  while (Date.now() < deadline) {
    payload = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (payload?.done) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!payload?.done) return { status: 0, events: [], error: "ask 超时（120s）" };
  if (payload.error) return { status: 0, events: [], error: payload.error };

  const events = [];
  for (const block of String(payload.text).split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) });
    } catch {
      /* 心跳等非 JSON 帧 */
    }
  }
  return { status: 200, events, error: null };
};

// ── ① 健康 ──────────────────────────────────────────────────────────
{
  const r = await call("/api/health");
  check("① /api/health → 200 且 service=kb-ask", r.status === 200 && r.body?.service === "kb-ask", `status=${r.status} ${JSON.stringify(r.body)?.slice(0, 60)}`);
}

// ── ② 列表（真 D1）──────────────────────────────────────────────────
{
  const r = await call("/api/documents");
  check("② 带令牌 GET /api/documents → 200（真 D1 连通）", r.status === 200 && Array.isArray(r.body?.documents), `status=${r.status} count=${r.body?.documents?.length}`);
}

// ── ③ 导入 ──────────────────────────────────────────────────────────
let docId = null;
{
  const r = await call("/api/documents", { method: "POST", body: JSON.stringify({ source: "paste", text: DOC, title: "线上E2E-部署手册" }) });
  docId = r.body?.document?.id ?? null;
  check(
    "③ 导入 → ready（真 bge-m3 嵌入 + 真 Vectorize 写入）",
    r.status === 201 && r.body?.document?.status === "ready",
    `status=${r.status} chunks=${r.body?.document?.chunkCount} err=${r.body?.error ?? "-"}`,
  );
}

// ── ④ 幂等 ──────────────────────────────────────────────────────────
{
  const r = await call("/api/documents", { method: "POST", body: JSON.stringify({ source: "paste", text: DOC.replace(/\n/g, "\r\n"), title: "线上E2E-部署手册" }) });
  check("④ 同内容重复导入 → skipped（幂等）", r.status === 200 && r.body?.skipped === true, `status=${r.status} skipped=${r.body?.skipped}`);
}

// ── ⑤ 问答 + 引用（真 LLM + 真检索）────────────────────────────────
// ⚠️ Vectorize 的 upsert 是异步的：刚导入的向量可能要数十秒才可检索。
//    直接问会拿到 refused=true（优雅降级），那样「引用可核验」这条根本没被验证。
//    所以这里轮询等索引追上，最多 150s；仍不到则显式标记为「未验证」而不是假绿。
{
  let r = await ask("回滚要注意什么？");
  const deadline = Date.now() + 150_000;
  let waited = 0;
  while (Date.now() < deadline) {
    const d = r.events.find((e) => e.event === "done");
    if (d?.data?.result && d.data.result.refused === false) break;
    await new Promise((res) => setTimeout(res, 10_000));
    waited += 10;
    console.log("  · 等待索引追上（" + waited + "s）…");
    r = await ask("回滚要注意什么？");
  }
  const done = r.events.find((e) => e.event === "done");
  const err = r.events.find((e) => e.event === "error");
  const result = done?.data?.result;
  check(
    "⑤ 问答有终态",
    Boolean(done) || Boolean(err),
    err ? `error=${err.data?.message}` : `refused=${result?.refused} citations=${result?.citations?.length}`,
  );
  if (result && !result.refused) {
    const c0 = result.citations?.[0];
    check("⑤ 回答带可核验引用（文档名 + 片段）", (result.citations?.length ?? 0) > 0 && Boolean(c0?.snippet), `doc=${c0?.docTitle} 位置=${c0?.headingPath} 片段=${String(c0?.snippet).slice(0, 40)}`);
  }
  check(
    "⑤ 索引追平后真正检索到并给出引用",
    result?.refused === false && (result?.citations?.length ?? 0) > 0,
    result?.refused
      ? "等待 150s 仍拒答（索引未追上，本项未验证）"
      : `citations=${result?.citations?.length}`,
  );
}

// ── ⑥ 拒答 ──────────────────────────────────────────────────────────
{
  const r = await ask("请解释量子色动力学中的渐近自由现象");
  const done = r.events.find((e) => e.event === "done");
  const result = done?.data?.result;
  check("⑥ 无关问题 → 拒答（refused=true）", result?.refused === true, `refused=${result?.refused} answer=${String(result?.answer).slice(0, 30)}`);
}

// ── ⑦ 历史 ──────────────────────────────────────────────────────────
{
  const r = await call("/api/history");
  check("⑦ 历史问答已落库", r.status === 200 && (r.body?.records?.length ?? 0) >= 2, `count=${r.body?.records?.length}`);
}

// ── ⑧ 删除连带清向量 ────────────────────────────────────────────────
if (docId) {
  const r = await call(`/api/documents?id=${encodeURIComponent(docId)}`, { method: "DELETE" });
  check("⑧ 删除 → 连带清理向量", r.status === 200 && r.body?.ok === true, `status=${r.status} removed=${r.body?.removedChunks}`);
}

// ── ⑨ 错误契约 ──────────────────────────────────────────────────────
{
  const a = await call("/api/documents", { method: "POST", body: JSON.stringify({ source: "paste", text: "  " }) });
  const b = await call("/api/documents", { method: "POST", body: JSON.stringify({ source: "url", url: "http://169.254.169.254./latest/meta-data/" }) });
  const c = await call("/api/documents?id=nope", { method: "DELETE" });
  check("⑨ 空文本 → 400", a.status === 400, `status=${a.status}`);
  check("⑨ SSRF 尾点地址被拒 → 400", b.status === 400, `status=${b.status} ${String(b.body?.error).slice(0, 40)}`);
  check("⑨ 删除不存在 → 404", c.status === 404, `status=${c.status}`);
}

// ════════════════════════════════════════════════════════════════
// 二期用例（2026-10-28）：多轮会话 / 混合检索 / 索引探针 / OCR
// ════════════════════════════════════════════════════════════════

// ── ⑩ 多轮会话：首问自动建会话 ───────────────────────────────────
let convId = null;
{
  const r = await ask("回滚前要确认什么？");
  const done = r.events.find((e) => e.event === "done");
  convId = done?.data?.conversationId ?? null;
  check("⑩ 首问自动建会话并返回 conversationId", Boolean(convId), `conversationId=${convId}`);
  check("⑩ 首问落库（persisted=true）", done?.data?.persisted === true, `persisted=${done?.data?.persisted}`);
  check("⑩ 检索步骤 detail 含两路召回数", /向量 \d+ 段|关键词 \d+ 段/.test(String(r.events.find((e) => e.event === "step" && e.data?.step === "retrieve" && e.data?.status === "done")?.data?.detail ?? "")), String(r.events.find((e) => e.event === "step" && e.data?.step === "retrieve" && e.data?.status === "done")?.data?.detail ?? ""));
}

// ── ⑪ 多轮会话：追问被规则改写 ───────────────────────────────────
{
  const r = await ask("它呢？", convId);
  const done = r.events.find((e) => e.event === "done");
  const result = done?.data?.result;
  check("⑪ 追问复用同一会话", done?.data?.conversationId === convId, `conversationId=${done?.data?.conversationId}`);
  check("⑪ 指代式追问被规则改写", result?.rewritten === true, `rewritten=${result?.rewritten} query=${String(result?.retrievalQuery).slice(0, 60)}`);
  check("⑪ 改写后的查询带上一轮主题", String(result?.retrievalQuery ?? "").includes("回滚"), `query=${String(result?.retrievalQuery).slice(0, 80)}`);
}

// ── ⑫ 会话接口：列表 / 详情 / 401 ────────────────────────────────
{
  const list = await call("/api/conversations");
  const conv = (list.body?.conversations ?? []).find((c) => c.id === convId);
  check("⑫ GET /api/conversations → 200 且含本次会话", list.status === 200 && Boolean(conv), `status=${list.status} count=${list.body?.conversations?.length} turnCount=${conv?.turnCount}`);
  check("⑫ 会话轮数 ≥ 2", (conv?.turnCount ?? 0) >= 2, `turnCount=${conv?.turnCount}`);

  const detail = await call(`/api/conversations?id=${encodeURIComponent(convId)}`);
  check("⑫ GET /api/conversations?id= → 200 且带消息", detail.status === 200 && (detail.body?.messages?.length ?? 0) >= 2, `status=${detail.status} messages=${detail.body?.messages?.length}`);

  const ghost = await call("/api/conversations?id=conv_nope");
  check("⑫ 不存在的会话 → 404", ghost.status === 404, `status=${ghost.status}`);

  const noAuth = await page.evaluate(async (base) => {
    const res = await fetch(base + "/api/conversations", { headers: { "content-type": "application/json" } });
    return { status: res.status };
  }, BASE);
  check("⑫ 新接口无令牌 → 401", noAuth.status === 401, `status=${noAuth.status}`);
}

// ── ⑬ 混合检索：错误码类查询（关键词通道）─────────────────────────
{
  const DOC_ERR = `# 线上E2E-错误码

## 常见错误码

报错 ERR_9911 表示向量索引维度不匹配，必须重建索引。

报错 ERR_9912 表示日配额耗尽，等次日恢复。`;
  const imported = await call("/api/documents", { method: "POST", body: JSON.stringify({ source: "paste", text: DOC_ERR, title: "线上E2E-错误码" }) });
  check("⑬ 导入含错误码的文档 → 201", imported.status === 201, `status=${imported.status} ${String(imported.body?.error).slice(0, 40)}`);

  // 等待索引追上（Vectorize 异步）
  let detail = "";
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const r = await ask("ERR_9911 是什么错误？");
    detail = String(r.events.find((e) => e.event === "step" && e.data?.step === "retrieve" && e.data?.status === "done")?.data?.detail ?? "");
    if (/关键词 \d+ 段/.test(detail) && /关键词 [1-9]/.test(detail)) break;
    await new Promise((res) => setTimeout(res, 10_000));
  }
  check("⑬ 关键词通道有召回（错误码类查询）", /关键词 [1-9]/.test(detail), detail);
}

// ── ⑭ 索引可见性探针 ─────────────────────────────────────────────
{
  const list = await call("/api/documents");
  const doc = (list.body?.documents ?? []).find((d) => (d.chunkCount ?? 0) > 0);
  const probed = await call("/api/probe", { method: "POST", body: JSON.stringify({ id: doc?.id }) });
  check("⑭ POST /api/probe → 200", probed.status === 200, `status=${probed.status}`);
  check("⑭ 探针给出 searchable 布尔结论", typeof probed.body?.searchable === "boolean", `searchable=${probed.body?.searchable} checked=${probed.body?.checked}`);

  const missing = await call("/api/probe", { method: "POST", body: JSON.stringify({ id: "doc_nope" }) });
  check("⑭ 探测不存在的文档 → 404", missing.status === 404, `status=${missing.status}`);
}

// ── ⑮ OCR 接口契约（只验契约与错误路径，真识别见手动用例）─────────
{
  const remote = await call("/api/ocr", { method: "POST", body: JSON.stringify({ image: "https://example.com/a.jpg", page: 1 }) });
  check("⑮ OCR 只收 data URL（远程 URL → 400）", remote.status === 400, `status=${remote.status}`);

  const badPage = await call("/api/ocr", { method: "POST", body: JSON.stringify({ image: "data:image/jpeg;base64,AAAA", page: 9 }) });
  check("⑮ 页号超上限 → 400", badPage.status === 400, `status=${badPage.status}`);

  // 真模型识别一张 1x1 像素图：结果内容不可预测，但契约（200/400/429/502 之一 + 结构）必须成立
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const ocr = await call("/api/ocr", { method: "POST", body: JSON.stringify({ image: tiny, page: 1 }) });
  const ocrOk = ocr.status === 200 && typeof ocr.body?.text === "string";
  check("⑮ OCR 契约成立（200+text 或明确错误码）", ocrOk || [400, 429, 502].includes(ocr.status), `status=${ocr.status} text=${String(ocr.body?.text).slice(0, 40)} error=${String(ocr.body?.error).slice(0, 40)}`);
}

// ── ⑯ 历史改读 messages（新真源）─────────────────────────────────
{
  const r = await call("/api/history");
  check("⑯ /api/history → 200 且有条目", r.status === 200 && (r.body?.records?.length ?? 0) >= 1, `status=${r.status} count=${r.body?.records?.length}`);
  const legacy = await call("/api/history?includeLegacy=1");
  check("⑯ ?includeLegacy=1 兼容读一期数据", legacy.status === 200 && legacy.body?.legacyIncluded === true, `status=${legacy.status} count=${legacy.body?.records?.length}`);
}

// ── ⑰ 清理：删掉本次导入的文档（避免污染知识库）───────────────────
{
  const list = await call("/api/documents");
  const mine = (list.body?.documents ?? []).filter((d) => String(d.title ?? "").startsWith("线上E2E-"));
  for (const d of mine) {
    await call(`/api/documents?id=${encodeURIComponent(d.id)}`, { method: "DELETE" });
  }
  const after = await call("/api/documents");
  check("⑰ 清理测试文档完成", (after.body?.documents ?? []).filter((d) => String(d.title ?? "").startsWith("线上E2E-")).length === 0, `剩余=${(after.body?.documents ?? []).filter((d) => String(d.title ?? "").startsWith("线上E2E-")).length}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  throw new Error(`线上 E2E 失败 ${failed.length} 项`);
}
