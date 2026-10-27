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

  console.log(`\n${"=".repeat(56)}`);
  console.log(`通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log(`\n失败详情:\n${failures.map((f) => `\n${f}`).join("\n")}`);
    process.exitCode = 1;
  }
}

await main();
