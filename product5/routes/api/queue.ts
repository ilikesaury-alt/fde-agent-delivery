/**
 * GET /api/queue —— 评分队列状态（运维可见性）
 *
 * 审查 A-1 的配套：评分队列改为状态机（pending/scored/dropped/dead）后，
 * 必须有一个接口能看出「还有多少条没评、多少条被预筛丢弃、多少条彻底失败」——
 * 否则队列静默积压时没人知道（这正是审查发现的原始问题：饿死且不可见）。
 *
 * 也用于观测 cron 是否在跑：pending 数持续下降 = 评分 cron 在工作。
 */

import { defineHandler } from "void";

import { authorize, jsonResponse, resolveStore } from "../../lib/http.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(200, { storage: "disabled", states: {} });

  try {
    const states = await store.queueStats();
    const total = Object.values(states).reduce((a, b) => a + b, 0);
    return jsonResponse(200, {
      storage: "ok",
      total,
      states,
      /** pending 数持续下降 = 评分 cron 在正常工作 */
      pending: states.pending ?? 0,
      scored: states.scored ?? 0,
      dropped: states.dropped ?? 0,
      dead: states.dead ?? 0,
    });
  } catch {
    return jsonResponse(200, {
      storage: "unavailable",
      states: {},
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});