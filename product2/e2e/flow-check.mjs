/**
 * 本地端到端自测（不依赖浏览器）：真实 HTTP → shim → 真实 magpie 流式 → 真 SQLite 历史。
 *
 * 覆盖验收标准：
 *   1 步骤进度 + token 流式 + 笔记结构
 *   3 粘贴文本路径
 *   5 超长素材自动压缩
 *   6 历史列表倒序 / 回看全文
 *   7 从历史重新生成（新记录，旧记录保留）
 *   8 各字段可复制（由前端负责，此处校验字段齐全）
 *   9 未配置上游的错误文案（另用无 env 实例验证）
 *  10 令牌校验
 *  12 空输入（前端禁用，后端 400 兜底）
 *
 * 用法：
 *   node --import ./e2e/bootstrap.mjs e2e/server.mjs 8901     # 另一个终端
 *   node e2e/flow-check.mjs [baseUrl] [token]
 */

const base = process.argv[2] || "http://127.0.0.1:8901";
const token = process.argv[3] || process.env.ACCESS_TOKEN || "";

const results = [];
function check(name, pass, extra = "") {
  results.push({ name, pass, extra });
  console.log(`  ${pass ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
}

const auth = token ? { authorization: `Bearer ${token}` } : {};

/** 读 SSE，记录每个事件的到达时间与内容 */
async function streamGenerate(body, onEvent) {
  const t0 = Date.now();
  const resp = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await resp.text();
    return { ok: false, status: resp.status, contentType, body: text, events: [], timeline: [] };
  }

  const events = [];
  const timeline = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstTokenMs = null;
  let acc = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines = [];
      for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const data = JSON.parse(dataLines.join("\n"));
      events.push({ event, data });
      timeline.push({ event, ms: Date.now() - t0, data });
      if (event === "token") {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        acc += data.text;
      }
      onEvent?.(event, data);
    }
  }
  return { ok: true, status: resp.status, contentType, events, timeline, totalMs: Date.now() - t0, firstTokenMs, raw: acc };
}

const MATERIAL = `产品复盘：我们把一个内部工具重写了三次。

第一次失败：需求没对齐，做了没人用的功能。三个月后下线。
第二次失败：技术选型追新，引入了两个不成熟依赖，线上三天两头挂。
第三次成功：先花两周访谈了 12 个真实用户，只做三个高频动作，四个月日活翻了三倍。

复盘结论：需求对齐花的时间永远不亏；工具选型优先选已验证的；上线节奏按周迭代而不是按月。`;

console.log(`\n=== 0. 健康检查（${base}）===`);
try {
  const h = await fetch(`${base}/api/health`, { headers: auth });
  check("shim 可访问", h.status < 500, `status=${h.status}`);
} catch (e) {
  console.log(`无法连接 ${base}：${e.message}`);
  process.exit(2);
}

console.log("\n=== 1. 粘贴文本 → 流式生成（验收 1/3/8）===");
const g1 = await streamGenerate({ sourceType: "text", text: MATERIAL });
if (!g1.ok) {
  check("生成流可用", false, `status=${g1.status} ${String(g1.body).slice(0, 200)}`);
  process.exit(1);
}
const stepEvents = g1.events.filter((e) => e.event === "step");
const tokenEvents = g1.events.filter((e) => e.event === "token");
const done1 = g1.events.find((e) => e.event === "done");
const err1 = g1.events.find((e) => e.event === "error");

check("收到 step 进度事件", stepEvents.length >= 2, `${stepEvents.length} 个`);
check("收到 token 增量（≥5 个）", tokenEvents.length >= 5, `${tokenEvents.length} 个`);
check("token 是增量到达而非一次性", g1.firstTokenMs !== null && g1.totalMs - g1.firstTokenMs > 200,
  `首token ${g1.firstTokenMs}ms / 总 ${g1.totalMs}ms`);
check("收到 done", done1 !== undefined, err1 ? `error=${JSON.stringify(err1.data)}` : "");

if (done1) {
  const job = done1.data.job;
  check("已落库（persisted）", done1.data.persisted === true);
  check("主标题存在（≤20 字左右）", typeof job.note.titles[0] === "string" && job.note.titles[0].length > 0, job.note.titles[0]);
  check("备选标题 ≥2", job.note.titles.length >= 3, `${job.note.titles.length} 个标题`);
  check("正文 300–600 字（±15% 容差：255–690）", job.note.body.length >= 255 && job.note.body.length <= 690, `${job.note.body.length} 字`);
  check("含 emoji 装饰", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(job.note.body));
  check("标签 3–6 个", job.note.tags.length >= 3 && job.note.tags.length <= 6, job.note.tags.join(","));
  check("标签无 # 前缀（前端统一加）", job.note.tags.every((t) => !t.startsWith("#")));
  check("正文不含结构标记残留", !/^\s*\[(标题|正文|标签|备选标题)\]/m.test(job.note.body));

  const timeline = g1.timeline.map((t) => `${t.event}${t.event === "step" ? `:${t.data.step}/${t.data.status}` : ""}@${t.ms}ms`);
  console.log(`     时间线: ${timeline.join(" → ")}`);

  console.log("\n=== 6. 历史记录（列表 / 详情 / 删除）===");
  const listResp = await fetch(`${base}/api/jobs`, { headers: auth });
  const list = await listResp.json();
  check("列表 200", listResp.status === 200);
  check("列表含刚生成的记录", (list.jobs ?? []).some((j) => j.id === job.id), `${(list.jobs ?? []).length} 条`);
  check("列表不含原文（省流量）", list.jobs?.[0] && !("sourceText" in list.jobs[0]));

  const detailResp = await fetch(`${base}/api/jobs?id=${job.id}`, { headers: auth });
  const detail = await detailResp.json();
  check("详情含原文与要点字段", typeof detail.job?.sourceText === "string" && detail.job.sourceText.length > 0);

  console.log("\n=== 7. 从历史重新生成（新记录 + 保留旧记录）===");
  const g2 = await streamGenerate({ sourceType: "text", text: detail.job.sourceText, variation: true });
  const done2 = g2.events.find((e) => e.event === "done");
  check("重新生成成功", done2 !== undefined);
  if (done2) {
    check("产生新记录 id", done2.data.job.id !== job.id, `${job.id.slice(0, 8)} → ${done2.data.job.id.slice(0, 8)}`);
    const list2 = await (await fetch(`${base}/api/jobs`, { headers: auth })).json();
    check("旧记录仍保留", (list2.jobs ?? []).some((j) => j.id === job.id));
    check("列表按时间倒序", list2.jobs[0].createdAt >= list2.jobs[list2.jobs.length - 1].createdAt);
    check("两版内容不同（variation 生效）", done2.data.job.note.body !== job.note.body);
  }

  console.log("\n=== 历史删除 ===");
  const delResp = await fetch(`${base}/api/jobs?id=${job.id}`, { method: "DELETE", headers: auth });
  check("删除返回 200", delResp.status === 200);
  const list3 = await (await fetch(`${base}/api/jobs`, { headers: auth })).json();
  check("删除后列表不含该记录", !(list3.jobs ?? []).some((j) => j.id === job.id));
}

console.log("\n=== 4. 抓取失败 URL → 明确报错 + 引导（验收 4）===");
const g4 = await streamGenerate({ sourceType: "url", url: "https://example.com/definitely-404-page-xyz" });
const err4 = g4.events.find((e) => e.event === "error");
check("收到 error 事件（非崩溃）", err4 !== undefined);
check("错误文案可读且非堆栈", err4 && !/\bat \w+ \(/.test(err4.data.message), err4?.data.message);
check("附引导提示（切粘贴模式）", Boolean(err4?.data.hint?.includes("粘贴")), err4?.data.hint ?? "");

console.log("\n=== 12. 空输入兜底 → 400（验收 12）===");
const empty = await fetch(`${base}/api/generate`, {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ sourceType: "text", text: "   " }),
});
check("空文本被拒（400）", empty.status === 400, `status=${empty.status}`);

console.log("\n=== 10. 令牌校验（验收 10）===");
const noTok = await fetch(`${base}/api/jobs`);
check("无令牌访问历史 → 401", noTok.status === 401, `status=${noTok.status}`);

console.log("\n=== 5. 超长素材自动压缩（验收 5）===");
const longText = `${MATERIAL}\n\n${MATERIAL}\n\n${MATERIAL}`.repeat(14); // ≈ 7000+ 字，超过 COMPRESS_THRESHOLD(6000)
console.log(`     素材长度 ${longText.length} 字`);
const g5 = await streamGenerate({ sourceType: "text", text: longText });
const prep = g5.events.filter((e) => e.event === "step" && e.data.step === "prepare");
const done5 = g5.events.find((e) => e.event === "done");
const err5 = g5.events.find((e) => e.event === "error");
check("准备阶段有压缩动作", prep.some((p) => p.data.status === "started"), prep.map((p) => p.data.status).join(","));
check("压缩完成", prep.some((p) => p.data.status === "done"), prep.find((p) => p.data.status === "done")?.data.detail ?? "");
check("长文仍生成成功", done5 !== undefined, err5 ? JSON.stringify(err5.data) : "");
if (done5) check("长文笔记结构完整", done5.data.job.note.body.length > 100);

console.log("\n=== 汇总 ===");
const failed = results.filter((r) => !r.pass);
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("\n失败项:");
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.extra}`);
  process.exit(1);
}
console.log("\nFLOW-CHECK PASS");
