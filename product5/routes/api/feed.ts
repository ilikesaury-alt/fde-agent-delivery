/**
 * GET /api/feed —— 抓取订阅源 → 去重 → 落库 → 返回条目 + 每源健康
 *
 * 增量 2 起：抓到的条目会**持久化**（D1），跨请求去重由数据库唯一约束兜底。
 * 响应里用 `persisted: {inserted, duplicates}` 明确区分「这一次新增了几条」，
 * 而不是把「抓到 N 条」当「新增 N 条」（两者差一个数量级，是资讯类产品的常见口径错误）。
 *
 * 设计纪律：
 *  - 逐源失败隔离（A6）；每源健康三级（D10）
 *  - **落库失败不拖垮响应**：抓取到的内容对用户仍有用 → `persisted=null` + `persistError` 明示
 *  - 无 D1 绑定（如本地 E2E）自动降级为不落库，不报错
 *
 * 查询参数：?src=hn,hf-blog（筛选源）、?limit=20（返回条目上限）
 * ⚠️ Free 套餐 subrequest 50/次：抓取源数建议 ≤5。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveEnv, resolveFetchImpl, resolveStore } from "../../lib/http.ts";
import { dedupeItems, fetchAllFeeds, healthOf } from "../../lib/rss.ts";
import { DEFAULT_SOURCES } from "../../lib/sources.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const env = resolveEnv(c);
  const srcParam = c.req.query("src");
  const limitParam = c.req.query("limit");

  const wanted = srcParam
    ? new Set(
        srcParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const sources = wanted ? DEFAULT_SOURCES.filter((s) => wanted.has(s.id)) : DEFAULT_SOURCES;
  if (sources.length === 0) {
    return jsonResponse(400, { error: "未匹配到任何订阅源，请检查 src 参数。" });
  }

  const maxItems = intEnv(env.FEED_MAX_ITEMS, 40);
  const timeoutMs = intEnv(env.FEED_TIMEOUT_MS, 12_000);
  const limit = limitParam ? intEnv(limitParam, maxItems) : maxItems;

  const store = resolveStore(c);

  // baselines 用于判定「条目骤降」（D10 degraded）；读失败不阻塞抓取
  const baselines = new Map<string, number>();
  if (store) {
    try {
      for (const s of await store.listSourceStates()) {
        if (s.baselineCount && s.baselineCount > 0) baselines.set(s.sourceId, s.baselineCount);
      }
    } catch {
      // 忽略：没有基线只是不能判骤降，不影响抓取本身
    }
  }

  const startedAt = Date.now();
  const results = await fetchAllFeeds(sources, {
    fetchImpl: resolveFetchImpl(c),
    timeoutMs,
    maxItems,
    concurrency: 3,
  });
  const elapsedMs = Date.now() - startedAt;

  const all = results.flatMap((r) => (r.ok ? r.items : []));
  const { items, dropped } = dedupeItems(all);
  const health = results.map((r) => healthOf(r, baselines.get(r.source.id)));

  const failures = results
    .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    .map((r) => ({ sourceId: r.source.id, error: r.error, message: r.message, status: r.status }));

  let persisted: { inserted: number; duplicates: number } | null = null;
  let persistError: string | null = null;
  if (store) {
    try {
      persisted = await store.saveItems(items);
      // 每源耗时未单独计时：只写入可确定的字段（不猜）
      await store.recordRun(
        results.map((r, i) => ({ source: sources[i]!, health: health[i]! })),
      );
    } catch {
      persisted = null;
      persistError = "本次抓取未能写入存储，历史与跨请求去重暂不生效。";
    }
  }

  return jsonResponse(200, {
    fetchedAt: new Date().toISOString(),
    elapsedMs,
    budget: { sources: sources.length, maxItemsPerSource: maxItems, timeoutMs },
    storage: store ? (persisted ? "ok" : "failed") : "disabled",
    persisted,
    persistError,
    sources: sources.map((s, i) => ({
      id: s.id,
      name: s.name,
      lang: s.lang,
      url: s.url,
      verified: s.verified,
      baseline: baselines.get(s.id) ?? null,
      health: health[i],
    })),
    failures,
    counts: { fetched: all.length, kept: items.length, deduped: dropped },
    items: items.slice(0, limit),
  });
});