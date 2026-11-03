/**
 * lib/ingest.ts —— 抓取 → 去重 → 落库（/api/feed 与 Cron 共用的唯一实现）
 *
 * 为什么抽出来：增量 4 起 Cron 也要走同一条链路。如果 cron 复制一份逻辑，
 * 「手动刷新」与「定时扫描」迟早行为分叉（一个修了另一个没修）——这类分叉在有 UI 的产品里最难发现。
 *
 * 纪律（沿用 /api/feed 既有约定）：
 *  - 逐源失败隔离；每源健康三级；baseline 参与「条目骤降」判定
 *  - 落库失败不拖垮结果：返回 storage="failed" + 面向用户文案，抓取内容照常返回
 *  - 无 D1 时降级 storage="disabled"
 */

import type { Store } from "./store.ts";
import { dedupeItems, fetchAllFeeds, healthOf } from "./rss.ts";
import type { FeedSource, RawItem, SourceHealth } from "./types.ts";

export type IngestOptions = {
  env: { FEED_MAX_ITEMS?: string; FEED_TIMEOUT_MS?: string };
  sources: FeedSource[];
  store: Store | null;
  fetchImpl?: typeof fetch;
  maxItems: number;
  timeoutMs: number;
  concurrency?: number;
};

export type IngestResult = {
  fetchedAt: string;
  elapsedMs: number;
  sources: Array<
    FeedSource & { baseline: number | null; health: SourceHealth }
  >;
  failures: Array<{ sourceId: string; error: string; message: string; status?: number }>;
  counts: { fetched: number; kept: number; deduped: number };
  items: RawItem[];
  storage: "ok" | "failed" | "disabled";
  /** 源健康是否写成功（false 时 UI 不能把 lastHealth 当当前状态看） */
  healthRecorded: boolean;
  persisted: { inserted: number; duplicates: number } | null;
  persistError: string | null;
};

export async function ingestFeeds(opts: IngestOptions): Promise<IngestResult> {
  const { sources, store } = opts;
  const startedAt = Date.now();

  // baselines 用于「条目骤降」判定；读失败不阻塞抓取
  const baselines = new Map<string, number>();
  if (store) {
    try {
      for (const s of await store.listSourceStates()) {
        if (s.baselineCount && s.baselineCount > 0) baselines.set(s.sourceId, s.baselineCount);
      }
    } catch {
      // 忽略：没有基线只是不能判骤降
    }
  }

  const results = await fetchAllFeeds(sources, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    maxItems: opts.maxItems,
    concurrency: opts.concurrency ?? 3,
  });
  const elapsedMs = Date.now() - startedAt;

  const all = results.flatMap((r) => (r.ok ? r.items : []));
  const { items, dropped } = dedupeItems(all);
  // 传入 maxItems：baseline 必须封顶到本次取样上限后再比较（见 lib/rss.ts healthOf 注释）
  const health = results.map((r) => healthOf(r, baselines.get(r.source.id), { maxItems: opts.maxItems }));

  const failures = results
    .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    .map((r) => ({ sourceId: r.source.id, error: r.error, message: r.message, status: r.status }));

  let persisted: { inserted: number; duplicates: number } | null = null;
  let persistError: string | null = null;
  let storage: IngestResult["storage"] = "disabled";
  /** 源健康记录是否写成功（审查 A-5：与 items 写入分开，一个失败不能连带另一个） */
  let healthRecorded = false;

  if (store) {
    // ① 条目写入
    try {
      persisted = await store.saveItems(items);
      storage = "ok";
    } catch {
      storage = "failed";
      persistError = "本次抓取未能写入存储，历史与跨请求去重暂不生效。";
    }

    // ② 源健康写入：**独立 try**（审查 A-5）。
    // 旧实现把两步放在同一个 try 里 —— items 写入超 subrequest 预算后，
    // recordRun 根本不会执行 → sources 表 last_health 永远停在旧的 "ok"，
    // UI 显示源正常而实际已连续失败（这是最坏的组合：看起来一切正常）。
    try {
      await store.recordRun(results.map((r, i) => ({ source: sources[i]!, health: health[i]! })));
      healthRecorded = true;
    } catch (err) {
      console.error(
        `[ingest] 源健康写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    fetchedAt: new Date().toISOString(),
    elapsedMs,
    sources: sources.map((s, i) => ({ ...s, baseline: baselines.get(s.id) ?? null, health: health[i]! })),
    failures,
    counts: { fetched: all.length, kept: items.length, deduped: dropped },
    items,
    storage,
    healthRecorded,
    persisted,
    persistError,
  };
}