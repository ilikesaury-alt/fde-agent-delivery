/**
 * POST /api/score —— 给「未评分」条目批量打分（增量 3）
 *
 * 语义：
 *   - 输入取自**已落库**的未评分条目（`listUnscored`），不重新抓源（抓取与评分是两个预算）
 *   - `?limit=10`（默认 10，上限 30）：每次调用只花这么多 LLM 调用 → Free 套餐可承受
 *   - 每条独立失败（模型超时/越界/不可解析），失败的**不写库**（保持「未评分」状态，下轮再试）
 *   - 返回逐条结果摘要，便于人工复核「哪条没评上、为什么」
 *
 * 为什么不做成 Cron 一次全量：一次 180 条 × LLM 调用会撞 subrequest 上限（50/次），
 * 而且失败面更大。批量化 + 幂等重试更稳（D9 / A9）。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveEnv, resolveFetchImpl, resolveStore } from "../../lib/http.ts";
import { LLM_MESSAGES, scoreMany } from "../../lib/llm.ts";
import { SCORE_PROMPT_VERSION, type ScoreInput } from "../../lib/score.ts";
import type { ScoreRow } from "../../lib/store.ts";

/** prompt 版本：与 cron / eval 共用同一常量（改 prompt 必须同步） */
export const PROMPT_VERSION = SCORE_PROMPT_VERSION;

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) {
    return jsonResponse(503, { error: "存储未启用，无法批量评分（需要 D1）。" });
  }

  const env = resolveEnv(c);
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    return jsonResponse(503, { error: LLM_MESSAGES.not_configured });
  }

  const limit = Math.min(intEnv(c.req.query("limit"), 10), 30);
  const unscored = await store.listUnscored(limit);
  if (unscored.length === 0) {
    return jsonResponse(200, { scored: 0, failed: 0, pending: 0, items: [] });
  }

  const inputs: ScoreInput[] = unscored.map((i) => ({
    title: i.title,
    summary: i.summary,
    sourceId: i.sourceId,
  }));

  const results = await scoreMany(env, inputs, { fetchImpl: resolveFetchImpl(c), concurrency: 2 });

  const rows: ScoreRow[] = [];
  const details: Array<{
    contentKey: string;
    title: string;
    ok: boolean;
    total?: number;
    reason?: string;
    error?: string;
    message?: string;
  }> = [];

  results.forEach((r, idx) => {
    const item = unscored[idx]!;
    if (r.result.ok) {
      rows.push({
        contentKey: item.contentKey,
        relevance: r.result.score.relevance,
        novelty: r.result.score.novelty,
        usefulness: r.result.score.usefulness,
        authority: r.result.score.authority,
        total: r.result.score.total,
        reason: r.result.score.reason,
        model: env.MAGPIE_MODEL || "deepseek-chat",
        promptVersion: PROMPT_VERSION,
      });
      details.push({
        contentKey: item.contentKey,
        title: item.title,
        ok: true,
        total: r.result.score.total,
        reason: r.result.score.reason,
      });
    } else {
      details.push({
        contentKey: item.contentKey,
        title: item.title,
        ok: false,
        error: r.result.error,
        message: r.result.message,
      });
    }
  });

  const written = rows.length > 0 ? await store.saveScores(rows) : 0;

  // 「还剩多少条没评」也返回：调用方据此决定要不要再跑一批
  const stillUnscored = (await store.listUnscored(1)).length > 0;

  return jsonResponse(200, {
    scored: written,
    failed: details.length - written,
    pending: stillUnscored,
    promptVersion: PROMPT_VERSION,
    model: env.MAGPIE_MODEL || "deepseek-chat",
    items: details,
  });
});