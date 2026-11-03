/**
 * 本地端到端（E2E）：**真实 build 产物 + 真实 HTTP + 真实路由/SSR**，只把上游换成夹具
 *
 * 为什么这么做：本沙箱出网是白名单（workers.dev / feed 站点都不可达），
 * workerd 也起不来（AGENTS.md 记录的环境约束）。所以按仓库既有做法（product1/e2e/server.mjs）
 * 用 Node shim 加载 `dist/ssr/index.js` 这个**真正要部署的产物**，用真实 HTTP 打进去。
 *
 * 覆盖的验收标准：
 *   A1 抓取解析闭环（用**真实 HN feed**，含 CDATA/HTML 描述/dc:creator/guid 等真实怪癖）
 *   A2 跨源去重（夹具里刻意放一条与 HN 同链接的 Atom 条目）+ **跨请求去重**（D1 替身）
 *   A5 首页 SSR 可渲染（1101 类问题的本地探测器）
 *   A6 失败隔离（不可达源分类记录，整体仍 200）
 *
 * D1 用 `node:sqlite` 替身（e2e/d1-shim.mjs）跑**同一套迁移 SQL** —— 所以这里验证的是
 * 真 SQL 语义（唯一约束 / ON CONFLICT / MAX 基线），不是内存 Map 的近似。
 *
 * 未覆盖：真环境出网（M0，见 docs/deploy-ai-hot-radar.md §3，需人工执行）
 *
 * 用法：
 *   npm run build && node --import ./e2e/bootstrap.mjs e2e/local-e2e.mjs
 */

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createD1Shim } from "./d1-shim.mjs";

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
//
// ⚠️ 2026-11-03：源列表从 6 个扩到 14 个后，本替身必须**逐个 host 覆盖**。
//   否则未覆盖的源会被判为 network 失败 → 「A6 好源仍为 ok」「A2 跨源去重」等断言全线失败
//   （这类「夹具跟不上配置」的失败最容易被误读成产品 bug）。
//
//   夹具里刻意保留一条与 HN 同链接的条目（simonw 夹具），用于验证跨源去重。
const FIXTURE_HOSTS = [
  "hnrss.org",
  "openai.com",
  "deepmind.google",
  "blog.google",
  "aws.amazon.com",
  "blogs.nvidia.com",
  "export.arxiv.org",
  "simonwillison.net",
  "techcrunch.com",
  "importai.substack.com",
  "www.marktechpost.com",
  "www.technologyreview.com",
  "www.ithome.com",
  "sspai.com",
];

const fixtures = {
  "hnrss.org": {
    body: await readFile(join(root, "e2e", "fixtures", "hn-frontpage.xml"), "utf8"),
    type: "application/rss+xml; charset=utf-8",
  },
  // 各扩源：一个最小合法 Atom feed（每源一条 + 摘要够长）
  "openai.com": { file: "openai-news.xml" },
  "deepmind.google": { file: "deepmind.xml" },
  "blog.google": { file: "google-ai.xml" },
  "aws.amazon.com": { file: "aws-ml.xml" },
  "blogs.nvidia.com": { file: "nvidia.xml" },
  "export.arxiv.org": { file: "arxiv-cs-ai.xml" },
  "techcrunch.com": { file: "techcrunch-ai.xml" },
  "importai.substack.com": { file: "importai.xml" },
  "www.marktechpost.com": { file: "marktechpost.xml" },
  "www.technologyreview.com": { file: "mit-tech-review.xml" },
  "www.ithome.com": { file: "ithome.xml" },
  "sspai.com": { file: "sspai.xml" },
  // simonw：跨源去重用（夹具里有一条与 HN 同链接的条目）
  "simonwillison.net": {
    body: await readFile(join(root, "e2e", "fixtures", "simonw.xml"), "utf8"),
    type: "application/atom+xml; charset=utf-8",
  },
};

// 把 { file } 形式展开为真实 body
for (const [host, spec] of Object.entries(fixtures)) {
  if (spec.file) {
    spec.body = await readFile(join(root, "e2e", "fixtures", spec.file), "utf8");
    spec.type = "application/atom+xml; charset=utf-8";
  }
}

