/**
 * 扫描件 OCR —— 页面图片 → 文字（Workers AI 视觉模型）。
 *
 * 分工（CONTEXT D21）：
 *   前端 `lib/pdf.ts#renderPdfPages` 负责「PDF 页 → JPEG dataURL」（浏览器有 canvas）
 *   本模块负责「图片 → 文字」（Worker 里没有 canvas，但能调 Workers AI）
 *
 * 为什么不让 Worker 自己解析 PDF：Worker 里没有 canvas/DOM，pdf.js 渲染不出页面图像；
 * 而纯文本抽取（一期 `pdf.ts`）对扫描件本来就是空的 —— 图片型 PDF 里没有文字层。
 *
 * 诚实边界（写进交付文档，不假装）：
 *   1. 视觉模型的中文识别质量**没有本地验证手段**（本地 AI 是假模型），必须线上实测；
 *      因此前端把抽出来的文本放回**可编辑文本框**，由人校对后再导入，不自动入库。
 *   2. 视图片大小与页数消耗 Workers AI Neurons；20 页扫描件会直接撞免费额度。
 *      上限 MAX_OCR_PAGES 页，且单页失败只跳过该页。
 */

import { isQuotaError } from "./embed.ts";
import type { AILike } from "./embed.ts";
import { ocrErrorText } from "./errors.ts";

/**
 * 默认模型：`@cf/moondream/moondream3.1-9B-A2B`
 * 选它的理由：Workers AI 目录里少数明确把 OCR 列为能力的视觉模型，
 * 输入接受 base64 data URI（无需先把图传 R2），且是 MoE 2B 激活，单页成本可控。
 * 中文识别质量存疑 → 用 `OCR_MODEL` 环境变量可换成更强的多模态模型（如 Qwen 视觉系列）。
 */
export const DEFAULT_OCR_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
/** 单次 OCR 页数上限（免费额度 + 单页几秒的现实约束） */
export const MAX_OCR_PAGES = 5;
/** 单页 dataURL 字符上限（≈1.5MB 图片；超出说明前端没压缩就直接发了） */
export const MAX_OCR_IMAGE_CHARS = 2_000_000;

/**
 * OCR 提示词。
 * 明确「只输出文字」是必要的：视觉模型默认会把图片描述一遍
 * （「这是一张包含表格的扫描件……」），那会把描述当正文塞进知识库。
 */
export const OCR_PROMPT = [
  "提取这张扫描件图片中的全部文字。",
  "要求：",
  "1. 只输出图中真实存在的文字，按原有阅读顺序与段落换行；",
  "2. 不要总结、不要翻译、不要解释、不要描述版式、不要加任何前后缀；",
  "3. 表格按「列：值」的逐行文本输出；",
  "4. 确实看不清的字用 ⍰ 代替，不要猜测补全。",
].join("\n");

export class OcrError extends Error {
  readonly code: "quota" | "upstream" | "empty" | "bad_image" | "too_large";
  constructor(code: OcrError["code"], message?: string) {
    super(message ?? ocrErrorText(code));
    this.name = "OcrError";
    this.code = code;
  }
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * 校验并规整图片入参。
 * 只接受 data URL（不取远程 URL）：避免把「Worker 去 fetch 用户给的地址」变成新的 SSRF 面。
 */
export function normalizeImage(image: unknown): string {
  if (typeof image !== "string" || !image.trim()) throw new OcrError("bad_image");
  const v = image.trim();
  if (!DATA_URL_RE.test(v)) throw new OcrError("bad_image");
  if (v.length > MAX_OCR_IMAGE_CHARS) throw new OcrError("too_large");
  return v;
}

/**
 * 从模型返回里取文字（不同视觉模型返回形状不一致，做容错）。
 *
 * 已核实的形状：moondream `query` 任务返回 `{ answer }`；
 * 其它模型常见 `{ response }` / `{ result: { response } }` / `{ description }`。
 */
export function extractOcrText(res: unknown): string {
  const candidates: unknown[] = [
    (res as { answer?: unknown })?.answer,
    (res as { response?: unknown })?.response,
    (res as { result?: { answer?: unknown } })?.result?.answer,
    (res as { result?: { response?: unknown } })?.result?.response,
    (res as { result?: { description?: unknown } })?.result?.description,
    (res as { description?: unknown })?.description,
    (res as { text?: unknown })?.text,
    res,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return normalizeOcrText(c);
  }
  throw new OcrError("empty");
}

/** 去模型常见的前后缀噪声（「图片中的文字如下：」这类引导语） */
export function normalizeOcrText(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^(图片|图像|图中|扫描件)?(中的|里的)?文字(如下|内容如下)?[:：]\s*/u, "");
  text = text.replace(/^以下是?(图片|图像|扫描件)?(中的|里的)?文字[:：]\s*/u, "");
  text = text.replace(/```[a-z]*\n?/gi, "");
  text = text.replace(/```/g, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 单页 OCR。
 *
 * 失败语义：配额错误抛 `OcrError("quota")`（路由映射 429），其它抛 upstream（502）。
 * 这里不吞错误 —— 吞掉会让前端把「识别失败」当成「这张图没字」。
 */
export async function ocrPage(
  ai: AILike,
  image: string,
  opts: { model?: string } = {},
): Promise<string> {
  const dataUrl = normalizeImage(image);
  const model = opts.model || DEFAULT_OCR_MODEL;

  let res: unknown;
  try {
    res = await ai.run(model, {
      task: "query",
      image: dataUrl,
      question: OCR_PROMPT,
      reasoning: false,
    });
  } catch (e) {
    if (isQuotaError(e)) throw new OcrError("quota");
    throw new OcrError("upstream");
  }

  const text = extractOcrText(res);
  if (!text.trim()) throw new OcrError("empty");
  return text;
}