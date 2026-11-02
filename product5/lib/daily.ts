/**
 * lib/daily.ts —— 生成并落库当日日报（cron 与 POST /api/digest 共用）
 *
 * 抽出来的原因：定时任务与「手动重跑」必须是**同一条实现**。
 * 否则调阈值后手动刷新看到的日报，和次日自动生成的日报口径会不一致——
 * 这类分叉在日报这种「一天只产出一份」的东西上尤其难发现。
 */

import { buildDigest, selectWithQuota, type DigestItem, type DigestSourceState } from "./digest.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, perSourceMaxOf } from "./score.ts";
import type { DigestRecord, Store } from "./store.ts";

export type GenerateDigestOptions = {
  store: Store;
  /** 缺省 UTC 今天 */
  date?: string;
  threshold?: number;
  topN?: number;
  model: string;
  promptVersion: string;
};

export type GenerateDigestResult = {
  record: DigestRecord;
  stats: { aboveThreshold: number; selected: number; skippedQuota: number };
};

export async function generateDigest(opts: GenerateDigestOptions): Promise<GenerateDigestResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const perSourceMax = perSourceMaxOf(topN);
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  const [scored, states, itemCount, scoreCount] = await Promise.all([
    opts.store.listTopScored({ threshold, limit: 200 }),
    opts.store.listSourceStates(),
    opts.store.countItems(),
    opts.store.countScores(),
  ]);

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

  const { markdown } = buildDigest({
    date,
    items,
    threshold,
    topN,
    perSourceMax,
    counts: {
      fetched: itemCount,
      kept: itemCount,
      scored: scoreCount,
      aboveThreshold: scored.length,
      selected: quota.kept.length,
    },
    sources,
    model: opts.model,
    promptVersion: opts.promptVersion,
  });

  const record: DigestRecord = {
    date,
    markdown,
    threshold,
    perSourceMax,
    topN,
    counts: {
      fetched: itemCount,
      kept: itemCount,
      scored: scoreCount,
      aboveThreshold: scored.length,
      selected: quota.kept.length,
      skippedQuota: quota.skippedByQuota,
    },
    model: opts.model,
    promptVersion: opts.promptVersion,
  };

  await opts.store.saveDigest(record);
  return {
    record,
    stats: { aboveThreshold: scored.length, selected: quota.kept.length, skippedQuota: quota.skippedByQuota },
  };
}