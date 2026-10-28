/**
 * Workers AI 替身：确定性词袋嵌入（1024 维），带调用计数与可注入错误。
 *
 * ⚠️ 算法必须与 test/fakes.ts 的 fakeEmbed 一致（改动同步两处）。
 *
 * 为什么必须「语义感知」而不是随机向量：
 *   随机向量下所有 cosine 都接近 0，检索、阈值、拒答的断言就全是假的
 *   （看起来测试通过，实际什么也没验）。
 *
 * 环境变量：
 *   AI_FAIL=quota | upstream   注入嵌入失败（验证失败路径与文案）
 *   OCR_FAIL=quota | upstream  注入 OCR 失败（验证 429/502 映射）
 *   OCR_TEXT=<文本>            覆盖 OCR 返回文本（E2E 断言用）
 *   OCR_MODEL=<模型名>         覆盖视觉模型名（与 Worker 的 OCR_MODEL 对齐）
 *
 * 二期新增：视觉模型（OCR）通道。入参形状是 `{ task, image, question }`，
 * 返回 `{ answer }` —— 与真 moondream 的 query 任务一致（已核对模型文档）。
 */

export const EMBED_DIM = 1024;
export const EMBED_MODEL = "@cf/baai/bge-m3";
/** 与 lib/ocr.ts 的 DEFAULT_OCR_MODEL 必须一致（改动同步两处） */
export const OCR_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export function tokenize(text) {
  const norm = text.toLowerCase().replace(/\s+/g, " ");
  const out = [];
  for (const m of norm.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  for (const seg of norm.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = seg[0];
    if (s.length === 1) out.push(s);
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  }
  return out;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function fakeEmbed(text) {
  const v = new Array(EMBED_DIM).fill(0);
  for (const tok of tokenize(text)) {
    const h = hash32(tok);
    v[h % EMBED_DIM] += 1;
    v[(h >>> 11) % EMBED_DIM] += 0.5;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function createAIshim() {
  /** @type {Array<{model: string, count: number}>} */
  const calls = [];
  const ocrModel = process.env.OCR_MODEL || OCR_MODEL;
  let ocrPages = 0;

  return {
    calls,
    async run(model, input) {
      const textCount = Array.isArray(input?.text) ? input.text.length : 1;
      calls.push({ model, count: textCount });

      // ── 视觉模型（OCR）通道 ──
      if (model !== EMBED_MODEL) {
        if (model !== ocrModel) throw new Error(`unexpected model: ${model}`);
        const ocrFail = process.env.OCR_FAIL;
        if (ocrFail === "quota") throw new Error("429 too many requests: neuron quota exceeded");
        if (ocrFail === "upstream") throw new Error("upstream 500");
        const okImage = Array.isArray(input?.image) ? input.image.length > 0 : Boolean(input?.image);
        if (!okImage) throw new Error("OCR 入参缺 image");
        ocrPages++;
        return {
          description: process.env.OCR_TEXT || `扫描件第 ${ocrPages} 页正文：季度复盘要点。
第二行：绑定与配额均已核验。`,
        };
      }

      const fail = process.env.AI_FAIL;
      if (fail === "quota") throw new Error("429 too many requests: neuron quota exceeded");
      if (fail === "upstream") throw new Error("upstream 500");
      return { data: input.text.map((t) => fakeEmbed(t)) };
    },
  };
}
