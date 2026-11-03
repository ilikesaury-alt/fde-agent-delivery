/**
 * Cron：评分（每小时 :20，UTC）
 *
 * 走 `lib/queue.ts`（与 POST /api/score 共用），修复审查发现：
 *   A-1 旧条目饿死 → claimForScoring 按 attempts 升序 + 租约认领
 *   A-3 预筛死代码 → 先跑本地预筛，噪音不送 LLM
 *   B-2 并发重复评分 → 租约保证 cron 与手动不拿同一批
 *   失败累计 3 次 → 标 dead，不再无限重试烧钱
 *
 * 每批默认 30 条（2026-11-03 从 10 提到 30）。
 *
 * 为什么提到 30：
 *   ① 外部 subrequest 预算：Workers Free 每次 invocation **50 个**。一批 30 条
 *      = 30 次 LLM 调用 + 少量 D1 查询（batch 计 1 次），仍在预算内。
 *   ② 队列消化速度：抓取每小时入库 ~200 条，而原来每小时只评 10 条 → 队列只增不减
 *      （线上实测 pending 394 条）。30 条/小时仍不够（但配合 14 源扩量后需重估），
 *      真正堵点在「并发 2 太慢」，故并发同时提到 5（Workers 同时等待响应的连接上限 6）。
 *   ③ Cron 墙钟 15 分钟：30 条 / 并发 5 × 单条约 3-5s ≈ 30s，远在预算内。
 *
 * ⚠️ 若调大 SCORE_BATCH，注意别超过 45（50 上限留 5 个余量给 D1 与重试）。
 */

import { defineScheduled } from "void";

import { claimAndScore } from "../lib/queue.ts";
import { SCORE_PROMPT_VERSION } from "../lib/score.ts";
import { createD1Store, type D1Like } from "../lib/store.ts";

export const cron = "20 * * * *";

export default defineScheduled(async (_controller, env) => {
  const e = env as unknown as {
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

  const batch = Math.min(Number.parseInt(e.SCORE_BATCH ?? "30", 10) || 30, 45);

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