/** LLM 调用计数（方案 D 验证：粗筛 vs 精排各多少次） */
const llmCalls = { coarse: 0, final: 0, coarseItems: 0 };

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

  // ── LLM 网关替身（方案 D 验证用）──
  // 粗筛请求的 user 消息里有 `[1]` `[2]` 这样的编号行；精排是单条、无编号。
  // 计数是为了断言「调用次数真的降下来了」。
  if (host === "placeholder.invalid") {
    let body = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      body = {};
    }
    const user = String(body.messages?.[1]?.content ?? "");
    const numbered = (user.match(/^\[\d+\]/gm) ?? []).length;
    if (numbered > 0) {
      llmCalls.coarse++;
      llmCalls.coarseItems += numbered;
      const arr = Array.from({ length: numbered }, (_, i) => ({ id: i + 1, score: 9 - (i % 3) }));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    llmCalls.final++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"relevance":8,"novelty":7,"usefulness":8,"authority":9,"reason":"重要发布"}',
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // 其它源：模拟沙箱不可达（分类应为 network）
  throw new TypeError("fetch failed (sandbox: host not reachable)");
}) ;

/* ── 2) 起 shim：静态资源 + 全部交给真实 worker bundle ── */
const { default: WorkerClass } = await import(
  pathToFileURL(join(root, "dist", "ssr", "index.js")).href
);

