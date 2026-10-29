/**
 * 扫描件 OCR —— 页面图片 → 文字（Workers AI 视觉模型）。
 *
 * 与产品③ lib/ocr.ts 同源（那边已在线上跑通，含 5016 许可自愈），**独立副本**：
 * 跨 Worker 共享代码会把一个产品的改动带进另一个产品的部署（部署边界即依赖边界）。
 *
 * 分工：
 *   前端 `lib/pdf.ts#renderPdfPages` 负责「PDF 页 → JPEG dataURL」（浏览器有 canvas）
 *   本模块负责「图片 → 文字」（Worker 里没有 canvas，但能调 Workers AI）
 *
 * 产品④ 的额外纪律（CONTEXT A2）：OCR 出来的文本**只是「文本获取」的一种手段**，
 * 和电子版 PDF 抽出的文本走**同一条** 抽取链路；不直接产出结构化指标。
 */

import { isQuotaError, OcrError } from "./errors.ts";

/** Workers AI 绑定的最小形状（只用 run） */
export type AILike = {
  run(model: string, input: unknown): Promise<unknown>;
};

/** 默认模型（③ 二期线上实测：moondream 返回空对象，llama-3.2-11b-vision 可用） */
export const DEFAULT_OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
/** moondream（query 形状）——保留适配，恢复后可用 OCR_MODEL 切回 */
export const MOONDREAM_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
/** 单次 OCR 页数上限 */
export const MAX_OCR_PAGES = 5;
/** 单页 dataURL 字符上限（≈1.5MB 图片；超出说明前端没压缩就直接发了） */
export const MAX_OCR_IMAGE_CHARS = 2_000_000;

/**
 * OCR 提示词。产品④ 比③ 多一条：要求保留「指标名 / 值 / 单位 / 参考范围」的相邻关系 ——
 * 因为接下来要做结构化抽取，列序错乱会让抽取把值配到别的指标上。
 */
export const OCR_PROMPT = [
  "提取这张体检报告扫描件中的全部文字。",
  "要求：",
  "1. 只输出图中真实存在的文字，按原有阅读顺序与行列对应关系输出；",
  "2. 表格按每行一条的形式输出，同一行的「指标名称、结果值、单位、参考范围」要保持在同一行；",
  "3. 不要总结、不要翻译、不要解释、不要描述版式、不要加任何前后缀；",
  "4. 确实看不清的字用 ⍰ 代替，不要猜测补全。",
].join("\n");

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
  if (typeof image !== "string" || !image.trim()) throw new OcrError("ocrBadImage");
  const v = image.trim();
  if (!DATA_URL_RE.test(v)) throw new OcrError("ocrBadImage");
  if (v.length > MAX_OCR_IMAGE_CHARS) throw new OcrError("ocrTooLarge");
  return v;
}

/**
 * 从模型返回里取文字（不同视觉模型返回形状不一致，做容错）。
 * 「HTTP 200 但返回空对象」是真实发生过的（moondream）—— 必须显式当作 empty 抛出，
 * 否则前端会把「模型不工作」显示成「这张图没有文字」。
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
  throw new OcrError("ocrEmpty");
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
 *   llama-3.2-11b-vision → `{ image: <字节数组>, prompt, max_tokens }`
 *     （2026-10-28 线上实测：messages 形状报 5016，字节数组可用）
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
  if (LLAMA_VISION_RE.test(model)) return { prompt: "agree" };
  if (CHAT_VISION_RE.test(model)) return { messages: [{ role: "user", content: "agree" }] };
  return { task: "query", question: "agree" };
}

async function runVision(ai: AILike, model: string, dataUrl: string, prompt: string): Promise<unknown> {
  return ai.run(model, buildVisionInput(model, dataUrl, prompt));
}

/**
 * 单页 OCR。
 * 失败语义：配额 → `ocrQuota`（路由 429），其它 → `ocrUpstream`（502），无文字 → `ocrEmpty`（422）。
 * 不吞错误 —— 吞掉会让前端把「识别失败」当成「这张图没字」。
 */
export async function ocrPage(ai: AILike, image: string, opts: { model?: string } = {}): Promise<string> {
  const dataUrl = normalizeImage(image);
  const model = opts.model || DEFAULT_OCR_MODEL;

  let res: unknown;
  try {
    res = await runVision(ai, model, dataUrl, OCR_PROMPT);
  } catch (e) {
    if (isQuotaError(e)) throw new OcrError("ocrQuota");
    // llama 系视觉模型首次使用需同意许可（Workers AI 5016，要求提交 'agree'）。
    // 自愈：提交一次同意再重试（幂等，重复提交无副作用）。
    if (/5016|agree/i.test(e instanceof Error ? e.message : String(e))) {
      try {
        await ai.run(model, buildAgreeInput(model));
      } catch {
        // 同意失败 → 按原错误处理
      }
      try {
        res = await runVision(ai, model, dataUrl, OCR_PROMPT);
      } catch (e2) {
        if (isQuotaError(e2)) throw new OcrError("ocrQuota");
        throw new OcrError("ocrUpstream");
      }
    } else {
      throw new OcrError("ocrUpstream");
    }
  }

  const text = extractOcrText(res);
  if (!text.trim()) throw new OcrError("ocrEmpty");
  return text;
}