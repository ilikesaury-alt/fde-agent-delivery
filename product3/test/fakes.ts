/**
 * 确定性假模型 —— 让「检索 / 拒答 / 引用」在本地就能被真实测到。
 *
 * 关键设计：假嵌入必须是**语义感知**的（词袋哈希到向量），不能是随机数。
 * 随机向量下 cosine 全接近 0，检索/阈值/拒答的断言就全是假的（测不出任何东西）。
 *
 * 同一套假模型贯穿单测与本地 E2E（e2e/server.mjs），保证行为一致。
 */

import type { AILike } from "../lib/embed.ts";
import { EMBED_DIM, EMBED_MODEL } from "../lib/embed.ts";
import type { ChatMessage } from "../lib/llm.ts";

/** 简易分词：中文按字 bigram + 英文/数字按词，够用且稳定 */
export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, " ");
  const out: string[] = [];
  // 英文/数字词
  for (const m of norm.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  // 中文 bigram（连续 CJK 片段内）
  for (const seg of norm.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = seg[0];
    if (s.length === 1) out.push(s);
    for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  }
  return out;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 词袋 → L2 归一化向量（同词袋 → 同向量；相似文本 → 高 cosine） */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
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

export type FakeAIOptions = {
  /** 嵌入时抛错（测配额/上游异常路径） */
  embedError?: () => Error | null;
  /** 每次 run 的调用计数（测分批） */
  onRun?: (model: string, count: number) => void;
};

export function createFakeAI(opts: FakeAIOptions = {}): AILike & { calls: Array<{ model: string; count: number }> } {
  const calls: Array<{ model: string; count: number }> = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, count: input.text.length });
      opts.onRun?.(model, input.text.length);
      const err = opts.embedError?.();
      if (err) throw err;
      if (model !== EMBED_MODEL) throw new Error(`unexpected model: ${model}`);
      return { data: input.text.map((t) => fakeEmbed(t)) };
    },
  };
}

/**
 * 假 LLM：按「固定回答」回流，并可断言 prompt 内容。
 * 用于测 grounded prompt 是否真的带上了注入防护与片段编号。
 */
export function createFakeLLM(answer: string | ((messages: ChatMessage[]) => string)) {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
      seen.push(messages);
      const full = typeof answer === "function" ? answer(messages) : answer;
      // 按字符切片回流，模拟真实增量
      for (let i = 0; i < full.length; i += 6) yield full.slice(i, i + 6);
    },
  };
}
