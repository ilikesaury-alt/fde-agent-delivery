/**
 * POST /api/metrics —— 手工补录指标（CONTEXT D2 路径③）
 *
 * 请求体：{ checkDate, hospital?, metrics: RawMetric[] }
 *   RawMetric = { rawName, valueText, unit?, refText?, sourceQuote? }
 *
 * 语义：手工补录属于「一次检测」，按 (检测日期, 手工报告) 复用同一份报告并合并指标 ——
 * 这样趋势、异常判定与从报告导入的数据完全同构，不需要给手工数据走特殊分支。
 *
 * 与 /api/reports 一样：**计算在服务端**（不接受客户端算好的 status/数值）。
 */

import { defineHandler } from "void";

import { ERR, ExtractError } from "../../lib/errors.ts";
import { normalizeDate, toExtractedMetric } from "../../lib/extract.ts";
import { authorize, asString, jsonResponse, resolveRepo } from "../../lib/http.ts";
import { saveManualMetrics } from "../../lib/service.ts";
import type { ExtractedMetric } from "../../lib/types.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: ERR.badRequest });
  }

  const checkDate = normalizeDate(body.checkDate ?? body.check_date);
  if (!checkDate) return jsonResponse(400, { error: "检测日期不合法（需要 YYYY-MM-DD）。" });

  const raw = body.metrics;
  if (!Array.isArray(raw) || raw.length === 0) {
    return jsonResponse(400, { error: "请至少填写一项指标（名称与结果）。" });
  }

  const metrics: ExtractedMetric[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const m = toExtractedMetric(item as Record<string, unknown>);
    if (m) metrics.push(m);
  }
  if (metrics.length === 0) {
    return jsonResponse(400, { error: "指标名称或结果为空，无法保存。" });
  }

  try {
    const saved = await saveManualMetrics(resolveRepo(c), checkDate, metrics);
    return jsonResponse(201, { ok: true, report: saved.report, metrics: saved.metrics });
  } catch (e) {
    if (e instanceof ExtractError) return jsonResponse(400, { error: e.message });
    console.warn(`[metrics] failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: "保存失败，请稍后重试。" });
  }
});