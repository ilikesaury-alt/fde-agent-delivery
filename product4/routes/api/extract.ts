/**
 * POST /api/extract —— 报告文本 → 结构化指标**预览**（不落库）
 *
 * 为什么必须分「预览」与「入库」两步（CONTEXT 方案 A：人工确认闸）：
 *   抽取错误在健康数据上是事故级后果。预览把「模型看到的指标 + 原文片段」摆给人看，
 *   人勾选确认后才入库 —— 这是本产品与「一键自动入库」的根本区别。
 *
 * 请求体：{ text: string, sourceType?: "pdf"|"ocr"|"manual", fileName?: string }
 * 响应：  { ok: true, checkDate, hospital, metrics: [...], chars, retries }
 *
 * 状态码：401 令牌 · 400 请求非法/文本过长 · 502 上游失败 · 500 未配置
 */

import { defineHandler } from "void";

import { ERR, ExtractError } from "../../lib/errors.ts";
import { DEFAULT_EXTRACT_RETRY, DEFAULT_MAX_REPORT_CHARS, extractReport } from "../../lib/extract.ts";
import { authorize, asString, envInt, jsonResponse, resolveEnv, type RouteCtx } from "../../lib/http.ts";
import { MissingConfigError, LLMError } from "../../lib/llm.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  let body: { text?: unknown; sourceType?: unknown; fileName?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badRequest });
  }

  const text = typeof body.text === "string" ? body.text : "";
  const sourceType = asString(body.sourceType);
  const fileName = asString(body.fileName) ?? null;
  if (sourceType && !["pdf", "ocr", "manual"].includes(sourceType)) {
    return jsonResponse(400, { error: ERR.badRequest });
  }

  const env = resolveEnv(c);
  const ctx = c as RouteCtx;
  const maxChars = envInt(env.MAX_REPORT_CHARS, DEFAULT_MAX_REPORT_CHARS, 1000, 200_000);
  const retry = envInt(env.EXTRACT_RETRY, DEFAULT_EXTRACT_RETRY, 0, 3);

  try {
    const extracted = await extractReport(env, text, {
      fetchImpl: ctx._fetchImpl,
      maxChars,
      retry,
    });
    return jsonResponse(200, {
      ok: true,
      checkDate: extracted.checkDate,
      hospital: extracted.hospital,
      metrics: extracted.metrics,
      chars: text.length,
      // 回传来源与文件名，入库时原样带回（避免前端自造）
      sourceType: sourceType ?? "pdf",
      fileName,
    });
  } catch (e) {
    if (e instanceof ExtractError) {
      const status =
        e.code === "emptyText" || e.code === "tooLong" ? 400
        : e.code === "noMetrics" ? 422
        : 502;
      return jsonResponse(status, { error: e.message });
    }
    if (e instanceof MissingConfigError) {
      return jsonResponse(500, { error: "AI 服务未配置，无法解析报告。" });
    }
    if (e instanceof LLMError) {
      return jsonResponse(502, { error: ERR.extractFailed });
    }
    console.warn(`[extract] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(502, { error: ERR.extractFailed });
  }
});