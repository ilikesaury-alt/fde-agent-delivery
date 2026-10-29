/**
 * /api/reports —— 报告管理与确认入库
 *
 *   GET    /api/reports            列表（按检测日期倒序，不含原文全文）
 *   GET    /api/reports?id=<id>    详情（含原文 + 全部指标）
 *   POST   /api/reports            确认入库（人工确认闸之后）
 *   DELETE /api/reports?id=<id>    删除（指标一并删除）
 *
 * POST 请求体：
 *   { checkDate, hospital?, rawText, sourceType, fileName?, metrics: RawMetric[] }
 *   其中 RawMetric = { rawName|raw_name, valueText|value_text, unit?, refText|ref_text, sourceQuote? }
 *
 * ⭐ 安全要点：POST **不接受客户端算好的** valueNum/refLow/refHigh/status，
 *   一律用 lib/extract.ts#toExtractedMetric 在服务端重算。前端只是把预览里勾选的行带回来，
 *   计算权始终在服务端（否则「人工确认闸」可以被绕过 —— 改个 status 就入库了）。
 *
 * 状态码：401 / 400 / 404 / 502
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { toExtractedMetric, normalizeDate } from "../../lib/extract.ts";
import {
  authorize,
  asString,
  jsonResponse,
  MAX_STORED_RAW_CHARS,
  resolveRepo,
  type RouteCtx,
} from "../../lib/http.ts";
import { saveReport } from "../../lib/service.ts";
import type { ExtractedMetric, ReportSource } from "../../lib/types.ts";

const VALID_SOURCES: ReportSource[] = ["pdf", "ocr", "manual"];

function parseMetrics(raw: unknown): ExtractedMetric[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedMetric[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const m = toExtractedMetric(item as Record<string, unknown>);
    if (m) out.push(m);
  }
  return out;
}

export const GET = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const repo = resolveRepo(c);
  const id = new URL(c.req.url, "http://local").searchParams.get("id");

  try {
    if (id) {
      const report = await repo.getReport(id);
      if (!report) return jsonResponse(404, { error: ERR.notFound });
      const metrics = await repo.listMetricsByReport(id);
      return jsonResponse(200, { ok: true, report, metrics });
    }
    const reports = await repo.listReports(200);
    return jsonResponse(200, { ok: true, reports });
  } catch (e) {
    console.warn(`[reports] GET failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: ERR.badRequest });
  }
});

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

  const rawText = asString(body.rawText) ?? asString(body.raw_text);
  if (!rawText) return jsonResponse(400, { error: ERR.emptyText });
  // 原文上限：入库接口不限长的话，超大 blob 会进库并在解读时被反复读取
  if (rawText.length > MAX_STORED_RAW_CHARS) {
    return jsonResponse(413, {
      error: `报告原文过长（上限 ${MAX_STORED_RAW_CHARS} 字符，当前 ${rawText.length}），请精简后重试。`,
    });
  }

  const sourceType = (asString(body.sourceType) ?? "pdf") as ReportSource;
  if (!VALID_SOURCES.includes(sourceType)) return jsonResponse(400, { error: ERR.badRequest });

  const metrics = parseMetrics(body.metrics);
  if (metrics.length === 0) {
    return jsonResponse(400, { error: "没有可入库的指标：请至少确认一条包含名称与结果的指标。" });
  }

  try {
    const saved = await saveReport(resolveRepo(c), {
      sourceType,
      fileName: asString(body.fileName) ?? null,
      checkDate,
      hospital: asString(body.hospital) ?? null,
      rawText,
      metrics,
    });
    return jsonResponse(201, { ok: true, report: saved.report, metrics: saved.metrics });
  } catch (e) {
    console.warn(`[reports] POST failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: "入库失败，请稍后重试。" });
  }
});

export const DELETE = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const id = new URL(c.req.url, "http://local").searchParams.get("id");
  if (!id) return jsonResponse(400, { error: ERR.badRequest });

  try {
    const ok = await resolveRepo(c).deleteReport(id);
    if (!ok) return jsonResponse(404, { error: ERR.notFound });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    console.warn(`[reports] DELETE failed: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(500, { error: "删除失败，请稍后重试。" });
  }
});