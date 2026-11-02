/**
 * GET /api/top —— 读「精选」（达到阈值的评分条目，按总分倒序）
 *
 * 阈值来自 query（`?threshold=60&limit=20`），默认取 CONTEXT 标定值 60（见 eval 报告）。
 * 只读库，不触网。
 */

import { defineHandler } from "void";

import { authorize, intEnv, jsonResponse, resolveStore } from "../../lib/http.ts";

/**
 * 默认阈值：**由评测集实测标定**，不是拍脑袋。
 * 2026-11-02 标定（50 条标签 / 60 条真实评分 / prompt=score-v1 / auto/minimax-m3.1-flash）：
 *   threshold=70 → Precision 100.0% / Recall 77.3% / 漏选 22.7% / F1 0.872（扫描中 F1 最高）
 * 详见 eval/report.md。改模型或改 prompt 后必须重跑 `npm run eval` 并更新此常量。
 */
export const DEFAULT_THRESHOLD = 70;

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const store = resolveStore(c);
  if (!store) return jsonResponse(200, { storage: "disabled", threshold: DEFAULT_THRESHOLD, items: [] });

  const thresholdRaw = c.req.query("threshold");
  const threshold = thresholdRaw ? Number.parseFloat(thresholdRaw) : DEFAULT_THRESHOLD;
  const limit = intEnv(c.req.query("limit"), 20);

  try {
    const items = await store.listTopScored({
      threshold: Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD,
      limit,
    });
    return jsonResponse(200, {
      storage: "ok",
      threshold: Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD,
      count: items.length,
      items,
    });
  } catch {
    return jsonResponse(200, {
      storage: "unavailable",
      threshold: DEFAULT_THRESHOLD,
      items: [],
      message: "存储暂不可用（表可能尚未初始化）。",
    });
  }
});