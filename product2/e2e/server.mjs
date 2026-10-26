/**
 * 本地 dev/E2E shim：在纯 Node 里跑 vite build 的 SSR worker bundle（绕开 workerd）。
 *
 * ⚠️ 与产品① shim 的关键差异：**必须流式转发响应体**。
 * 产品① 的 shim 用 `await response.arrayBuffer()` 缓冲整包，SSE 会变成「全部结束时一次性到达」，
 * 那样即使流式实现是对的，本地也验证不出来（假绿）。这里按 chunk 泵送。
 *
 * 用法：
 *   node --import ./e2e/bootstrap.mjs e2e/server.mjs [port]
 * 环境变量：MAGPIE_BASE_URL / MAGPIE_API_KEY / MAGPIE_MODEL / ACCESS_TOKEN
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const port = Number(process.argv[2] || 8901);

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

const workerEnv = {
  MAGPIE_BASE_URL: process.env.MAGPIE_BASE_URL,
  MAGPIE_API_KEY: process.env.MAGPIE_API_KEY,
  MAGPIE_MODEL: process.env.MAGPIE_MODEL || "deepseek-chat",
  ACCESS_TOKEN: process.env.ACCESS_TOKEN || undefined,
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
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        // 不等待 drain：SSE 帧很小，能立即推动客户端可见
      }
      res.end();
    };
    await pump();
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`e2e shim error: ${e?.message ?? e}`);
  }
});

server.listen(port, () => {
  console.log(`[e2e-shim] listening on http://localhost:${port}`);
  console.log(`[e2e-shim] MAGPIE_MODEL=${workerEnv.MAGPIE_MODEL}`);
});
