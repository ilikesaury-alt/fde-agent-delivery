/**
 * lib/daily.ts —— 生成并落库当日日报（cron 与 POST /api/digest 共用）
 *
 * 修复的审查发现：
 *   A-2 日报**无日期窗口** → 「每日日报」= 全库累计 top200，第 1 天与第 30 天几乎逐字相同。
 *       现在按 `first_seen_at` 落在 [窗口起点, 窗口终点) 内取条目 —— 日报语义是「今天新出现的资讯」。
 *   A-4 计数自相矛盾：fetched 与 kept 都传 countItems() → 第一行恒为「抓取 N → 去重后 N」；
 *       aboveThreshold 被 listTopScored(limit:200) 硬顶在 200。现在用 windowStats 分别 COUNT。
 *   B-3 同一天 cron 与 POST 并发 → 后写者静默胜出，无法追溯。现在记录 generation_id/source/previous_selected。
 *
 * 窗口口径（写清以免误读）：
 *   - `windowStart` = 当日 00:00 UTC，`windowEnd` = 次日 00:00 UTC
 *   - 按 **first_seen_at**（我们第一次见到这条资讯的时间）判定，不是 published_at
 *     —— 因为源站的发布时间常常滞后/时区混乱，而「今天新出现」是我们能准确知道的
 *   - 日报 `date` 字段 = 窗口起点所在 UTC 日期
 */

import { buildDigest, selectWithQuota, type DigestItem, type DigestSourceState } from "./digest.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, perSourceMaxOf } from "./score.ts";
import type { DigestRecord, Store } from "./store.ts";

export type GenerateDigestOptions = {
  store: Store;
  /** UTC 日期 YYYY-MM-DD；缺省为今天 */
  date?: string;
  threshold?: number;
  topN?: number;
  model: string;
  promptVersion: string;
  /** 谁触发的：cron / manual（用于并发追溯） */
  source?: "cron" | "manual";
};

export type GenerateDigestResult = {
  record: DigestRecord;
  stats: {
    aboveThreshold: number;
    selected: number;
    skippedQuota: number;
    /** 若本次入选数比上次骤降（< 上次的一半）则置 true，供调用方告警 */
    shrinkWarning: boolean;
  };
};

/** 计算某 UTC 日期的窗口边界（毫秒） */
export function dayWindow(date: string): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start)) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const s = Date.parse(`${today}T00:00:00.000Z`);
    return { start: s, end: s + 86_400_000 };
  }
  return { start, end: start + 86_400_000 };
}

export async function generateDigest(opts: GenerateDigestOptions): Promise<GenerateDigestResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const perSourceMax = perSourceMaxOf(topN);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const { start, end } = dayWindow(date);

  // 审查 A-2：取**窗口内**条目，不是全库
  const [scored, states, stats] = await Promise.all([
    opts.store.listTopScoredInWindow({ threshold, sinceMs: start, untilMs: end, limit: 500 }),
    opts.store.listSourceStates(),
    opts.store.windowStats(start, end, threshold),
  ]);

  // 上一份日报的入选数（用于骤降告警，审查 B-3）
  // 注意：若 daily 表尚未迁移到 0005（缺 window_start 等列），getDigest 会抛
  const prev = await opts.store.getDigest(date).catch(() => null);
  const previousSelected = prev?.counts.selected ?? null;

  const items: DigestItem[] = scored.map((s) => ({
    title: s.title,
    link: s.link,
    sourceId: s.sourceId,
    total: s.total,
    reason: s.reason,
    publishedAt: s.publishedAt,
  }));

  const sources: DigestSourceState[] = states.map((s) => ({
    id: s.sourceId,
    name: s.sourceId,
    level: s.lastHealth ?? "ok",
    itemCount: s.lastItemCount,
    error: s.lastError,
  }));

  const quota = selectWithQuota(items, { threshold, topN, perSourceMax });

  // 审查 A-4：计数各自独立，不再复用同一个 countItems
  const counts = {
    fetched: stats.fetched,
    kept: stats.kept,
    deduped: stats.deduped,
    scored: stats.scored,
    aboveThreshold: stats.aboveThreshold,
    selected: quota.kept.length,
    skippedQuota: quota.skippedByQuota,
  };

  const { markdown } = buildDigest({
    date,
    items,
    threshold,
    topN,
    perSourceMax,
    counts,
    sources,
    model: opts.model,
    promptVersion: opts.promptVersion,
    windowStart: start,
    windowEnd: end,
  });

  const generationId = `${opts.source ?? "cron"}-${Date.now().toString(36)}`;

  const record: DigestRecord = {
    date,
    markdown,
    threshold,
    perSourceMax,
    topN,
    counts,
    model: opts.model,
    promptVersion: opts.promptVersion,
    windowStart: start,
    windowEnd: end,
    generationId,
    generationSource: opts.source ?? "cron",
    previousSelected,
  };

  await opts.store.saveDigest(record);

  const shrinkWarning =
    previousSelected !== null && previousSelected >= 3 && quota.kept.length < previousSelected * 0.5;

  return {
    record,
    stats: {
      aboveThreshold: stats.aboveThreshold,
      selected: quota.kept.length,
      skippedQuota: quota.skippedByQuota,
      shrinkWarning,
    },
  };
}