/**
 * M0 真环境探针（经 ego-browser 的真实浏览器进程发起请求）
 *
 * 为什么不用 Node/curl：本沙箱 Node 出网被限制（fetch failed），
 * 但 ego-browser 是独立 Chromium 进程，网络栈不受同一限制 —— 产品③ 已验证同样做法。
 *
 * 验证目标（CONTEXT 增量 1 / A1）：
 *   ① Worker 在真环境能抓到订阅源（不是本地假数据）
 *   ② 逐源失败隔离：坏源不影响好源
 *   ③ 抓取耗时 / 条目数 / 去重数 可观测（为 A9 预算给数据）
 *
 * 用法：ego-browser nodejs < e2e/live-m0.mjs
 *      BASE=https://xxx ego / 换机器时改 BASE 常量
 */

const BASE = "https://ai-hot-radar.ilikesaury.workers.dev";

const task = await taskSpace("ai-hot-radar M0 2026-11-02");
const page = task.page("p1");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(`${BASE}/api/health`, { waitUntil: "load", timeout: 30000 });

/** 在页面上下文里发请求（浏览器网络栈） */
const call = (path, timeoutMs = 60000) =>
  page.evaluate(
    async (args) => {
      const started = Date.now();
      const res = await fetch(args.base + args.path, {
        headers: { accept: "application/json" },
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      return { status: res.status, body, clientMs: Date.now() - started };
    },
    { base: BASE, path },
  );

/* ── ① 健康探针 ── */
const health = await call("/api/health");
check(
  "/api/health 200 且 service 正确",
  health.status === 200 && health.body?.ok === true && health.body?.service === "ai-hot-radar",
  JSON.stringify(health.body),
);

/* ── ② 单源抓取（最小 M0 闭环）── */
const single = await call("/api/feed?src=hn&limit=5");
const singleItems = Array.isArray(single.body?.items) ? single.body.items.length : 0;
check(
  "单源 hn 抓取返回条目（A1 最小闭环）",
  single.status === 200 && singleItems > 0,
  `status=${single.status} 条目=${singleItems} 耗时=${single.body?.elapsedMs}ms 客户端=${single.clientMs}ms`,
);

if (singleItems > 0) {
  const it0 = single.body.items[0];
  check(
    "条目字段完整（标题/链接/源）",
    Boolean(it0.title && it0.link && it0.sourceId),
    JSON.stringify({ title: String(it0.title).slice(0, 40), link: it0.link, publishedAt: it0.publishedAt }),
  );
  check(
    "健康分级 ok",
    single.body?.sources?.[0]?.health?.level === "ok",
    JSON.stringify(single.body?.sources?.[0]?.health),
  );
}

/* ── ③ 全源抓取：失败隔离 + 预算观测 ── */
const all = await call("/api/feed?limit=30");
const sources = all.body?.sources ?? [];
const failures = all.body?.failures ?? [];
const okCount = sources.filter((s) => s.health?.level === "ok").length;
const brokenCount = sources.filter((s) => s.health?.level === "broken").length;

check("全源抓取返回 200", all.status === 200, `status=${all.status}`);
check(
  "至少一个源成功（真环境出网可用）",
  okCount > 0,
  `ok=${okCount} broken=${brokenCount} 源数=${sources.length}`,
);
check(
  "失败隔离：坏源被分类记录而非整体 500",
  all.status === 200 && failures.every((f) => typeof f.error === "string"),
  failures.map((f) => `${f.sourceId}:${f.error}`).join(", ") || "无失败源",
);

console.log("\n— 全源明细（M0 数据，用于回填 lib/sources.ts 的 verified 与 A9 预算）—");
for (const s of sources) {
  console.log(
    `  ${s.id.padEnd(12)} ${String(s.health?.level).padEnd(9)} 条目=${String(s.health?.itemCount).padStart(3)} ${s.url}`,
  );
}
console.log(
  `  counts: 抓到 ${all.body?.counts?.fetched} / 去重后 ${all.body?.counts?.kept} / 重复 ${all.body?.counts?.deduped}` +
    ` · Worker 内耗时 ${all.body?.elapsedMs}ms · 客户端 ${all.clientMs}ms`,
);

/* ── ④ 首页可渲染（1101 探测器）── */
const home = await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 });
const html = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "");
check(
  "首页 200 且渲染出内容",
  (home?.status?.() ?? 0) === 200 && html.length > 20,
  `status=${home?.status?.()} text=${JSON.stringify(html.slice(0, 60))}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\nM0 探针：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：" + failed.map((f) => f.name).join("; "));
  throw new Error(`M0 未通过：${failed.length} 项失败`);
}
