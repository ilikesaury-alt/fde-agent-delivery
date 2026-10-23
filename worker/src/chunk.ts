/**
 * 超长文本分块摘要 — 预留接口（MVP 未使用）
 * MVP 策略：超长即友好拒绝（见 validate.ts）。
 * 后续若启用 B 方案，在此实现「分块 → 各块摘要 → 合并」，
 * 复用 ./llm.ts 的 callLLM 作为单块摘要客户端。
 */

export class NotImplementedError extends Error {
  constructor(message = "超长文本自动分段摘要尚未开放，请手动分段提交。") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * 预留：把超长文本切块分别摘要后合并。
 * MVP 不调用；保留签名以便后续接入。
 */
export async function summarizeChunks(): Promise<string> {
  throw new NotImplementedError();
}
