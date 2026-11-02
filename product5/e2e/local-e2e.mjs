/**
 * 本地端到端（E2E）：**真实 build 产物 + 真实 HTTP + 真实路由/SSR**，只把上游换成夹具
 *
 * 为什么这么做：本沙箱出网是白名单（workers.dev / feed 站点都不可达），
 * workerd 也起不来（AGENTS.md 记录的环境约束）。所以按仓库既有做法（product1/e2e/server.mjs）
 * 用 Node shim 加载 `dist/ssr/index.js` 这个**真正要部署的产物**，用真实 HTTP 打进去。
 *
 * 覆盖的验收标准：
 *   A1 抓取解析闭环（用**真实 HN feed**，含 CDATA/HTML 描述/dc:creator/guid 等真实怪癖）
 *   A2 跨源去重（夹具里刻意放一条与 HN 同链接的 Atom 条目）
 *   A5 首页 SSR 可渲染（1101 类问题的本地探测器）
 *   A6 失败隔离（不可达源分类记录，整体仍 200）
 *
 * 未覆盖：真环境出网（M0，见 docs/deploy-ai-hot-radar.md §3，需人工执行）
 *
 * 用法：
 *   npm run build && node --import ./e2e/bootstrap.mjs e2e/local-e2e.mjs
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const clientDir = join(root, "dist", "client");
const PORT = Number(process.env.E2E_PORT ?? 8901);
const BASE = `http://127.0.0.1:${PORT}`;

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/* ── 1) 上游替身：按 host 返回真实夹具 / 故意失败 ── */
const fixtures = {
  "hnrss.org": {
    body: await readFile(join(root, "e2e", "fixtures", "hn-frontpage.xml"), "utf8"),
    type: "application/rss+xml; charset=utf-8",
  },
  "huggingface.co": {
    body: await readFile(join(root, "e2e", "fixtures", "hf-blog.xml"), "utf8"),
    type: "application/atom+xml; charset=utf-8",
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  const host = new URL(url).hostname;

  // 本机（E2E 自身）放行，避免把 shim 服务器自己也拦掉
  if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);

  const fixture = fixtures[host];
  if (fixture) {
    return new Response(fixture.body, { status: 200, headers: { "content-type": fixture.type } });
  }

  // 其它源：模拟沙箱不可达（分类应为 network）
  throw new TypeError("fetch failed (sandbox: host not reachable)");
}) ;

/* ── 2) 起 shim：静态资源 + 全部交给真实 worker bundle ── */
const { default: WorkerClass } = await import(
  pathToFileURL(join(root, "dist", "ssr", "index.js")).href
);

const workerEnv = {
  MAGPIE_BASE_URL: "https://placeholder.invalid/v1",
  MAGPIE_API_KEY: "placeholder",
  MAGPIE_MODEL: "deepseek-chat",
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      // Void 的 worker 读 `/.vite/manifest.json` 注入客户端脚本，而构建产物落在
      // `dist/client/manifest.json`（实测：不做这个映射，首页不会输出 <script src>）。
      // 只剥前导斜杠：产物里就是 `dist/client/.vite/manifest.json`，剥掉 `.vite` 会 404
      // → 首页不输出 <script src>，水合入口丢失（本次排查踩过）。
      const rel = u.pathname.replace(/^\/+/, "");
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

const makeCtx = () => ({ waitUntil() {}, passThroughOnException() {} });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    if (url.pathname.startsWith("/assets/")) {
      const rel = normalize(url.pathname).replace(/^([/\\]|\.)+/, "");
      const abs = join(clientDir, rel);
      if (!abs.startsWith(clientDir)) throw new Error("path traversal");
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(data);
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    }
    const request = new Request(url.href, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
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

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

/* ── 3) 断言 ── */
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const getJson = async (path) => {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - started };
};

console.log(`[e2e] shim 已监听 ${BASE}（真实 build 产物 + 夹具上游）\n`);

// A1：单源真实 feed 解析
const single = await getJson("/api/feed?src=hn&limit=3");
check(
  "A1 单源抓取（真实 HN feed）返回条目",
  single.status === 200 && Array.isArray(single.body?.items) && single.body.items.length === 3,
  `status=${single.status} items=${single.body?.items?.length} ${single.ms}ms`,
);

const firstItem = single.body?.items?.[0];
check(
  "A1 条目字段完整（标题去 CDATA / 真实链接 / pubDate）",
  Boolean(firstItem?.title && firstItem?.link && firstItem?.publishedAt),
  JSON.stringify({
    title: String(firstItem?.title ?? "").slice(0, 46),
    link: firstItem?.link,
    publishedAt: firstItem?.publishedAt,
  }),
);
check(
  "A1 摘要已去 HTML 标签（真实 feed 描述含 <p>/<a>）",
  Boolean(firstItem?.summary) && !String(firstItem?.summary).includes("<"),
  String(firstItem?.summary ?? "").slice(0, 60),
);
check(
  "A1 源健康 ok 且条目数正确",
  single.body?.sources?.[0]?.health?.level === "ok" && single.body?.sources?.[0]?.health?.itemCount === 3,
  JSON.stringify(single.body?.sources?.[0]?.health),
);

// A2：跨源去重（Atom 夹具里有一条与 HN 同链接）
const duo = await getJson("/api/feed?src=hn,hf-blog&limit=20");
check(
  "A2 跨源去重：3 条 HN + 2 条 Atom，去重后 4 条",
  duo.status === 200 &&
    duo.body?.counts?.fetched === 5 &&
    duo.body?.counts?.kept === 4 &&
    duo.body?.counts?.deduped === 1,
  JSON.stringify(duo.body?.counts),
);
check(
  "A2 保留的是先出现者（HN 那条），重复的 Atom 条目被丢弃",
  duo.body?.items?.filter((i) => String(i.link).includes("wikihack.netlify.app")).length === 1,
  `同链接条目数=${duo.body?.items?.filter((i) => String(i.link).includes("wikihack.netlify.app")).length}`,
);

// A6：失败隔离（其余 4 个源在本环境不可达）
const all = await getJson("/api/feed?limit=30");
const failures = all.body?.failures ?? [];
const levels = (all.body?.sources ?? []).map((s) => `${s.id}:${s.health?.level}`);
check(
  "A6 全源请求整体 200（不因坏源 500）",
  all.status === 200,
  `status=${all.status} ${all.ms}ms`,
);
check(
  "A6 坏源被分类记录（network）且健康标记 broken",
  failures.length === 4 && failures.every((f) => typeof f.error === "string"),
  failures.map((f) => `${f.sourceId}:${f.error}`).join(", "),
);
check(
  "A6 好源仍为 ok（失败未放大）",
  levels.includes("hn:ok") && levels.includes("hf-blog:ok"),
  levels.join(" | "),
);

// A5：首页 SSR（1101 类问题的本地探测器）
const home = await realFetch(`${BASE}/`);
const html = await home.text();
check(
  "A5 首页 200 + SSR 出内容",
  home.status === 200 &&
    (home.headers.get("content-type") ?? "").includes("text/html") &&
    html.includes("AI 资讯雷达"),
  `status=${home.status} bytes=${html.length}`,
);
check(
  "A5 首页 HTML 引用了客户端脚本（水合入口在）",
  /<script[^>]+src="\/assets\//.test(html),
  `assets 引用=${(html.match(/<script[^>]+src="\/assets\//g) ?? []).length}`,
);

server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：" + failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}