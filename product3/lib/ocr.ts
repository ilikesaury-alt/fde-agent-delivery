/**
 * 扫描件 OCR —— 页面图片 → 文字（Workers AI 视觉模型）。
 *
 * 分工（CONTEXT D21）：
 *   前端 `lib/pdf.ts#renderPdfPages` 负责「PDF 页 → JPEG dataURL」（浏览器有 canvas）
 *   本模块负责「图片 → 文字」（Worker 里没有 canvas，但能调 Workers AI）
 *
 * 模型适配（2026-10-28 线上实测）：
 *   - `@cf/moondream/moondream3.1-9B-A2B`：目录里明确标 OCR 能力，但**线上实测对所有入参
 *     （query/caption/带图/无图/URL 图/裸 base64）一律返回 `{}`** —— 模型端当前不可用。
 *     保留其调用形状（`{task, image, question}`），一旦恢复可用 `OCR_MODEL` 切回。
 *   - 默认改用 `@cf/meta/llama-3.2-11b-vision-instruct`（messages 形状入参）。
 *
 * 诚实边界（写进交付文档，不假装）：
 *   1. 视觉模型的中文识别质量**没有本地验证手段**（本地 AI 是假模型），必须线上实测；
 *      因此前端把抽出来的文本放回**可编辑文本框**，由人校对后再导入，不自动入库。
 *   2. 视图片大小与页数消耗 Workers AI Neurons；上限 MAX_OCR_PAGES 页，单页失败只跳过。
 */

import { isQuotaError } from "./embed.ts";
import type { AILike } from "./embed.ts";
import { ocrErrorText } from "./errors.ts";

/** 默认模型（2026-10-28：moondream 线上返回空对象，切 llama-3.2-11b-vision） */
export const DEFAULT_OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
/** moondream（query 形状）——保留适配，恢复后可用 OCR_MODEL 切回 */
export const MOONDREAM_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
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

/** llama-3.2-vision（字节组 + prompt 形状，且需一次性 agree） */
const LLAMA_VISION_RE = /llama-3\.2-11b-vision/i;
/** qwen 等其它 chat 形状的视觉模型（messages 入参） */
const CHAT_VISION_RE = /mistral|qwen|gemma|glm|kimi|deepseek|apertus|eurollm/i;

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
 * 已覆盖的形状：
 *   moondream `query`  → `{ answer }`
 *   llama-3.2-vision   → `{ description }`
 *   OpenAI 兼容 chat   → `{ choices: [{ message: { content } }] }`
 *   其它               → `{ response }` / `{ result: { response } }` / 纯字符串
 */
export function extractOcrText(res: unknown): string {
  const choices = (res as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const candidates: unknown[] = [
    (res as { answer?: unknown })?.answer,
    (res as { description?: unknown })?.description,
    Array.isArray(choices) ? choices[0]?.message?.content : undefined,
    (res as { response?: unknown })?.response,
    (res as { result?: { answer?: unknown } })?.result?.answer,
    (res as { result?: { response?: unknown } })?.result?.response,
    (res as { result?: { description?: unknown } })?.result?.description,
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
 * 按模型族选择入参形状：
 *   llama-3.2-11b-vision → `{ image: <字节数组>, prompt, max_tokens }`（官方文档形状，图片是字节
 *     数组而不是 dataURL——2026-10-28 线上实测：messages 形状报 5016，字节数组可用）
 *   moondream            → `{ task, image: dataURL, question, reasoning }`
 */
export function buildVisionInput(model: string, dataUrl: string, prompt: string): Record<string, unknown> {
  if (LLAMA_VISION_RE.test(model)) {
    return {
      image: Array.from(atob(dataUrl.split(",")[1] ?? ""), (c) => c.charCodeAt(0) & 0xff),
      prompt,
      max_tokens: 2048,
      temperature: 0.1,
    };
  }
  if (CHAT_VISION_RE.test(model)) {
    return {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 2048,
      temperature: 0.1,
    };
  }
  return { task: "query", image: dataUrl, question: prompt, reasoning: false };
}

/** llama 系模型的一次性许可同意（错误 5016 的自愈；官方口径：`{ prompt: "agree" }`） */
export function buildAgreeInput(model: string): Record<string, unknown> {
  if (LLAMA_VISION_RE.test(model)) {
    return { prompt: "agree" };
  }
  if (CHAT_VISION_RE.test(model)) {
    return { messages: [{ role: "user", content: "agree" }] };
  }
  return { task: "query", question: "agree" };
}

async function runVision(ai: AILike, model: string, dataUrl: string, prompt: string): Promise<unknown> {
  return ai.run(model, buildVisionInput(model, dataUrl, prompt));
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
    res = await runVision(ai, model, dataUrl, OCR_PROMPT);
  } catch (e) {
    if (isQuotaError(e)) throw new OcrError("quota");
    // llama 系视觉模型首次使用需要同意 Meta 许可（Workers AI 错误 5016，要求提交 'agree'）。
    // 自愈：自动提交一次同意并重试主调用（提交动作幂等，重复提交无副作用）。
    if (/5016|agree/i.test(e instanceof Error ? e.message : String(e))) {
      try {
        await ai.run(model, buildAgreeInput(model));
      } catch {
        // 同意失败 → 按原错误处理
      }
      try {
        res = await runVision(ai, model, dataUrl, OCR_PROMPT);
      } catch (e2) {
        if (isQuotaError(e2)) throw new OcrError("quota");
        throw new OcrError("upstream");
      }
    } else {
      throw new OcrError("upstream");
    }
  }

  const text = extractOcrText(res);
  if (!text.trim()) throw new OcrError("empty");
  return text;
}