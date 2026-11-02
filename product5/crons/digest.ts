/**
 * Cron：生成日报（每天 00:30 UTC ≈ 北京时间 08:30）
 *
 * 只读库（scores + items + sources），不触网、不调 LLM —— CPU 极省，适合 Free 套餐。
 * 同一天重跑 = 覆盖；手动重跑走 POST /api/digest，与这里同一实现（lib/daily.ts）。
 */

import { defineScheduled } from "void";

import { generateDigest } from "../lib/daily.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, SCORE_PROMPT_VERSION } from "../lib/score.ts";
import { createD1Store, type D1Like } from "../lib/store.ts";

export const cron = "30 0 * * *";

export default defineScheduled(async (_controller, env) => {
  const e = env as {
    DB?: D1Like;
    DIGEST_THRESHOLD?: string;
    DIGEST_TOP_N?: string;
    MAGPIE_MODEL?: string;
  };

  if (!e.DB) {
    console.warn("[cron:digest] 缺少 DB 绑定，跳过");
    return;
  }

  const threshold = Number.parseFloat(e.DIGEST_THRESHOLD ?? "") || DEFAULT_THRESHOLD;
  const topN = Number.parseInt(e.DIGEST_TOP_N ?? "", 10) || DEFAULT_TOP_N;

  const { record, stats } = await generateDigest({
    store: createD1Store(e.DB),
    threshold,
    topN,
    model: e.MAGPIE_MODEL || "deepseek-chat",
    promptVersion: SCORE_PROMPT_VERSION,
  });

  console.log(
    `[cron:digest] ${record.date} 入库：过阈值 ${stats.aboveThreshold} / 入选 ${stats.selected} / 配额让位 ${stats.skippedQuota}`,
  );
});