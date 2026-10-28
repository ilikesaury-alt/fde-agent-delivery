/**
 * 本地 dev/E2E shim：在纯 Node 里跑 vite build 的 SSR worker bundle（绕开 workerd）。
 *
 * 与产品② shim 的关键相同点：**必须流式转发响应体**。
 * 用 `await response.arrayBuffer()` 缓冲整包会让 SSE 变成「全部结束时一次性到达」，
 * 那样即使流式实现是对的，本地也验证不出来（假绿）。这里按 chunk 泵送。
 *
 * 与产品② 的差异（产品③ 多两个绑定）：
 *   VEC ← e2e/vec-shim.mjs   （内存余弦，精确复刻近邻检索）
 *   AI  ← e2e/ai-shim.mjs    （确定性词袋嵌入，可注入失败）
 *
 * 用法：
 *   node --import ./e2e/bootstrap.mjs e2e/server.mjs [port]
 * 环境变量：MAGPIE_BASE_URL / MAGPIE_API_KEY / MAGPIE_MODEL / ACCESS_TOKEN
 *           RETRIEVE_TOP_K / RETRIEVE_MIN_SCORE / HYBRID_ENABLED / CONTEXT_REWRITE
 *           OCR_MODEL / AI_FAIL / OCR_FAIL / OCR_TEXT / SQLITE_PATH
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const port = Number(process.argv[2] || 0) || Number(process.env.PORT || 8902);

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".map": "application/json",
};

const { default: WorkerClass } = await import(
  pathToFileURL(join(root, "dist", "ssr", "index.js")).href
);

const { createD1Shim } = await import(new URL("../e2e/d1-shim.mjs", import.meta.url).href);
const { createVectorizeShim } = await import(new URL("../e2e/vec-shim.mjs", import.meta.url).href);
const { createAIshim } = await import(new URL("../e2e/ai-shim.mjs", import.meta.url).href);

const workerEnv = {
  MAGPIE_BASE_URL: process.env.MAGPIE_BASE_URL,
  MAGPIE_API_KEY: process.env.MAGPIE_API_KEY,
  MAGPIE_MODEL: process.env.MAGPIE_MODEL || "deepseek-chat",
  ACCESS_TOKEN: process.env.ACCESS_TOKEN || undefined,
  RETRIEVE_TOP_K: process.env.RETRIEVE_TOP_K,
  RETRIEVE_MIN_SCORE: process.env.RETRIEVE_MIN_SCORE,
  // 二期开关（消融对比 / OCR 模型切换）
  HYBRID_ENABLED: process.env.HYBRID_ENABLED,
  CONTEXT_REWRITE: process.env.CONTEXT_REWRITE,
  OCR_MODEL: process.env.OCR_MODEL,
  // Cloudflare Assets 绑定替身
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      const rel = normalize(u.pathname).replace(/^([/\\]|\\.)+/, "");
      const abs = join(clientDir, rel);
      if (!abs.startsWith(clientDir)) return new Response("forbidden", { status: 403 });
      try {
        const data = await readFile(abs);
        return new Response(data, {
          headers: { "content-type": MIME[extname(abs)] ?? "application/octet-stream" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  },
  // D1 替身：node:sqlite，跑真实 migration + 真实 SQL（进程内持久，重启即清空）
  DB: createD1Shim(process.env.SQLITE_PATH || ":memory:"),
  // Vectorize 替身：内存余弦
  VEC: createVectorizeShim(),
  // Workers AI 替身：确定性词袋嵌入
  AI: createAIshim(),
};

function makeCtx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith("/assets/")) {
      const rel = normalize(url.pathname).replace(/^([/\\]|\\.)+/, "");
      const abs = join(clientDir, rel);
      if (!abs.startsWith(clientDir)) throw new Error("path traversal");
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(data);
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    }
    const request = new Request(url.href, {
      method: req.method,
      headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });

    const worker = new WorkerClass(workerEnv, makeCtx());
    const response = await worker.fetch(request);

    // 响应头：逐项透传（SSE 的 no-cache / keep-alive 才能生效）
    const outHeaders = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(response.status, outHeaders);

    if (!response.body) {
      res.end();
      return;
    }

    // 流式泵送：每个 chunk 立即 flush，不缓冲整包
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`shim error: ${e instanceof Error ? e.message : String(e)}`);
  }
});

server.listen(port, () => {
  const actual = server.address().port;
  console.log(`[shim] ready on http://127.0.0.1:${actual}`);
  console.log(`[shim] VEC=memory-cosine  AI=fake-bge-m3  DB=node:sqlite(${process.env.SQLITE_PATH || ":memory:"})`);
});
