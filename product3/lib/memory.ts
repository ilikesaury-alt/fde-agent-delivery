/**
 * 内存实现 —— 单测与本地 shim 共用（不依赖 Cloudflare 绑定）。
 *
 * ⚠️ 两种内存实现的分工，别混：
 *   createMemoryRepo()  → 纯 Map，用于**单元测试**（快、无 SQL）
 *   e2e/d1-shim.mjs     → node:sqlite 跑真 migration + 真 SQL，用于**本地 E2E**
 *     （只在 Map 里造假就测不到 ORDER BY / LIMIT / 参数绑定这些真实 SQL 语义）
 *
 * 向量侧的反向：本文件的 createMemoryVectorIndex 是**唯一**本地实现 ——
 * Vectorize 没有本地替身，所以用余弦相似度精确复刻「近邻检索」语义，
 * 让检索/拒答/引用的业务逻辑在本地就能被真实测到。
 */

import type { Chunk, Document, DocumentSlim, QaRecord } from "./types.ts";
import type { Repo, VectorIndex } from "./repo.ts";

export function createMemoryRepo(): Repo & { __documents: Map<string, Document>; __chunks: Map<string, Chunk>; __qa: QaRecord[] } {
  const documents = new Map<string, Document>();
  const chunks = new Map<string, Chunk>();
  const qa: QaRecord[] = [];

  const slim = (d: Document): DocumentSlim => {
    const { contentHash: _h, ...rest } = d;
    void _h;
    return rest;
  };

  return {
    __documents: documents,
    __chunks: chunks,
    __qa: qa,

    async insertDocument(doc) {
      documents.set(doc.id, { ...doc, status: "pending", chunkCount: 0, error: null });
    },
    async findByHash(contentHash) {
      const all = [...documents.values()].filter((d) => d.contentHash === contentHash);
      all.sort((a, b) => b.createdAt - a.createdAt);
      return all[0] ?? null;
    },
    async findBySourceRef(source, sourceRef) {
      const all = [...documents.values()].filter((d) => d.source === source && d.sourceRef === sourceRef);
      all.sort((a, b) => b.createdAt - a.createdAt);
      return all[0] ?? null;
    },
    async listDocuments(limit = 100) {
      return [...documents.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(slim);
    },
    async getDocument(id) {
      return documents.get(id) ?? null;
    },
    async updateDocument(id, patch) {
      const d = documents.get(id);
      if (!d) return;
      if (patch.status !== undefined) d.status = patch.status;
      if (patch.chunkCount !== undefined) d.chunkCount = patch.chunkCount;
      if (patch.error !== undefined) d.error = patch.error;
      if (patch.title !== undefined) d.title = patch.title;
      if (patch.indexedAt !== undefined) d.indexedAt = patch.indexedAt;
    },
    async deleteDocument(id) {
      const ids = [...chunks.values()].filter((c) => c.docId === id).map((c) => c.id);
      for (const cid of ids) chunks.delete(cid);
      documents.delete(id);
      return ids;
    },
    async insertChunks(list) {
      for (const c of list) chunks.set(c.id, c);
    },
    async listChunksByDoc(docId) {
      return [...chunks.values()].filter((c) => c.docId === docId).sort((a, b) => a.idx - b.idx);
    },
    async getChunksByIds(ids) {
      return ids.map((id) => chunks.get(id)).filter((c): c is Chunk => Boolean(c));
    },
    async insertQa(record) {
      qa.push(record);
    },
    async listQa(limit = 50) {
      return [...qa].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    },
  };
}

/** 余弦相似度（Vectorize 的 cosine metric 同口径） */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createMemoryVectorIndex(): VectorIndex & { __vectors: Map<string, number[]> } {
  const vectors = new Map<string, number[]>();
  return {
    __vectors: vectors,
    async upsert(items) {
      for (const it of items) vectors.set(it.id, it.values);
    },
    async query(vector, topK) {
      const scored = [...vectors.entries()].map(([id, v]) => ({ id, score: cosine(vector, v) }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
    },
    async existing(ids) {
      return ids.filter((id) => vectors.has(id));
    },
    async queryById(id, options) {
      const v = vectors.get(id);
      if (!v) return { matches: [] };
      const scored = [...vectors.entries()].map(([k, val]) => ({ id: k, score: cosine(v, val) }));
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, options?.topK ?? 1) };
    },
  };
}
