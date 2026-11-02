/**
 * GET /api/digest —— 读日报
 *   ?date=2026-11-02  指定日期
 *   缺省：最近一份
 *   ?list=1           只列日报索引（不拉全文）
 *
 * 只读库、不触网。日报由 cron/digest.ts 每天生成并落库。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveEnv, resolveStore } from "../../lib/http.ts";
import { generateDigest } from "../../lib/daily.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, SCORE_PROMPT_VERSION } from "../../lib/score.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(200, { storage: "disabled", list: [], digest: null });

  const listMode = c.req.query("list");
  const date = c.req.query("date");

  try {
    if (listMode) {
      const list = await store.listDigests(intEnv(c.req.query("limit"), 20));
      return jsonResponse(200, { storage: "ok", list });
    }

    if (date) {
      const digest = await store.getDigest(date);
      return jsonResponse(digest ? 200 : 404, digest ? { storage: "ok", digest } : { error: "该日期没有日报。" });
    }

    const list = await store.listDigests(1);
    if (list.length === 0) {
      return jsonResponse(200, { storage: "ok", digest: null, message: "还没有生成过日报（每日 00:30 UTC 自动生成）。" });
    }
    const digest = await store.getDigest(list[0]!.date);
    return jsonResponse(200, { storage: "ok", digest });
  } catch {
    return jsonResponse(200, {
      storage: "unavailable",
      list: [],
      digest: null,
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});

/**
 * POST /api/digest —— 立刻重生成当日日报（运维/验收用，需要令牌）
 *
 * 存在理由：Cron 每天只跑一次，验收时不能等到明天；而「等它自己跑」也不该是验证手段。
 * 与 cron 共用 lib/daily.ts，所以手动看到的结果与次日自动生成一致。
 *
 * ⚠️ 会覆盖当日已生成的日报（日报语义就是"当日最新结论"）。
 */
export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(503, { error: "存储未启用，无法生成日报（需要 D1）。" });

  const env = resolveEnv(c);
  const thresholdRaw = c.req.query("threshold");
  const topNRaw = c.req.query("topN");

  try {
    const { record, stats } = await generateDigest({
      store,
      threshold: thresholdRaw ? Number.parseFloat(thresholdRaw) : DEFAULT_THRESHOLD,
      topN: topNRaw ? Number.parseInt(topNRaw, 10) : DEFAULT_TOP_N,
      model: env.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: SCORE_PROMPT_VERSION,
    });
    return jsonResponse(200, { storage: "ok", date: record.date, stats, digest: record });
  } catch {
    return jsonResponse(500, { error: "日报生成失败，请稍后重试。" });
  }
});
