/**
 * 假 magpie 上游（OpenAI 兼容 /chat/completions 流式）。
 *
 * 本地 E2E 用它替代真实模型：验证「SSE 透传 + 引用标记解析 + 依据不足转拒答」，
 * 不验证模型质量（那需要真实模型 + 评测集）。
 *
 * 行为：读 system prompt 判断是否 grounded 请求；从 user prompt 里取第一个片段编号，
 * 回答里带上 [1] 以便验证引用链路。
 *
 * 环境变量：
 *   LLM_MODE=answer|insufficient|empty   控制回答形态（默认 answer）
 */

import { createServer } from "node:http";

const port = Number(process.argv[2] || 0) || Number(process.env.LLM_PORT || 3499);
const mode = process.env.LLM_MODE || "answer";
/** 每片之间的延迟（ms）：本地冒烟测「取消」需要一个可观察的窗口 */
const chunkDelay = Number(process.env.LLM_CHUNK_DELAY_MS ?? 5);

/** 简易分词（与 e2e/ai-shim.mjs 同口径），用于判断问题与上下文是否有实质重叠 */
function tokenize(text) {
  const norm = String(text).toLowerCase();
  const out = new Set();
  for (const m of norm.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  for (const seg of norm.matchAll(/[一-鿿]+/g)) {
    const s = seg[0];
    if (s.length === 1) out.add(s);
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  }
  return out;
}

function answerFor(body) {
  if (mode === "insufficient") return "INSUFFICIENT_EVIDENCE";
  if (mode === "empty") return "";
  const user = (body.messages ?? []).find((m) => m.role === "user")?.content ?? "";
  // 从上下文中取编号，确保引用能命中真实片段
  const m = /\[\[(\d+)\]\]/.exec(user);
  const idx = m ? m[1] : "1";

  // 模拟「遵守 grounded 约束的模型」：问题与片段几乎无词面重叠时，如实说依据不足。
  // 这一步很关键 —— 否则本地 E2E 里拒答路径永远被「模型硬答」掩盖（假绿）。
  const qPart = user.split("问题：").pop() ?? "";
  const ctxPart = user.split("问题：")[0];
  const qTok = tokenize(qPart);
  const cTok = tokenize(ctxPart);
  let overlap = 0;
  for (const t of qTok) if (cTok.has(t)) overlap++;
  const ratio = qTok.size ? overlap / qTok.size : 0;
  // 判据标定（实测词袋重叠）：
  //   「回滚要注意什么？」→ ratio 0.17 / overlap 1  → 有依据
  //   「量子色动力学的渐近自由」→ ratio 0.00 / overlap 0 → 依据不足
  // 这是**测试替身**的行为模拟，不是产品质量指标；真实模型由 eval/ 对真环境标定。
  if (ratio < 0.15 || overlap < 1) return "INSUFFICIENT_EVIDENCE";

  return `根据知识库内容，部署使用 wrangler deploy，回滚使用 wrangler rollback。[${idx}]`;
}

const server = createServer(async (req, res) => {
  if (!req.url?.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400).end("bad json");
    return;
  }

  const answer = answerFor(body);
  const stream = body.stream === true;

  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fake",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      }),
    );
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // 逐字符切片回流，模拟真实增量（也验证前端拼接）
  for (let i = 0; i < answer.length; i += 5) {
    const piece = answer.slice(i, i + 5);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    if (chunkDelay > 0) await new Promise((r) => setTimeout(r, chunkDelay));
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(port, () => {
  console.log(`[fake-llm] ready on http://127.0.0.1:${server.address().port}/v1  mode=${mode} chunkDelay=${chunkDelay}ms`);
});
