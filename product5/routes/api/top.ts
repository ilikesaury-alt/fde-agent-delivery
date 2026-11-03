/**
 * GET /api/top —— 读「精选」（达到阈值的评分条目，按总分倒序）
 *
 * 审查 A-10 修复：本接口**也应用单源配额**（D11）。
 * 此前只有日报走配额，而首页「精选」页签直接调本接口 → 页面上仍是 arxiv 刷屏，
 * 恰好是 D11 声称已解决的现象（`perSourceMaxOf` 被 import 但从未使用的痕迹就是证据）。
 *
 * 只读库，不触网。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveStore } from "../../lib/http.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TOP_N, perSourceMaxOf } from "../../lib/score.ts";
import type { RankedItem } from "../../lib/store.ts";

export { DEFAULT_THRESHOLD };

/** 阈值合法区间（与 /api/digest 同口径） */
const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 100;

/**
 * 单源配额（与 lib/digest.ts 的 selectWithQuota 同一套规则，但作用于 RankedItem）。
 * 为什么不复用 digest 的：那里作用于 DigestItem（无 contentKey），
 * 而接口需要返回带 key 的完整对象；规则本身只有 3 行，重复比转换更清晰。
 */
function applyQuota(
  items: RankedItem[],
  opts: { threshold: number; topN: number; perSourceMax: number },
): { kept: RankedItem[]; skippedByQuota: number } {
  const sorted = [...items]
    .filter((i) => i.total >= opts.threshold)
    .sort((a, b) => b.total - a.total || (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const kept: RankedItem[] = [];
  const perSource = new Map<string, number>();
  let skippedByQuota = 0;

  for (const item of sorted) {
    if (kept.length >= opts.topN) break;
    const used = perSource.get(item.sourceId) ?? 0;
    if (used >= opts.perSourceMax) {
      skippedByQuota++;
      continue;
    }
    perSource.set(item.sourceId, used + 1);
    kept.push(item);
  }
  return { kept, skippedByQuota };
}

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(200, { storage: "disabled", threshold: DEFAULT_THRESHOLD, items: [] });

  const thresholdRaw = c.req.query("threshold");
  let threshold = DEFAULT_THRESHOLD;
  if (thresholdRaw !== undefined && thresholdRaw !== "") {
    const n = Number(thresholdRaw);
    if (!Number.isFinite(n) || n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
      return jsonResponse(400, { error: `threshold 必须是 ${THRESHOLD_MIN}–${THRESHOLD_MAX} 的数字。` });
    }
    threshold = n;
  }

  const limit = intEnv(c.req.query("limit"), DEFAULT_TOP_N);
  const perSourceMax = perSourceMaxOf(limit);
  /** ?quota=0 可关闭配额（排查「全量最高分」时用） */
  const quotaOn = c.req.query("quota") !== "0";

  try {
    // ⚠️ 2026-11-03 修正：候选窗口从 3× 提到 10×。
    // 原实现只取 `limit * 3` 条候选再按配额过滤，导致：
    //   全库有 66 条 ≥70 分的条目，但候选只有 36 条 → 配额过滤后只能填到
    //   3 个源 × 4 条 = 12 条（即 topN 上限），其余高分条目根本没进候选池。
    // 现象就是「数据太少」——不是没数据，是候选窗口把数据挡在门外。
    // 10× 在 Free 套餐下仍只多一次 D1 查询（同一个 SELECT，只改 LIMIT），
    // 代价可忽略；而窗口越大，配额越能把不同源填进来。
    const candidates = await store.listTopScored({ threshold, limit: quotaOn ? limit * 10 : limit });

    const { kept, skippedByQuota } = quotaOn
      ? applyQuota(candidates, { threshold, topN: limit, perSourceMax })
      : { kept: candidates.slice(0, limit), skippedByQuota: 0 };

    return jsonResponse(200, {
      storage: "ok",
      threshold,
      count: kept.length,
      perSourceMax: quotaOn ? perSourceMax : null,
      skippedByQuota,
      items: kept,
    });
  } catch {
    return jsonResponse(200, {
      storage: "unavailable",
      threshold,
      items: [],
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});