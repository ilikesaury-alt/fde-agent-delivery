/**
 * 嵌入 —— Workers AI `@cf/baai/bge-m3`（1024 维，多语言/中文友好）。
 *
 * 三个必须处理的现实问题（都来自 CONTEXT §7 的风险表）：
 *  1. **单请求预算**：一次把 200 个 chunk 塞进去会超 Workers 请求预算 →
 *     分批（BATCH_SIZE），且每批单独 try，失败可续（已成功的 chunk 不必重做）。
 *  2. **日配额**：Free 10k Neurons/天 ≈ 数百次调用 → 识别配额类错误并给出
 *     明确文案（而不是笼统「AI 服务不可用」）。
 *  3. **可测性**：`AILike` 接口注入，本地 shim / 单测用确定性假模型。
 */

import { embedErrorText } from "./errors.ts";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const EMBED_DIM = 1024;
/** 每批 chunk 数：8 是在「请求预算」与「往返次数」之间的折中 */
export const BATCH_SIZE = 8;

export class EmbedError extends Error {
  readonly code: "quota" | "upstream" | "empty";
  constructor(code: "quota" | "upstream" | "empty", message?: string) {
    super(message ?? embedErrorText(code));
    this.name = "EmbedError";
    this.code = code;
  }
}

export type AILike = {
  run(model: string, input: { text: string[] }): Promise<unknown>;
};

/** 从 Workers AI 返回值里取向量矩阵（不同模型返回形状略有差异，做容错） */
export function extractVectors(res: unknown, expected: number): number[][] {
  const data = (res as { data?: unknown; result?: { data?: unknown } })?.data ?? (res as { result?: { data?: unknown } })?.result?.data;
  if (!Array.isArray(data)) throw new EmbedError("upstream", "嵌入服务返回格式异常，请稍后重试。");
  const vectors = data as number[][];
  if (vectors.length !== expected) {
    throw new EmbedError("upstream", "嵌入结果数量与输入不一致，请重试。");
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== EMBED_DIM) {
      throw new EmbedError("upstream", "嵌入维度异常，请检查模型配置。");
    }
  }
  return vectors;
}

/** 判断是否为配额/额度耗尽类错误（需要给出不同的用户文案） */
export function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /quota|neuron|limit exceeded|too many requests|429/i.test(msg);
}

/**
 * 批量嵌入。返回与输入等长的向量数组。
 *
 * 失败策略：任一批失败即整体抛错（调用方把文档置 failed 并保留已成功部分不做原子回滚——
 * 因为向量以 chunk id 为键，重试时同 id 覆盖天然幂等）。
 */
export async function embedAll(ai: AILike, texts: string[], opts: { batchSize?: number } = {}): Promise<number[][]> {
  const size = opts.batchSize ?? BATCH_SIZE;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    let res: unknown;
    try {
      res = await ai.run(EMBED_MODEL, { text: batch });
    } catch (e) {
      if (isQuotaError(e)) throw new EmbedError("quota");
      throw new EmbedError("upstream", e instanceof Error ? e.message : undefined);
    }
    out.push(...extractVectors(res, batch.length));
  }
  if (out.length !== texts.length) throw new EmbedError("upstream");
  return out;
}

/** 单条嵌入（检索时用） */
export async function embedOne(ai: AILike, text: string): Promise<number[]> {
  const [v] = await embedAll(ai, [text]);
  return v;
}
