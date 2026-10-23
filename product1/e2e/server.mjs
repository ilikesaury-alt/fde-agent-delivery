/**
 * E2E dev shim：在纯 Node 里跑 vite build 的 SSR worker bundle（绕开 workerd）。
 * 用法：
 *   MAGPIE_BASE_URL=... MAGPIE_API_KEY=... MAGPIE_MODEL=... \
 *   node --import ./e2e/bootstrap.mjs e2e/server.mjs [port]
 * 静态资源走 dist/client，其余全部交给 worker fetch（SSR + API）。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const port = Number(process.argv[2] || 8899);

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
};

const { default: WorkerClass } = await import(
  pathToFileURL(join(root, "dist", "ssr", "index.js")).href
);

const workerEnv = {
  MAGPIE_BASE_URL: process.env.MAGPIE_BASE_URL,
  MAGPIE_API_KEY: process.env.MAGPIE_API_KEY,
  MAGPIE_MODEL: process.env.MAGPIE_MODEL,
  ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN || "",
  // Cloudflare Assets 绑定的替身：worker 用它读 .vite/manifest.json 以注入客户端脚本
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
};

function makeCtx() {
  return { waitUntil() {}, passThroughOnException() {} };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    // 1) 静态资源：/assets/* 从 dist/client 读取
    if (url.pathname.startsWith("/assets/")) {
      const rel = normalize(url.pathname).replace(/^([/\\]|\\.)+/, "");
      const abs = join(clientDir, rel);
      if (!abs.startsWith(clientDir)) throw new Error("path traversal");
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(data);
      return;
    }

    // 2) 其余交给 worker（SSR 页面 + /api/*）
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
    const out = Buffer.from(await response.arrayBuffer());
    const outHeaders = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(response.status, outHeaders);
    res.end(out);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`e2e shim error: ${e?.message ?? e}`);
  }
});

server.listen(port, () => {
  console.log(`[e2e-shim] listening on http://localhost:${port}`);
  console.log(`[e2e-shim] MAGPIE_MODEL=${workerEnv.MAGPIE_MODEL} BASE=${workerEnv.MAGPIE_BASE_URL}`);
});
