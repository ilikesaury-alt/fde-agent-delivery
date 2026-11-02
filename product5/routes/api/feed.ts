/**
 * GET /api/feed —— 抓取订阅源 → 去重 → 返回条目 + 每源健康
 *
 * 这是**增量 1 的 M0 探针端点**，也是后续增量（评分/日报/UI）的数据入口：
 *  - 逐源失败隔离（CONTEXT A6）：一个源挂了照样返回其它源的结果
 *  - 每源健康三级（CONTEXT D10）：ok / degraded / broken，UI 可见
 *  - 不落库（增量 2 才接 D1）——本轮只验证「真环境能不能抓到、抓多少、耗多少预算」
 *
 * 查询参数：
 *   ?src=hn,hf-blog   只抓指定源（默认全部）
 *   ?limit=20         条目上限（抓取后截断）
 *
 * ⚠️ Free 套餐 subrequest 50/次：一次抓取源数建议 ≤5（见 CONTEXT A9）。
 */

import { defineHandler } from "void";

import { intEnv, jsonResponse, resolveEnv, resolveFetchImpl } from "../../lib/http.ts";
import { authorize } from "../../lib/http.ts";
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
  const timeoutMs = intEnv(env.FEED_TIMEOUT_MS, 8000);
  const limit = limitParam ? intEnv(limitParam, maxItems) : maxItems;

  const startedAt = Date.now();
  const results = await fetchAllFeeds(sources, {
    fetchImpl: resolveFetchImpl(c),
    timeoutMs,
    maxItems,
    concurrency: 3,
  });

  const all = results.flatMap((r) => (r.ok ? r.items : []));
  const { items, dropped } = dedupeItems(all);

  const health = results.map((r) => healthOf(r));
  const failures = results
    .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    .map((r) => ({ sourceId: r.source.id, error: r.error, message: r.message, status: r.status }));

  return jsonResponse(200, {
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    /** 抓取预算诊断：Free 套餐 subrequest 上限 50/次 */
    budget: { sources: sources.length, maxItemsPerSource: maxItems, timeoutMs },
    sources: sources.map((s, i) => ({
      id: s.id,
      name: s.name,
      lang: s.lang,
      url: s.url,
      verified: s.verified,
      health: health[i],
    })),
    failures,
    counts: { fetched: all.length, kept: items.length, deduped: dropped },
    items: items.slice(0, limit),
  });
});