/** 建一个已应用全部迁移的内存 D1（与线上同一批 SQL 文件，不是手写 schema） */
async function createMigratedD1() {
  const db = createD1Shim(":memory:");
  const dir = join(root, "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(await readFile(join(dir, f), "utf8"));
  return db;
}

/** 审查 B-1 修复后写接口强制要求令牌，E2E 需要带同一把 */
const E2E_TOKEN = "e2e-test-token";

const workerEnv = {
  MAGPIE_BASE_URL: "https://placeholder.invalid/v1",
  MAGPIE_API_KEY: "placeholder",
  MAGPIE_MODEL: "deepseek-chat",
  ACCESS_TOKEN: E2E_TOKEN,
  DB: await createMigratedD1(),
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

const AUTH = { authorization: `Bearer ${E2E_TOKEN}` };

const getJson = async (path) => {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { headers: AUTH });
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

// A2：跨源去重（simonw 的 Atom 夹具里有一条与 HN 同链接）
const duo = await getJson("/api/feed?src=hn,simonw&limit=20");
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

// A6：失败隔离（14 个源全部有夹具 → 本环境不应出现失败源；
//     失败隔离本身由「不存在的 host」在单测里覆盖，见 test/routes.test.ts）
const all = await getJson("/api/feed?limit=30");
const failures = all.body?.failures ?? [];
const levels = (all.body?.sources ?? []).map((s) => `${s.id}:${s.health?.level}`);
check(
  "A6 全源请求整体 200（不因坏源 500）",
  all.status === 200,
  `status=${all.status} ${all.ms}ms`,
);
check(
  "A6 14 个源全部抓通（每个源都有上游夹具）",
  failures.length === 0 && (all.body?.sources ?? []).length === 14,
  `sources=${(all.body?.sources ?? []).length} failures=${failures.map((f) => `${f.sourceId}:${f.error}`).join(", ") || "无"}`,
);
check(
  "A6 好源仍为 ok（失败未放大）",
  levels.includes("hn:ok") && levels.includes("simonw:ok") && levels.every((l) => l.endsWith(":ok")),
  levels.join(" | "),
);

// A2（增量 2）：跨请求持久化去重 —— 真 SQL 语义（唯一约束 / ON CONFLICT）
const stored1 = await getJson("/api/items?limit=10");
check(
  "A2 落库：/api/items 能读到之前抓到的条目（不触网）",
  stored1.body?.storage === "ok" && (stored1.body?.count ?? 0) >= 4,
  `storage=${stored1.body?.storage} count=${stored1.body?.count}`,
);

const rerun1 = await getJson("/api/feed?src=hn,simonw&limit=20");
const rerun2 = await getJson("/api/feed?src=hn,simonw&limit=20");
check(
  "A2 跨请求去重：重复抓取不新增（inserted=0）",
  rerun1.status === 200 && rerun2.body?.persisted?.inserted === 0,
  `第一次=${JSON.stringify(rerun1.body?.persisted)} 第二次=${JSON.stringify(rerun2.body?.persisted)}`,
);

const stored2 = await getJson("/api/items?limit=10");
check(
  "A2 条目总数不因重复抓取而增长",
  stored2.body?.count === stored1.body?.count,
  `${stored1.body?.count} → ${stored2.body?.count}`,
);
const snap = stored2.body?.sources ?? [];
const okSnap = snap.filter((s) => s.lastHealth === "ok");
const badSnap = snap.filter((s) => s.lastHealth !== "ok");
check(
  "D10 源健康快照：正常源建立 baseline，坏源不伪造 baseline",
  snap.length > 0 &&
    okSnap.length > 0 &&
    okSnap.every((s) => (s.baselineCount ?? 0) > 0) &&
    badSnap.every((s) => s.lastError !== null && s.baselineCount === null),
  JSON.stringify(snap.map((s) => `${s.sourceId}:${s.lastHealth}/base=${s.baselineCount}`)),
);

// 增量 4：日报生成（POST 手动重跑，与 cron 同一实现 lib/daily.ts）
const gen = await fetch(`${BASE}/api/digest`, { method: "POST", headers: AUTH }).then(async (r) => ({
  status: r.status,
  body: await r.json().catch(() => null),
}));
check(
  "增量4 POST /api/digest 生成当日日报（400 行以内）",
  gen.status === 200 && gen.body?.date?.length === 10 && typeof gen.body?.digest?.markdown === "string",
  `status=${gen.status} date=${gen.body?.date} 入选=${gen.body?.stats?.selected}`,
);
const md = gen.body?.digest?.markdown ?? "";
check(
  "增量4 日报含全部 6 板块（固定结构）",
  ["一、今日概览", "二、头条", "三、值得一看", "四、分源视角", "五、源健康", "六、口径说明"].every((h) => md.includes(h)),
  `长度=${md.length}`,
);
const dg = await getJson("/api/digest");
check(
  "增量4 GET /api/digest 能读回刚生成的日报",
  dg.status === 200 && dg.body?.digest?.date === gen.body?.date,
  `status=${dg.status}`,
);
const dgList = await getJson("/api/digest?list=1");
check(
  "增量4 日报索引可列（供历史回看）",
  dgList.status === 200 && Array.isArray(dgList.body?.list) && dgList.body.list.length >= 1,
  `list=${dgList.body?.list?.length}`,
);

// 审查 B-1 回归：写接口在未带令牌时必须被拒（不能匿名覆盖日报/刷爆 LLM）
const noAuthScore = await fetch(`${BASE}/api/score`, { method: "POST" }).then((r) => r.status);
check("审查B-1 无令牌 POST /api/score 被拒（401）", noAuthScore === 401, `status=${noAuthScore}`);
const noAuthDigest = await fetch(`${BASE}/api/digest`, { method: "POST" }).then((r) => r.status);
check("审查B-1 无令牌 POST /api/digest 被拒（401）", noAuthDigest === 401, `status=${noAuthDigest}`);

// 审查 B-3 回归：非法参数必须 400（不能生成空日报覆盖好日报）
const badTopN = await fetch(`${BASE}/api/digest?topN=abc`, { method: "POST", headers: AUTH }).then((r) => r.status);
check("审查B-3 topN=abc → 400（旧实现会静默生成空日报）", badTopN === 400, `status=${badTopN}`);
const badThreshold = await fetch(`${BASE}/api/digest?threshold=999999`, { method: "POST", headers: AUTH }).then((r) => r.status);
check("审查B-3 threshold 越界 → 400", badThreshold === 400, `status=${badThreshold}`);
const badTopGet = await fetch(`${BASE}/api/top?threshold=abc`, { headers: AUTH }).then((r) => r.status);
check("审查B-3 GET /api/top 非法 threshold → 400", badTopGet === 400, `status=${badTopGet}`);

// 增量 5：源健康历史接口 + 页签 UI
const srcRes = await getJson("/api/sources?history=10");
check(
  "增量5 GET /api/sources 返回各源快照 + 历史",
  srcRes.status === 200 && srcRes.body?.storage === "ok" && srcRes.body.sources.length > 0,
  `sources=${srcRes.body?.sources?.length} storage=${srcRes.body?.storage}`,
);
const hn = (srcRes.body?.sources ?? []).find((s) => s.id === "hn");
check(
  "增量5 源快照含健康状态、基线与连续失败次数",
  Boolean(hn && hn.lastHealth && typeof hn.consecutiveFailures === "number" && Array.isArray(hn.history)),
  JSON.stringify({ health: hn?.lastHealth, base: hn?.baselineCount, fails: hn?.consecutiveFailures, hist: hn?.history?.length }),
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

// 增量5：首页页签（SSR 首屏就应出现四个页签标签）
check(
  "增量5 首页含日报/精选/历史/源健康四个页签",
  ["日报", "精选", "历史", "源健康"].every((t) => html.includes(t)),
  `命中=${["日报", "精选", "历史", "源健康"].filter((t) => html.includes(t)).join(",")}`,
);

// ── 2026-11-03：D1 batch 写入路径 ───────────────────────────────
//
// 扩源到 14 源后，一轮要写 200+ 条条目；逐条 prepare().run() = 200+ 次 D1 往返，
// 打满内部 subrequest 预算（官方 limits：D1 内部 1,000/次，但 batch 整批只计 1 个）。
// 写入路径已改为 db.batch()，这里验证**batch 与逐条语义等价**，
// 且 batch 真的被调用了（否则等于没测）。
{
  const shim = await createMigratedD1();
  // 直接用 lib 源（与 worker 同一份代码）；dist 产物是打包过的，拿不到单独模块
  const { createD1Store: createStore } = await import("../lib/store.ts");

  let batchCalls = 0;
  let batchStmts = 0;
  const counted = {
    ...shim,
    async batch(stmts) {
      batchCalls++;
      batchStmts += stmts.length;
      return shim.batch(stmts);
    },
  };

  const store = createStore(counted);
  const raw = Array.from({ length: 25 }, (_, i) => ({
    id: `i${i}`,
    sourceId: "hn",
    title: `条目 ${i}`,
    link: `https://a.com/${i}`,
    publishedAt: "2026-11-01T00:00:00.000Z",
    summary: "摘要",
  }));
  const res = await store.saveItems(raw);
  check(
    "batch 写入：25 条一次入库全部新增",
    res.inserted === 25 && res.duplicates === 0,
    `inserted=${res.inserted} duplicates=${res.duplicates}`,
  );
  check(
    "batch 写入：真的走了 db.batch（而不是逐条发）",
    batchCalls > 0 && batchStmts > 25,
    `batchCalls=${batchCalls} stmts=${batchStmts}`,
  );

  // 跨请求去重：同一批再写一次 → 全部判重，且不新增
  const res2 = await store.saveItems(raw);
  check(
    "batch 写入：重写同一批 → 全部判重（唯一约束兜底）",
    res2.inserted === 0 && res2.duplicates === 25,
    `inserted=${res2.inserted} duplicates=${res2.duplicates}`,
  );

  // 源快照（recordRun）也要走 batch
  const before = batchCalls;
  await store.recordRun([
    {
      source: { id: "hn", name: "Hacker News", url: "https://hnrss.org/frontpage", lang: "en", verified: true },
      health: { sourceId: "hn", level: "ok", itemCount: 25, checkedAt: new Date().toISOString() },
      elapsedMs: 100,
    },
  ]);
  check(
    "batch 写入：源健康快照也走 db.batch",
    batchCalls > before,
    `batchCalls ${before} → ${batchCalls}`,
  );
}


/* ── 方案 D：批量粗筛 + 逐条精排（堆积场景）────────────────────
 *
 * 为什么要单独测：稳态下每轮只新增 ~2 条，粗筛反而是浪费（会跳过）。
 * 只有**堆积**时（冷启动 / 长期不刷新）粗筛才发挥价值 —— 那才是它要解决的场景。
 *
 * 断言的是「调用次数真的降下来了」，而不是「粗筛被调用了」。
 */
{
  const db = workerEnv.DB;

  // 造 25 条待评条目（超过精排上限 20 → 触发粗筛）
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    db.exec(
      `INSERT INTO items
         (content_key, id, source_id, title, link, published_at, summary, first_seen_at, last_seen_at, score_state)
       VALUES (
         'ck-${i}', 'id-${i}', 'hn',
         'OpenAI 发布新模型 ${i} 支持更长上下文与工具调用',
         'https://example.com/e2e/${i}', ${now},
         '官方博客介绍了新模型的推理能力与基准表现，附有对比数据与评测结果。',
         ${now}, ${now}, 'pending'
       )`,
    );
  }

  const before = { ...llmCalls };
  const res = await fetch(`${BASE}/api/refresh`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
  });
  const body = await res.json();

  const coarseCalls = llmCalls.coarse - before.coarse;
  const coarseItems = llmCalls.coarseItems - before.coarseItems;
  const finalCalls = llmCalls.final - before.final;

  check(
    "方案D 堆积时启用批量粗筛",
    coarseCalls > 0,
    `粗筛调用 ${coarseCalls} 次 · 覆盖 ${coarseItems} 条 · 精排 ${finalCalls} 次`,
  );
  check(
    "方案D 粗筛批量为 10（RoBatch 的 16 悬崖前留余量）",
    coarseItems > 0 && coarseItems / coarseCalls <= 10,
    `每批 ${(coarseItems / Math.max(1, coarseCalls)).toFixed(1)} 条`,
  );
  check(
    "方案D 精排只做 top20（不是全部 25 条）",
    finalCalls === 20,
    `精排 ${finalCalls} 次`,
  );
  check(
    "方案D 总调用次数低于逐条评（25 次）",
    coarseCalls + finalCalls < 25,
    `总调用 ${coarseCalls + finalCalls} 次 < 25 次`,
  );
  check(
    "方案D 粗分落库（items.coarse_score 有值）",
    (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE coarse_score IS NOT NULL`).bind().first()?.n ?? 0) > 0,
    "粗分已写入 items.coarse_score",
  );
}

server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：" + failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}