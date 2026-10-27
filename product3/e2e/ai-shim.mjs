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
 */

export const EMBED_DIM = 1024;
export const EMBED_MODEL = "@cf/baai/bge-m3";

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

  return {
    calls,
    async run(model, input) {
      calls.push({ model, count: input.text.length });
      const fail = process.env.AI_FAIL;
      if (fail === "quota") throw new Error("429 too many requests: neuron quota exceeded");
      if (fail === "upstream") throw new Error("upstream 500");
      if (model !== EMBED_MODEL) throw new Error(`unexpected model: ${model}`);
      return { data: input.text.map((t) => fakeEmbed(t)) };
    },
  };
}
