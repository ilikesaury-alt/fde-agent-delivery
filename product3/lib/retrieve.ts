/**
 * 检索 —— 向量 top-k + 相似度阈值。
 *
 * 阈值是产品的**诚实性开关**：低于它就说「没有依据」而不是让模型硬编。
 * 默认 0.35 只是基线，真实值由 eval/ 扫曲线后写死（CONTEXT D16）。
 */

import type { Chunk, Hit } from "./types.ts";
import type { Repo, VectorIndex } from "./repo.ts";

export const DEFAULT_TOP_K = 6;
/**
 * 默认相似度阈值。
 *
 * 尺度差异（都实测过，不要互相套用）：
 *   真 bge-m3：相关文本 0.52 / 0.65（2026-10-28 线上实测）
 *   本地词袋假嵌入：相关文本 0.05–0.2
 * 所以默认值取「线上安全」；本地 shim 必须显式注入 RETRIEVE_MIN_SCORE=0.05。
 */
export const DEFAULT_MIN_SCORE = 0.45;

export type RetrieveOptions = {
  topK?: number;
  minScore?: number;
};

export type RetrieveResult = {
  /** 通过阈值的命中（按分数降序），用于生成回答 */
  hits: Hit[];
  /**
   * **未通过阈值**但分数最高的若干条，用于拒答时给用户「最接近的内容」。
   * 语义必须是「没通过闸的」，否则拒答时展示的却是高分片段，自相矛盾（cross-review N5）。
   */
  nearest: Hit[];
  topK: number;
  minScore: number;
};

/**
 * 检索并分流。
 *
 * 关键过滤（cross-review B3/B4）：**只允许 status=ready 的文档参与检索**。
 * 原因：向量写入失败、并发导入产生孤儿 chunk、文档被标记 failed 时，
 * chunk 行可能短暂存在但文档不可用；不过滤会让「失败文档」继续被引用，
 * 用户看到一条引用指向一篇列表里显示「失败」的文档。
 */
export async function retrieve(
  queryVector: number[],
  deps: { repo: Repo; index: VectorIndex },
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  const matches = await deps.index.query(queryVector, topK);
  if (!matches.length) return { hits: [], nearest: [], topK, minScore };

  const ids = matches.map((m) => m.id);
  const chunks = await deps.repo.getChunksByIds(ids);
  const byId = new Map<string, Chunk>(chunks.map((c) => [c.id, c]));

  // 文档状态过滤：同一文档只查一次
  const docReady = new Map<string, boolean>();
  const isReady = async (docId: string): Promise<boolean> => {
    const cached = docReady.get(docId);
    if (cached !== undefined) return cached;
    const doc = await deps.repo.getDocument(docId);
    const ok = doc?.status === "ready";
    docReady.set(docId, ok);
    return ok;
  };

  // 保持 index 返回的分数顺序；chunk 已被删（索引残影）或文档非 ready 的直接跳过
  const scored: Hit[] = [];
  for (const m of matches) {
    const chunk = byId.get(m.id);
    if (!chunk) continue;
    if (!(await isReady(chunk.docId))) continue;
    scored.push({ chunk, score: m.score });
  }

  const passed = scored.filter((h) => h.score >= minScore);
  const nearest = scored.filter((h) => h.score < minScore).slice(0, 3);
  return { hits: passed, nearest, topK, minScore };
}
