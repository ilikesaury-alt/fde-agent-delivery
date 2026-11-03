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
import {
  clusterBySimilarity,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_HISTORY_LIMIT,
  findCrossBatchDuplicate,
  fingerprintOf,
} from "./dedup.ts";
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
  /** 被判定为重复而跳过（未花 LLM 调用） */
  duplicated: number;
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
    /** 重复判定说明（与哪条重复、依据是什么） */
    duplicateOf?: string;
  }>;
};

/** 别名：测试与路由用 claimAndScore，语义「认领并评分一批」 */
export async function claimAndScore(opts: ScoreBatchOptions): Promise<ScoreBatchResult> {
  // 上限 45：外部 subrequest 预算 50/次（Free 套餐），一批 N 条 = N 次 LLM 调用，
  // 留 5 个余量给 D1 查询与重试。2026-11-03 从 30 提到 45。
  const limit = Math.max(1, Math.min(opts.limit, 45));

  // 认领一批（已按 attempts 升序 + 租约过滤）
  const claimed: StoredItem[] = await opts.store.claimForScoring(limit);
  if (claimed.length === 0) {
    return {
      dropped: 0,
      duplicated: 0,
      scored: 0,
      failed: 0,
      dead: 0,
      pending: false,
      details: [],
    };
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
    return {
      dropped: droppedKeys.length,
      duplicated: 0,
      scored: 0,
      failed: 0,
      dead: 0,
      pending,
      details,
    };
  }

  /* ── 阶段 1.5：去重（2026-11-03 新增）──
   *
   * 为什么要这一步：同一个事件被多个源报道时，逐条评分是**纯浪费**
   * —— 每次调用都真花钱、都要等秒级响应，而结果必然是同一个事件的多个分数。
   * 实测（14 源真实数据）：一个批次里就有跨源重复（如 openai 与 hn 同时发
   * 「Scaling Git at OpenAI」），跨批次更多（openai 上午发、hn 下午转）。
   *
   * 两层判据（详见 lib/dedup.ts）：
   *   L1 同批次：归一化标题 + token Jaccard ≥ 0.55
   *   L1 跨批次：与最近 N 天**已评分**条目比（Jaccard ≥ 0.55）
   *   两层都带「数字签名」硬闸（版本号不同 → 绝不合并）
   *
   * 位置很关键：在**预筛之后、送 LLM 之前** —— 命中重复的条目一次调用都不花。
   */
  const dupMarks: Array<{ contentKey: string; state: "dropped"; error: string }> = [];
  const duplicateKeys = new Set<string>();

  // L1-a：同批次聚类（簇内只留代表）
  const clusterRes = clusterBySimilarity(
    candidates.map((c) => ({ contentKey: c.item.contentKey, title: c.item.title })),
  );
  // 代表 → 簇的映射（merged 下标 → 代表下标）
  const repOf = new Map<number, number>();
  for (const cluster of clusterRes.clusters) {
    for (const m of cluster.members) repOf.set(m, cluster.representative);
  }
  for (const mergedIdx of clusterRes.merged) {
    const c = candidates[mergedIdx]!;
    const repIdx = repOf.get(mergedIdx) ?? mergedIdx;
    const rep = candidates[repIdx]!;
    const cluster = clusterRes.clusters.find((cl) => cl.representative === repIdx);
    duplicateKeys.add(c.item.contentKey);
    dupMarks.push({
      contentKey: c.item.contentKey,
      state: "dropped",
      error: `与《${rep.item.title.slice(0, 60)}》重复（${cluster?.reason ?? "同一事件"}）`,
    });
    details.push({
      contentKey: c.item.contentKey,
      title: c.item.title,
      ok: false,
      duplicateOf: rep.item.title.slice(0, 120),
    });
  }

  // L1-b：跨批次（与最近已评分条目比）
  let history: Array<{ contentKey: string; title: string }> = [];
  try {
    history = await opts.store.listRecentScoredTitles({
      days: DEFAULT_HISTORY_DAYS,
      limit: DEFAULT_HISTORY_LIMIT,
    });
  } catch {
    // 历史读不到 → 跳过跨批次去重（宁可多评一次，也不因存储问题丢条目）
    history = [];
  }
  if (history.length > 0) {
    candidates.forEach((c, idx) => {
      if (duplicateKeys.has(c.item.contentKey)) return;
      const hit = findCrossBatchDuplicate(fingerprintOf(c.item.title), history);
      if (!hit) return;
      duplicateKeys.add(c.item.contentKey);
      dupMarks.push({
        contentKey: c.item.contentKey,
        state: "dropped",
        error: `${hit.reason}：《${hit.title.slice(0, 60)}》`,
      });
      details.push({
        contentKey: c.item.contentKey,
        title: c.item.title,
        ok: false,
        duplicateOf: hit.title.slice(0, 120),
      });
    });
  }

  const toScore = candidates.filter((c) => !duplicateKeys.has(c.item.contentKey));
  const duplicated = duplicateKeys.size;

  if (dupMarks.length > 0) {
    await opts.store.markScored(
      dupMarks.map((m) => ({ contentKey: m.contentKey, state: m.state, error: m.error })),
    );
  }

  if (toScore.length === 0) {
    const pending = (await opts.store.queueStats()).pending > 0;
    return {
      dropped: droppedKeys.length,
      duplicated,
      scored: 0,
      failed: 0,
      dead: 0,
      pending,
      details,
    };
  }

  /* ── 阶段 2：LLM 打分（只对通过预筛的条目）── */
  // 并发 2 → 5（2026-11-03）：Workers 同时等待响应的连接上限是 6，
  // 并发 2 让 30 条的批要跑 15 轮；5 并发只需 6 轮，直接决定队列消化速度。
  const results = await scoreMany(
    opts.env,
    toScore.map((c) => c.input),
    { fetchImpl: opts.fetchImpl, concurrency: 5 },
  );

  const scoreRows: ScoreRow[] = [];
  const retryKeys: Array<{ contentKey: string; state: "pending"; error?: string }> = [];
  const deadKeys: string[] = [];

  results.forEach((r, idx) => {
    const { item } = toScore[idx]!;
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
    duplicated,
    scored: scoreRows.length,
    failed: retryKeys.length,
    dead: deadKeys.length,
    pending: (stats.pending ?? 0) > 0,
    details,
  };
}