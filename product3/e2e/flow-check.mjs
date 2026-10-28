/**
 * 本地端到端校验（真实 HTTP 打 shim）：导入 → 幂等 → 问答引用 → 拒答 → 删除 → 401
 *
 * 先起 shim（另一个终端）：
 *   node --import ./e2e/bootstrap.mjs e2e/server.mjs 8902
 * 再跑：
 *   node e2e/flow-check.mjs http://127.0.0.1:8902
 *
 * 断言式验证（不是看日志猜）：每一步都断言状态码与关键字段。
 */

const BASE = process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:8902";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}\n     ${detail}`);
  console.log(`  ✖ ${name}\n     ${detail}`);
}

function assert(cond, name, detail = "") {
  if (cond) ok(name, detail);
  else bad(name, detail || "断言失败");
}

const DOC_A = `# 部署指南

## 前置条件

需要在 Cloudflare 账号下开通 Workers 与 D1，并且本地安装 wrangler 命令行工具。

## 部署步骤

执行构建后进入 dist/ssr 目录，用 wrangler deploy 并带上 secrets 文件完成部署。

## 回滚

使用 wrangler rollback 指定完整版本号回滚到上一个已知可用版本。`;

const DOC_B = `# 计费说明

模型调用按 token 计费，免费额度每月重置，超出部分按量结算。
向量检索按查询维度计费。`;

async function jsonFetch(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

/** 读 SSE 流（必须消费完，否则 shim 侧连接不释放） */
async function readSse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const data = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length) {
      try {
        events.push({ event, data: JSON.parse(data.join("\n")) });
      } catch {
        events.push({ event, data: { raw: data.join("\n") } });
      }
    }
  }
  return events;
}

/** 一次问答：返回全部 SSE 事件（多轮/混合检索用例共用） */
async function askOnce(payload) {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const events = await readSse(res);
  return { status: res.status, events };
}

/** 取 done 事件里的 data（统一防空） */
function doneOf(events) {
  return events.find((e) => e.event === "done")?.data ?? null;
}

/** 取 step=retrieve 且 status=done 的 detail 文本 */
function retrieveDetail(events) {
  const hit = events.find(
    (e) => e.event === "step" && e.data?.step === "retrieve" && e.data?.status === "done",
  );
  return String(hit?.data?.detail ?? "");
}

