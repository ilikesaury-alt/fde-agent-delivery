/**
 * POST /api/ocr —— 单页扫描件识别（Workers AI 视觉模型）
 *
 * 请求体：{ image: string(dataURL 或纯 base64), page?: number }
 * 响应：  { ok: true, page, text, chars }
 *
 * 为什么是「一页一请求」而不是整份 PDF 一次：
 *   ① 单页图片几十~几百 KB，一次打包 5 页会顶到请求体上限；
 *   ② 逐页失败只跳过该页（A4），整批失败会让用户连能识别的那几页也拿不到。
 *
 * 状态码：401 令牌 · 400 图片/页号非法 · 429 配额 · 502 上游 · 503 绑定缺失
 *
 * 边界（写进交付文档）：识别结果是**未经校对的文本**，前端会放回可编辑文本框，
 * 由人确认后再导入 —— 不自动入库（视觉模型对中文的识别质量必须线上实测）。
 */

import { defineHandler } from "void";

import { ERR } from "../../lib/errors.ts";
import { authorize, jsonResponse, resolveAi, resolveFlags, type RouteCtx } from "../../lib/http.ts";
import { MAX_OCR_PAGES, OcrError, ocrPage } from "../../lib/ocr.ts";

export const POST = defineHandler(async (c) => {
  const denied = authorize(c, c.req.header("authorization"));
  if (denied) return denied;

  const ctx = c as RouteCtx;
  if (!ctx._ai && !ctx.env?.AI) return jsonResponse(503, { error: ERR.aiBindingMissing });

  let body: { image?: unknown; page?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: ERR.badJson });
  }

  const page = body.page === undefined ? 1 : Number(body.page);
  if (!Number.isFinite(page) || page < 1) return jsonResponse(400, { error: ERR.ocrPageLimit(1, MAX_OCR_PAGES) });
  // 页号上限只是防越界（真正的页数控制在**前端**：只取前 MAX_OCR_PAGES 页渲染）
  if (page > MAX_OCR_PAGES) return jsonResponse(400, { error: ERR.ocrPageLimit(page, MAX_OCR_PAGES) });

  const image = typeof body.image === "string" ? body.image : "";
  if (!image) return jsonResponse(400, { error: ERR.ocrBadImage });

  const flags = resolveFlags(c);
  try {
    const text = await ocrPage(resolveAi(c), image, { model: flags.ocrModel });
    return jsonResponse(200, { ok: true, page, text, chars: text.length });
  } catch (e) {
    if (e instanceof OcrError) {
      const status = e.code === "quota" ? 429 : e.code === "upstream" ? 502 : 400;
      if (e.code === "upstream") {
        console.warn("[ocr] upstream failed");
        return jsonResponse(status, { error: ERR.ocrFailed });
      }
      return jsonResponse(status, { error: e.message });
    }
    console.warn(`[ocr] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    return jsonResponse(502, { error: ERR.ocrFailed });
  }
});