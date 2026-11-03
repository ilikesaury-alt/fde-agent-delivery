/**
 * POST /api/score —— 手动触发一批评分（cron 与这里共用 lib/queue.ts）
 *
 * 审查 B-1/B-2 修复：
 *   - 未配置 ACCESS_TOKEN 时，**写接口一律拒绝**（503），不再"配置了才生效"
 *     —— 否则匿名可循环调用刷爆 LLM 额度，并把队列打空使 cron 永远"队列为空"
 *   - 租约认领：与 cron 并发时不会重复评同一批
 *   - 先跑本地预筛：噪音不花 LLM 调用
 *
 * ⚠️ 本接口会消耗 LLM 额度，因此即使配了令牌也建议只给自己用。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveEnv, resolveFetchImpl, resolveStore } from "../../lib/http.ts";
import { LLM_MESSAGES } from "../../lib/llm.ts";
import { claimAndScore } from "../../lib/queue.ts";
import { SCORE_PROMPT_VERSION } from "../../lib/score.ts";

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  // 审查 B-1：写接口必须显式配置令牌才放行（未配置 = 503，而不是公开可打）
  if (!env.ACCESS_TOKEN) {
    return jsonResponse(503, {
      error: "写接口需要配置 ACCESS_TOKEN 后才可用（避免匿名消耗 AI 额度）。",
    });
  }

  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) {
    return jsonResponse(503, { error: "存储未启用，无法批量评分（需要 D1）。" });
  }
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    return jsonResponse(503, { error: LLM_MESSAGES.not_configured });
  }

  const limit = intEnv(c.req.query("limit"), 10);

  try {
    const result = await claimAndScore({
      store,
      env: {
        MAGPIE_BASE_URL: env.MAGPIE_BASE_URL,
        MAGPIE_API_KEY: env.MAGPIE_API_KEY,
        MAGPIE_MODEL: env.MAGPIE_MODEL,
      },
      fetchImpl: resolveFetchImpl(c),
      limit,
      model: env.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: SCORE_PROMPT_VERSION,
    });

    return jsonResponse(200, {
      promptVersion: SCORE_PROMPT_VERSION,
      model: env.MAGPIE_MODEL || "deepseek-chat",
      ...result,
    });
  } catch {
    return jsonResponse(500, { error: "评分批次失败，请稍后重试。" });
  }
});