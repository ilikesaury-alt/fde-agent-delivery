/**
 * GET /api/trends —— 指标趋势序列
 *
 * 响应：{ ok, series: TrendSeries[] }
 * series 只含**可绘制**的点（valueNum 非空）；定性值（阴性）不成点、不插值。
 * refChanged=true 表示该指标跨次参考范围变过 —— 前端必须可见（CONTEXT D4）。
 */

import { defineHandler } from "void";

import { ACTIVE_PROFILE, authorize, jsonResponse, resolveRepo } from "../../lib/http.ts";
import { buildTrend } from "../../lib/trend.ts";

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  try {
    const inputs = await resolveRepo(c).listTrendInputs(ACTIVE_PROFILE);
    return jsonResponse(200, { ok: true, series: buildTrend(inputs), count: inputs.length });
  } catch (e) {
    console.warn(`[trends] failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: "读取趋势数据失败。" });
  }
});