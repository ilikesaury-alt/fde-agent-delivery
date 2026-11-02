/**
 * Cron：评分（每小时 :20，UTC）
 *
 * 每次只评一批（默认 10 条，上限 20）：Free 套餐 subrequest 50/次 是硬预算，
 * 而每条评分 = 1 次 LLM 调用 + 写入。
 * 失败条目保持「未评分」，下一轮自动重试 —— 天然幂等补偿，不需要额外重试逻辑。
 */

import { defineScheduled } from "void";

import { scoreMany } from "../lib/llm.ts";
import { createD1Store, type D1Like, type StoreBase } from "../lib/store.ts";
import type { ScoreRow } from "../lib/store.ts";
import { SCORE_PROMPT_VERSION } from "../lib/score.ts";

export const cron = "20 * * * *";

/** 与 routes/api/score.ts 共用同一个版本常量（改 prompt 必须两处同步） */
const PROMPT_VERSION = SCORE_PROMPT_VERSION;

export default defineScheduled(async (_controller, env) => {
  const e = env as {
    DB?: D1Like;
    MAGPIE_BASE_URL?: string;
    MAGPIE_API_KEY?: string;
    MAGPIE_MODEL?: string;
    SCORE_BATCH?: string;
  };

  if (!e.DB) {
    console.warn("[cron:score] 缺少 DB 绑定，跳过");
    return;
  }
  if (!e.MAGPIE_BASE_URL || !e.MAGPIE_API_KEY) {
    console.warn("[cron:score] magpie 未配置，跳过评分");
    return;
  }

  const store: StoreBase & Pick<ReturnType<typeof createD1Store>, "listUnscored" | "saveScores"> =
    createD1Store(e.DB);

  const batch = Math.min(Number.parseInt(e.SCORE_BATCH ?? "10", 10) || 10, 20);
  const unscored = await store.listUnscored(batch);
  if (unscored.length === 0) {
    console.log("[cron:score] 队列为空");
    return;
  }

  const results = await scoreMany(
    { MAGPIE_BASE_URL: e.MAGPIE_BASE_URL, MAGPIE_API_KEY: e.MAGPIE_API_KEY, MAGPIE_MODEL: e.MAGPIE_MODEL },
    unscored.map((i) => ({ title: i.title, summary: i.summary, sourceId: i.sourceId })),
    { concurrency: 2 },
  );

  const rows: ScoreRow[] = [];
  let failed = 0;
  results.forEach((r, idx) => {
    const item = unscored[idx]!;
    if (!r.result.ok) {
      failed++;
      return;
    }
    rows.push({
      contentKey: item.contentKey,
      relevance: r.result.score.relevance,
      novelty: r.result.score.novelty,
      usefulness: r.result.score.usefulness,
      authority: r.result.score.authority,
      total: r.result.score.total,
      reason: r.result.score.reason,
      model: e.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: PROMPT_VERSION,
    });
  });

  if (rows.length > 0) await store.saveScores(rows);
  console.log(`[cron:score] 批次 ${unscored.length} · 成功 ${rows.length} · 失败 ${failed}`);
});