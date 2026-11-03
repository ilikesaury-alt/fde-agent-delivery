/**
 * lib/queue.ts —— 评分队列编排（cron 与 POST /api/score 共用）
 *
 * 修复的审查发现：
 *   A-1 评分队列「新优先 + 无跳过」→ 旧条目永久饿死。现在走 `claimForScoring`
 *       （按 attempts 升序 + 租约认领），旧条目先评，失败条目按尝试次数排队重试。
 *   A-3 `prefilter` 是死代码 → 两阶段评分在生产链路不存在，噪音全送 LLM。
 *       现在**先跑本地预筛**，判为噪音的直接标 `dropped` 不送 LLM（省预算且可解释）。
 *   B-2 无「认领」语义 → cron 与手动并发时同一批被评两次（双倍花费）。租约解决。
 *   A-1 补充：失败条目累计到上限（默认 3 次）后标 `dead`，避免无限重试烧钱。
 *
 * 抽出来的原因同 `lib/ingest.ts`：手动与定时必须走同一实现，否则口径会分叉。
 */

import { scoreMany } from "./llm.ts";
import { prefilterAll, type ScoreInput } from "./score.ts";
import type { ScoreRow, Store, StoredItem } from "./store.ts";

/** 单条条目最多尝试几次 LLM（超过则标 dead，不再重试） */
export const MAX_SCORE_ATTEMPTS = 3;

export type ScoreBatchOptions = {
  store: Store;
  env: { MAGPIE_BASE_URL?: string; MAGPIE_API_KEY?: string; MAGPIE_MODEL?: string };
  fetchImpl?: typeof fetch;
  /** 本批最多评几条（上限 30） */
  limit: number;
  model: string;
  promptVersion: string;
};

export type ScoreBatchResult = {
  /** 本地预筛直接丢弃（未花 LLM 调用） */
  dropped: number;
  /** 真实评分成功 */
  scored: number;
  /** 送 LLM 但失败（回到队列，累计尝试次数） */
  failed: number;
  /** 失败次数超限，标 dead */
  dead: number;
  /** 队列里是否还有待评条目 */
  pending: boolean;
  details: Array<{
    contentKey: string;
    title: string;
    ok: boolean;
    total?: number;
    reason?: string;
    error?: string;
    message?: string;
    prefilter?: string;
  }>;
};

/** 别名：测试与路由用 claimAndScore，语义「认领并评分一批」 */
export async function claimAndScore(opts: ScoreBatchOptions): Promise<ScoreBatchResult> {
  const limit = Math.max(1, Math.min(opts.limit, 30));

  // 认领一批（已按 attempts 升序 + 租约过滤）
  const claimed: StoredItem[] = await opts.store.claimForScoring(limit);
  if (claimed.length === 0) {
    return { dropped: 0, scored: 0, failed: 0, dead: 0, pending: false, details: [] };
  }

  const details: ScoreBatchResult["details"] = [];

  /* ── 阶段 1：本地预筛（审查 A-3 修复：这条以前是死代码）── */
  const inputs: ScoreInput[] = claimed.map((i) => ({
    title: i.title,
    summary: i.summary,
    sourceId: i.sourceId,
  }));
  const prefiltered = prefilterAll(inputs);

  const droppedKeys: string[] = [];
  const candidates: Array<{ item: StoredItem; input: ScoreInput }> = [];

  prefiltered.forEach((p, idx) => {
    const item = claimed[idx]!;
    if (!p.verdict.keep) {
      droppedKeys.push(item.contentKey);
      details.push({
        contentKey: item.contentKey,
        title: item.title,
        ok: false,
        prefilter: p.verdict.reason,
      });
    } else {
      candidates.push({ item, input: p.input });
    }
  });

  if (droppedKeys.length > 0) {
    await opts.store.markScored(
      droppedKeys.map((k) => ({ contentKey: k, state: "dropped" as const })),
    );
  }

  if (candidates.length === 0) {
    const pending = (await opts.store.queueStats()).pending > 0;
    return { dropped: droppedKeys.length, scored: 0, failed: 0, dead: 0, pending, details };
  }

  /* ── 阶段 2：LLM 打分（只对通过预筛的条目）── */
  const results = await scoreMany(
    opts.env,
    candidates.map((c) => c.input),
    { fetchImpl: opts.fetchImpl, concurrency: 2 },
  );

  const scoreRows: ScoreRow[] = [];
  const retryKeys: Array<{ contentKey: string; state: "pending"; error?: string }> = [];
  const deadKeys: string[] = [];

  results.forEach((r, idx) => {
    const { item } = candidates[idx]!;
    if (r.result.ok) {
      scoreRows.push({
        contentKey: item.contentKey,
        relevance: r.result.score.relevance,
        novelty: r.result.score.novelty,
        usefulness: r.result.score.usefulness,
        authority: r.result.score.authority,
        total: r.result.score.total,
        reason: r.result.score.reason,
        model: opts.model,
        promptVersion: opts.promptVersion,
      });
      details.push({
        contentKey: item.contentKey,
        title: item.title,
        ok: true,
        total: r.result.score.total,
        reason: r.result.score.reason,
      });
      return;
    }

    // 失败：按已有尝试次数决定「重试」还是「放弃」
    const attempts = (item as StoredItem & { scoreAttempts?: number }).scoreAttempts ?? 0;
    const willBeDead = attempts + 1 >= MAX_SCORE_ATTEMPTS;
    if (willBeDead) deadKeys.push(item.contentKey);
    else retryKeys.push({ contentKey: item.contentKey, state: "pending", error: r.result.error });

    details.push({
      contentKey: item.contentKey,
      title: item.title,
      ok: false,
      error: r.result.error,
      message: r.result.message,
    });
  });

  if (scoreRows.length > 0) await opts.store.saveScores(scoreRows);

  const marks: Array<{ contentKey: string; state: "scored" | "pending" | "dead"; error?: string }> = [
    ...scoreRows.map((r) => ({ contentKey: r.contentKey, state: "scored" as const })),
    ...retryKeys,
    ...deadKeys.map((k) => ({ contentKey: k, state: "dead" as const, error: "超过最大重试次数" })),
  ];
  if (marks.length > 0) await opts.store.markScored(marks);

  const stats = await opts.store.queueStats();
  return {
    dropped: droppedKeys.length,
    scored: scoreRows.length,
    failed: retryKeys.length,
    dead: deadKeys.length,
    pending: (stats.pending ?? 0) > 0,
    details,
  };
}