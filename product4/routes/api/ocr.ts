/**
 * POST /api/ocr —— 单页扫描件识别（Workers AI 视觉模型）
 *
 * 请求体：{ image: string(dataURL 或纯 base64), page?: number }
 * 响应：  { ok: true, page, text, chars }
 *
 * 为什么一页一请求：单页图片几十~几百 KB，一次打包 5 页会顶到请求体上限；
 * 逐页失败只跳过该页（A4），整批失败会让用户连能识别的那几页也拿不到。
 *
 * 边界（写进交付文档）：识别结果是**未经校对的文本**，前端放回可编辑文本框，
 * 由人校对后再走抽取 → 人工确认 → 入库 —— 不自动入库。
 *
 * 状态码：401 令牌 · 400 图片/页号非法 · 422 未识别出文字 · 429 配额 · 502 上游 · 503 绑定缺失
 */

import { defineHandler } from "void";

import { ERR, OcrError } from "../../lib/errors.ts";
import { authorize, jsonResponse, resolveEnv, type RouteCtx } from "../../lib/http.ts";
import { DEFAULT_OCR_MODEL, MAX_OCR_PAGES, ocrPage, type AILike } from "../../lib/ocr.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const ctx = c as RouteCtx;
  const ai = ctx.env?.AI as AILike | undefined;
  if (!ai) return jsonResponse(503, { error: ERR.aiBindingMissing });

  let body: { image?: unknown; page?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badRequest });
  }

  const page = body.page === undefined ? 1 : Number(body.page);
  if (!Number.isFinite(page) || page < 1 || page > MAX_OCR_PAGES) {
    return jsonResponse(400, { error: `页号不合法（1–${MAX_OCR_PAGES}）。` });
  }

  const image = typeof body.image === "string" ? body.image : "";
  if (!image) return jsonResponse(400, { error: ERR.ocrBadImage });

  const model = resolveEnv(c).OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;

  try {
    const text = await ocrPage(ai, image, { model });
    return jsonResponse(200, { ok: true, page, text, chars: text.length });
  } catch (e) {
    if (e instanceof OcrError) {
      const status =
        e.code === "ocrQuota" ? 429
        : e.code === "ocrUpstream" ? 502
        : e.code === "ocrEmpty" ? 422
        : 400;
      if (e.code === "ocrUpstream") console.warn("[ocr] upstream failed");
      return jsonResponse(status, { error: e.message });
    }
    console.warn(`[ocr] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(502, { error: ERR.ocrUpstream });
  }
});