/**
 * Cron：评分（每小时 :20，UTC）
 *
 * 走 `lib/queue.ts`（与 POST /api/score 共用），修复审查发现：
 *   A-1 旧条目饿死 → claimForScoring 按 attempts 升序 + 租约认领
 *   A-3 预筛死代码 → 先跑本地预筛，噪音不送 LLM
 *   B-2 并发重复评分 → 租约保证 cron 与手动不拿同一批
 *   失败累计 3 次 → 标 dead，不再无限重试烧钱
 *
 * 每批默认 10 条（Free 套餐 subrequest 50/次 是硬预算，每条评分 = 1 次 LLM 调用）。
 */

import { defineScheduled } from "void";

import { claimAndScore } from "../lib/queue.ts";
import { SCORE_PROMPT_VERSION } from "../lib/score.ts";
import { createD1Store, type D1Like } from "../lib/store.ts";

export const cron = "20 * * * *";

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

  const batch = Math.min(Number.parseInt(e.SCORE_BATCH ?? "10", 10) || 10, 30);

  // 审查 B-6：cron 入口必须包 try/catch —— 否则缺表/迁移未应用时静默失败，无人知道
  try {
    const result = await claimAndScore({
      store: createD1Store(e.DB),
      env: { MAGPIE_BASE_URL: e.MAGPIE_BASE_URL, MAGPIE_API_KEY: e.MAGPIE_API_KEY, MAGPIE_MODEL: e.MAGPIE_MODEL },
      limit: batch,
      model: e.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: SCORE_PROMPT_VERSION,
    });
    console.log(
      `[cron:score] 预筛丢弃 ${result.dropped} / 评分成功 ${result.scored} / ` +
        `失败待重试 ${result.failed} / 放弃 ${result.dead} / 队列仍有 ${result.pending ? "待评" : "空"}`,
    );
  } catch (err) {
    console.error(`[cron:score] 失败：${err instanceof Error ? err.message : String(err)}`);
    throw err; // 让 Cloudflare 记录为失败，而不是静默成功
  }
});