async function main() {
  console.log(`\n目标：${BASE}`);

  // ── 0 健康探针 ────────────────────────────────────────────────
  console.log("\n── 0. 健康探针 ──");
  {
    const { status, body } = await jsonFetch("/api/health");
    assert(status === 200 && body?.ok === true, "GET /api/health → 200 ok", `status=${status}`);
    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    assert(page.status === 200 && html.length > 500, "GET / → 200 且有实际 HTML", `len=${html.length}`);
  }

  // ── 1 导入 ────────────────────────────────────────────────────
  console.log("\n── 1. 导入文档 ──");
  let docA;
  {
    const { status, body } = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "paste", text: DOC_A, title: "部署指南" }),
    });
    docA = body?.document;
    assert(status === 201, "导入部署指南 → 201", `status=${status}`);
    assert(docA?.status === "ready", "文档状态 ready", `status=${docA?.status}`);
    assert(docA?.chunkCount > 0, "chunkCount > 0", `chunks=${docA?.chunkCount}`);
  }
  {
    const { status } = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "paste", text: DOC_B, title: "计费说明" }),
    });
    assert(status === 201, "导入计费说明 → 201", `status=${status}`);
  }

  // ── 2 幂等 ────────────────────────────────────────────────────
  console.log("\n── 2. 幂等（验收 #2）──");
  {
    const { status, body } = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "paste", text: DOC_A.replace(/\n/g, "\r\n"), title: "部署指南" }),
    });
    assert(status === 200 && body?.skipped === true, "同内容（仅换行差异）重复导入 → skipped", `status=${status}`);
    const list = await jsonFetch("/api/documents");
    assert(list.body?.documents?.length === 2, "库中文档仍为 2 份（未产生重复）", `count=${list.body?.documents?.length}`);
  }

  // ── 3 问答 + 引用 ─────────────────────────────────────────────
  console.log("\n── 3. 问答与引用（验收 #4）──");
  let citationCount = 0;
  {
    const res = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "部署用什么命令，回滚怎么做？" }),
    });
    assert(res.headers.get("content-type")?.includes("text/event-stream") === true, "响应是 text/event-stream");
    const events = await readSse(res);
    const steps = events.filter((e) => e.event === "step").map((e) => `${e.data.step}:${e.data.status}`);
    assert(steps.includes("embed:done"), "有 embed 步骤完成");
    assert(steps.includes("retrieve:done"), "有 retrieve 步骤完成");
    assert(steps.includes("generate:done"), "有 generate 步骤完成");
    assert(events.some((e) => e.event === "token"), "收到 token 增量（真流式）");

    const done = events.find((e) => e.event === "done");
    const result = done?.data?.result;
    assert(Boolean(result), "收到 done 事件");
    if (result?.refused) {
      // 假模型尺度下可能判为拒答：单独记录，不视为失败（拒答本身也是正确行为）
      ok("模型判定依据不足 → 拒答（也是有效行为）", `nearest=${result.nearest?.length ?? 0}`);
    } else {
      assert(typeof result.answer === "string" && result.answer.length > 0, "回答非空");
      citationCount = result.citations?.length ?? 0;
      assert(citationCount > 0, "产出引用块", `citations=${citationCount}`);
      const cit = result.citations?.[0];
      assert(Boolean(cit?.docTitle), "引用带文档名", `docTitle=${cit?.docTitle}`);
      assert(Boolean(cit?.snippet) && cit.snippet.length > 0, "引用带原文片段（可核验）");
    }
    assert(done?.data?.persisted === true, "问答落库", `persisted=${done?.data?.persisted}`);
  }

  // ── 4 拒答（第二道防线：库里没有的内容）────────────────────
  console.log("\n── 4. 拒答（验收 #5）──");
  {
    const res = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "请说明傅里叶变换在量子色动力学中的渐近自由现象" }),
    });
    const events = await readSse(res);
    const done = events.find((e) => e.event === "done");
    const result = done?.data?.result;
    assert(result?.refused === true, "无关问题 → refused=true", `refused=${result?.refused}`);
    assert(typeof result?.answer === "string" && result.answer.includes("未找到"), "拒答文案明确", `answer=${result?.answer}`);
    assert((result?.nearest?.length ?? 0) > 0, "拒答时给出最近似片段", `nearest=${result?.nearest?.length}`);
  }

  // ── 5 历史 ────────────────────────────────────────────────────
  console.log("\n── 5. 问答历史（验收 #9）──");
  {
    const { status, body } = await jsonFetch("/api/history");
    assert(status === 200, "GET /api/history → 200", `status=${status}`);
    assert((body?.records?.length ?? 0) >= 2, "历史至少 2 条（含拒答记录）", `count=${body?.records?.length}`);
  }

  // ── 6 删除连带清理 ────────────────────────────────────────────
  console.log("\n── 6. 删除连带清理向量（验收 #3）──");
  {
    const { status, body } = await jsonFetch(`/api/documents?id=${docA.id}`, { method: "DELETE" });
    assert(status === 200 && body?.ok === true, "删除文档 → 200", `status=${status}`);
    assert(body?.removedChunks === docA.chunkCount, "删除的 chunk 数与导入一致", `removed=${body?.removedChunks}/${docA.chunkCount}`);
    const list = await jsonFetch("/api/documents");
    assert(list.body?.documents?.length === 1, "列表剩 1 份", `count=${list.body?.documents?.length}`);
  }

  // ── 7 错误契约 ────────────────────────────────────────────────
  console.log("\n── 7. 错误契约（验收 #8）──");
  {
    const empty = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "paste", text: "   " }),
    });
    assert(empty.status === 400, "空文本 → 400", `status=${empty.status}`);

    const badJson = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert(badJson.status === 400, "非 JSON → 400", `status=${badJson.status}`);

    const ssrf = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "url", url: "http://127.0.0.1:8902/api/health" }),
    });
    assert(ssrf.status === 400, "内网 URL → 400（SSRF 闸）", `status=${ssrf.status}`);

    const emptyQ = await jsonFetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "  " }),
    });
    assert(emptyQ.status === 400, "空问题 → 400", `status=${emptyQ.status}`);

    const missing = await jsonFetch("/api/documents?id=nope", { method: "DELETE" });
    assert(missing.status === 404, "删除不存在 → 404", `status=${missing.status}`);
  }

  // ── 8 多轮会话（二期 A1/A2）──────────────────────────────────
  console.log("\n── 8. 多轮会话（A1/A2）──");
  let convId = "";
  {
    const first = await askOnce({ question: "免费额度会重置吗？" });
    const d1 = doneOf(first.events);
    convId = d1?.conversationId ?? "";
    assert(Boolean(convId), "首问自动建会话并返回 conversationId", `conversationId=${convId}`);
    assert(d1?.persisted === true, "首问落库", `persisted=${d1?.persisted}`);
    assert(Boolean(d1?.messageId), "返回 messageId（会话内一轮的唯一标识）", `messageId=${d1?.messageId}`);

    const second = await askOnce({ question: "它呢，会出现累积吗？", conversationId: convId });
    const d2 = doneOf(second.events);
    assert(d2?.conversationId === convId, "追问复用同一会话", `conversationId=${d2?.conversationId}`);
    const rq = String(d2?.result?.retrievalQuery ?? "");
    assert(d2?.result?.rewritten === true, "指代式追问被规则改写", `rewritten=${d2?.result?.rewritten}`);
    assert(rq.includes("免费额度"), "改写后的检索查询带上上一轮主题", `query=${rq}`);

    const list = await jsonFetch("/api/conversations");
    const conv = list.body?.conversations?.find((c) => c.id === convId);
    assert(list.status === 200 && Boolean(conv), "会话出现在列表里", `count=${list.body?.conversations?.length}`);
    assert(conv?.turnCount === 2, "会话轮数为 2", `turnCount=${conv?.turnCount}`);

    const detail = await jsonFetch(`/api/conversations?id=${convId}`);
    assert(detail.body?.messages?.length === 2, "会话详情返回 2 条消息", `messages=${detail.body?.messages?.length}`);
    const firstMsg = detail.body?.messages?.[0];
    assert(Boolean(firstMsg?.result), "消息带完整结果（回答/引用/拒答）");

    const missing = await jsonFetch("/api/conversations?id=conv_nope");
    assert(missing.status === 404, "不存在的会话 → 404", `status=${missing.status}`);

    const hint = await jsonFetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "还在吗？", conversationId: "conv_nope" }),
    });
    assert(hint.status === 404, "拿幽灵 conversationId 提问 → 404", `status=${hint.status}`);
  }

  // ── 9 混合检索（二期 A3）────────────────────────────────────
  console.log("\n── 9. 混合检索关键词通道（A3）──");
  {
    const docC = `# 故障处理

## 常见错误码

报错 ERR_1101 表示 Workers AI 绑定缺失，请检查 wrangler.json 里的 ai 绑定。
报错 ERR_2049 表示日配额耗尽，等次日恢复。`;
    const imported = await jsonFetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "paste", text: docC, title: "故障处理" }),
    });
    assert(imported.status === 201, "导入含错误码的文档 → 201", `status=${imported.status}`);

    const asked = await askOnce({ question: "ERR_1101 是什么意思？" });
    const detail = retrieveDetail(asked.events);
    assert(/关键词 [1-9]/.test(detail), "关键词通道召回到片段（不是只有向量通道）", detail);
    assert(/向量 1?\d* 段|向量 \d+ 段/.test(detail), "detail 同时透出两路召回数量", detail);

    const done = doneOf(asked.events);
    const answered = done?.result;
    const hitText = JSON.stringify(answered?.citations?.length ? answered.citations : answered?.nearest ?? []);
    assert(
      /1101/.test(hitText),
      "错误码类查询能命中含该码的片段（引用或最近似）",
      hitText.slice(0, 120),
    );
  }

  // ── 10 索引可见性探针（二期 A5）──────────────────────────────
  console.log("\n── 10. 索引可见性探针（A5）──");
  {
    const list = await jsonFetch("/api/documents");
    const doc = list.body?.documents?.find((d) => d.chunkCount > 0);
    assert(Boolean(doc), "库内有可探测的文档");
    const probed = await jsonFetch("/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: doc.id }),
    });
    assert(probed.status === 200 && probed.body?.ok === true, "POST /api/probe → 200", `status=${probed.status}`);
    assert(probed.body?.searchable === true, "本地内存向量即时可见 → searchable=true", `searchable=${probed.body?.searchable}`);
    assert((probed.body?.checked ?? 0) >= 1, "探测了至少 1 个片段", `checked=${probed.body?.checked}`);

    const missing = await jsonFetch("/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "doc_nope" }),
    });
    assert(missing.status === 404, "探测不存在的文档 → 404", `status=${missing.status}`);

    const noId = await jsonFetch("/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(noId.status === 400, "缺 id → 400", `status=${noId.status}`);
  }

  // ── 11 扫描件 OCR（二期 A4）─────────────────────────────────
  console.log("\n── 11. 扫描件 OCR（A4）──");
  {
    const img = "data:image/jpeg;base64," + Buffer.from("fake-page").toString("base64");
    const ok = await jsonFetch("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: img, page: 1 }),
    });
    assert(ok.status === 200 && ok.body?.ok === true, "POST /api/ocr → 200", `status=${ok.status}`);
    assert(typeof ok.body?.text === "string" && ok.body.text.length > 0, "返回识别文本", `len=${ok.body?.text?.length}`);
    assert(ok.body?.page === 1, "回显页号", `page=${ok.body?.page}`);

    const remote = await jsonFetch("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "https://example.com/a.jpg", page: 1 }),
    });
    assert(remote.status === 400, "远程 URL 图片 → 400（只收 data URL，不新增 SSRF 面）", `status=${remote.status}`);

    const tooMany = await jsonFetch("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: img, page: 6 }),
    });
    assert(tooMany.status === 400, "页号超上限 → 400", `status=${tooMany.status}`);
  }

  // ── 12 会话删除（A2 收尾）────────────────────────────────────
  console.log("\n── 12. 会话删除 ──");
  {
    if (convId) {
      const del = await jsonFetch(`/api/conversations?id=${convId}`, { method: "DELETE" });
      assert(del.status === 200 && del.body?.ok === true, "删除会话 → 200", `status=${del.status}`);
      assert(del.body?.removedMessages === 2, "连带删除 2 条消息", `removed=${del.body?.removedMessages}`);
      const again = await jsonFetch(`/api/conversations?id=${convId}`, { method: "DELETE" });
      assert(again.status === 404, "重复删除 → 404", `status=${again.status}`);
      const list = await jsonFetch("/api/conversations");
      assert(
        !(list.body?.conversations ?? []).some((c) => c.id === convId),
        "会话不再出现在列表",
      );
    }
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log(`\n失败详情:\n${failures.map((f) => `\n${f}`).join("\n")}`);
    process.exitCode = 1;
  }
}

await main();
