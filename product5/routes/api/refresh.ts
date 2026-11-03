/**
 * POST /api/refresh —— **手动触发完整流程**：抓取 → 去重 → 评分 → 生成日报
 *
 * 2026-11-03 起，产品⑤ **取消了全部定时任务**（原 3 个 cron：抓取 :05 / 评分 :20 /
 * 日报 00:30）。原因：
 *   1. 定时抓取会把库堆成几百条待评，而评分只能每小时消化一批 → 队列永远追不上；
 *   2. 用户真正想要的是「点一下就看到今天的新内容」，而不是「等 cron 慢慢磨」；
 *   3. 抓取本身不花钱，但**评分花钱** —— 定时跑意味着每天固定烧掉一批额度，
 *      而用户可能根本没看。
 * 现在改为：**用户点按钮时，才抓、才评、才生成日报**，且一次跑完直接返回新日报。
 *
 * ── 一次请求内的外部 subrequest 预算（Workers Free：50/次）──
 *   抓取：14 个源 = 14 次
 *   评分：每条 1 次 LLM 调用
 *   → 评分上限 30（留余量给重试）。超出的留在队列，用户再点一次继续。
 *
 * ── 降级策略：每一步独立容错 ──
 *   抓取失败 → 直接报错（后面无从谈起）
 *   评分失败（LLM 网关挂）→ 抓取结果保留在队列，日报用**已有评分**生成，
 *                        响应里带 warning 告知用户
 *   日报失败 → 前面结果照常返回，带 warning
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveEnv, resolveFetchImpl, resolveStore } from "../../lib/http.ts";
import { generateDigest } from "../../lib/daily.ts";
import { ingestFeeds } from "../../lib/ingest.ts";
import { LLM_MESSAGES } from "../../lib/llm.ts";
import { claimAndScore } from "../../lib/queue.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, SCORE_PROMPT_VERSION } from "../../lib/score.ts";
import { DEFAULT_SOURCES } from "../../lib/sources.ts";

/** 单次请求的评分条数上限（外部 subrequest 预算：50 − 抓取 14 − 余量） */
const SCORE_BUDGET = 30;

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  // 写接口必须显式配置令牌（否则匿名可循环调用刷爆 LLM 额度）
  if (!env.ACCESS_TOKEN) {
    return jsonResponse(503, {
      error: "写接口需要配置 ACCESS_TOKEN 后才可用（避免匿名消耗 AI 额度）。",
    });
  }
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) {
    return jsonResponse(503, { error: "存储未启用，无法刷新（需要 D1）。" });
  }

  const fetchImpl = resolveFetchImpl(c);
  const startedAt = Date.now();
  const warnings: string[] = [];

  /* ── 阶段 1：抓取（14 个源 = 14 次外部 subrequest）── */
  const feed = await ingestFeeds({
    env: {
      FEED_MAX_ITEMS: env.FEED_MAX_ITEMS,
      FEED_TIMEOUT_MS: env.FEED_TIMEOUT_MS,
    },
    sources: DEFAULT_SOURCES,
    store,
    fetchImpl,
    maxItems: Number.parseInt(env.FEED_MAX_ITEMS ?? "15", 10) || 15,
    timeoutMs: Number.parseInt(env.FEED_TIMEOUT_MS ?? "12000", 10) || 12000,
    concurrency: 3,
  });

  /* ── 阶段 2：评分（含 L1/L2 去重，省下的就是省下的 LLM 调用）── */
  let score: Awaited<ReturnType<typeof claimAndScore>> | null = null;
  if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
    warnings.push("未配置 magpie 网关，已跳过评分（抓取结果已入库，可在配置后重新刷新）。");
  } else {
    try {
      score = await claimAndScore({
        store,
        env: {
          MAGPIE_BASE_URL: env.MAGPIE_BASE_URL,
          MAGPIE_API_KEY: env.MAGPIE_API_KEY,
          MAGPIE_MODEL: env.MAGPIE_MODEL,
        },
        fetchImpl,
        limit: intEnv(c.req.query("limit"), SCORE_BUDGET),
        model: env.MAGPIE_MODEL || "deepseek-chat",
        promptVersion: SCORE_PROMPT_VERSION,
      });
      if (score.failed > 0) {
        warnings.push(`${score.failed} 条评分失败（AI 网关可能不稳定），已保留在队列中，可再刷新一次重试。`);
      }
    } catch (err) {
      warnings.push(
        `评分阶段失败：${err instanceof Error ? err.message : "未知错误"}。抓取结果已入库，稍后可再刷新。`,
      );
    }
  }

  /* ── 阶段 3：生成日报（纯读库，不调 LLM）── */
  let digest: Awaited<ReturnType<typeof generateDigest>>["record"] | null = null;
  let digestStats: Awaited<ReturnType<typeof generateDigest>>["stats"] | null = null;
  try {
    const res = await generateDigest({
      store,
      threshold: DEFAULT_THRESHOLD,
      topN: DEFAULT_TOP_N,
      model: env.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: SCORE_PROMPT_VERSION,
      source: "manual",
    });
    digest = res.record;
    digestStats = res.stats;
  } catch (err) {
    warnings.push(
      `日报生成失败：${err instanceof Error ? err.message : "未知错误"}。抓取与评分结果已保存，可再刷新一次。`,
    );
  }

  const queue = await store.queueStats();

  return jsonResponse(200, {
    ok: true,
    elapsedMs: Date.now() - startedAt,
    feed: {
      fetched: feed.counts.fetched,
      kept: feed.counts.kept,
      deduped: feed.counts.deduped,
      inserted: feed.persisted?.inserted ?? 0,
      duplicates: feed.persisted?.duplicates ?? 0,
      failures: feed.failures.length,
      elapsedMs: feed.elapsedMs,
    },
    score: score
      ? {
          scored: score.scored,
          dropped: score.dropped,
          duplicated: score.duplicated,
          failed: score.failed,
          dead: score.dead,
          pending: score.pending,
        }
      : null,
    digest: digest
      ? {
          date: digest.date,
          counts: digest.counts,
          markdown: digest.markdown,
        }
      : null,
    queue,
    warnings,
  });
});
