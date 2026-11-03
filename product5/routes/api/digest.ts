/**
 * GET  /api/digest —— 读日报（?date= / ?list=1）
 * POST /api/digest —— 立刻重生成当日日报（写接口，需令牌）
 *
 * 修复的审查发现：
 *   B-3 threshold/topN **无校验** → `?topN=abc` 使配额静默失效（NaN 比较恒 false）；
 *       `?topN=0` 或 `?threshold=999999` 生成空日报并**覆盖掉当日真实日报**，还返回 200。
 *       现在：参数走统一校验（非法即 400），且**覆盖前对比入选数，骤降则拒绝（409）**。
 *   B-1 写接口必须显式配置令牌（未配置 = 503），避免匿名覆盖日报。
 */

import { defineHandler } from "void";

import {
  authorize,
  intEnv,
  jsonResponse,
  resolveEnv,
  resolveStore,
} from "../../lib/http.ts";
import { generateDigest } from "../../lib/daily.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N } from "../../lib/score.ts";

/** 阈值合法区间：低于 0 无意义，高于 100 不可能有入选 */
const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 100;
/** 日报条数上限：再多也没人看，且会拖慢渲染 */
const TOPN_MIN = 1;
const TOPN_MAX = 50;

type Parsed = { ok: true; threshold: number; topN: number } | { ok: false; error: string };

/** 统一解析 threshold / topN（GET 与 POST 共用，审查 B-3 修复） */
export function parseDigestParams(
  thresholdRaw: string | undefined,
  topNRaw: string | undefined,
): Parsed {
  let threshold = DEFAULT_THRESHOLD;
  if (thresholdRaw !== undefined && thresholdRaw !== "") {
    const n = Number(thresholdRaw);
    if (!Number.isFinite(n) || n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
      return { ok: false, error: `threshold 必须是 ${THRESHOLD_MIN}–${THRESHOLD_MAX} 的数字。` };
    }
    threshold = n;
  }

  let topN = DEFAULT_TOP_N;
  if (topNRaw !== undefined && topNRaw !== "") {
    const n = Number(topNRaw);
    if (!Number.isInteger(n) || n < TOPN_MIN || n > TOPN_MAX) {
      return { ok: false, error: `topN 必须是 ${TOPN_MIN}–${TOPN_MAX} 的整数。` };
    }
    topN = n;
  }

  return { ok: true, threshold, topN };
}

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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonResponse(400, { error: "date 需为 YYYY-MM-DD。" });
      }
      const digest = await store.getDigest(date);
      return jsonResponse(digest ? 200 : 404, digest ? { storage: "ok", digest } : { error: "该日期没有日报。" });
    }

    const list = await store.listDigests(1);
    if (list.length === 0) {
      return jsonResponse(200, {
        storage: "ok",
        digest: null,
        message: "还没有生成过日报（每日 00:30 UTC 自动生成）。",
      });
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

export const POST = defineHandler(async (c) => {
  const env = resolveEnv(c);

  // 审查 B-1：写接口必须显式配置令牌
  if (!env.ACCESS_TOKEN) {
    return jsonResponse(503, {
      error: "写接口需要配置 ACCESS_TOKEN 后才可用（避免匿名覆盖日报）。",
    });
  }
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(503, { error: "存储未启用，无法生成日报（需要 D1）。" });

  // 审查 B-3：参数校验（GET 与 POST 共用）
  const parsed = parseDigestParams(c.req.query("threshold"), c.req.query("topN"));
  if (!parsed.ok) return jsonResponse(400, { error: parsed.error });

  try {
    const { record, stats } = await generateDigest({
      store,
      threshold: parsed.threshold,
      topN: parsed.topN,
      model: env.MAGPIE_MODEL || "deepseek-chat",
      promptVersion: SCORE_PROMPT_VERSION,
      source: "manual",
    });

    // 审查 B-3：覆盖写之前若入选数骤降（< 上次一半），返回警告而不是静默覆盖
    if (stats.shrinkWarning) {
      return jsonResponse(409, {
        error: "本次生成的日报入选数比上一次骤降一半以上，已拒绝覆盖。",
        hint: "确认无误后可带 ?force=1 重新生成。",
        previousSelected: record.previousSelected,
        currentSelected: stats.selected,
        stats,
      });
    }

    return jsonResponse(200, { storage: "ok", date: record.date, stats, digest: record });
  } catch {
    return jsonResponse(500, { error: "日报生成失败，请稍后重试。" });
  }
});

import { SCORE_PROMPT_VERSION } from "../../lib/score.ts";