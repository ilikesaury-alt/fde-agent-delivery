/**
 * GET /api/feed —— 抓取 → 去重 → 落库 → 返回条目 + 每源健康
 *
 * 逻辑全在 `lib/ingest.ts`（Cron 复用同一实现，避免手动与定时行为分叉）。
 * 本路由只负责：鉴权、源筛选、limit 截断、HTTP 投影。
 */

import { defineHandler } from "void";

import {
  authorize,
  intEnv,
  jsonResponse,
  resolveEnv,
  resolveFetchImpl,
  resolveStore,
} from "../../lib/http.ts";
import { ingestFeeds } from "../../lib/ingest.ts";
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

  const result = await ingestFeeds({
    env,
    sources,
    store: resolveStore(c),
    fetchImpl: resolveFetchImpl(c),
    maxItems,
    timeoutMs,
    concurrency: 3,
  });

  return jsonResponse(200, {
    fetchedAt: result.fetchedAt,
    elapsedMs: result.elapsedMs,
    budget: { sources: sources.length, maxItemsPerSource: maxItems, timeoutMs },
    storage: result.storage,
    persisted: result.persisted,
    persistError: result.persistError,
    sources: result.sources,
    failures: result.failures,
    counts: result.counts,
    items: result.items.slice(0, limit),
  });
});