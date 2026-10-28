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

import type { Chunk, Conversation, ConversationMessage, Document, DocumentSlim, QaRecord } from "./types.ts";
import type { Repo, TermHitRow, VectorIndex } from "./repo.ts";

export function createMemoryRepo(): Repo & {
  __documents: Map<string, Document>;
  __chunks: Map<string, Chunk>;
  __qa: QaRecord[];
  __terms: Map<string, Map<string, number>>;
  __conversations: Map<string, Conversation>;
  __messages: ConversationMessage[];
} {
  const documents = new Map<string, Document>();
  const chunks = new Map<string, Chunk>();
  const qa: QaRecord[] = [];
  /** term → (chunkId → tf)：与 D1 的 chunk_terms 同语义 */
  const terms = new Map<string, Map<string, number>>();
  const conversations = new Map<string, Conversation>();
  const messages: ConversationMessage[] = [];

  const slim = (d: Document): DocumentSlim => {
    const { contentHash: _h, ...rest } = d;
    void _h;
    return rest;
  };

  return {
    __documents: documents,
    __chunks: chunks,
    __qa: qa,
    __terms: terms,
    __conversations: conversations,
    __messages: messages,

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
      // 倒排跟着 chunk 一起走（与 D1 实现同语义）
      for (const [term, posting] of terms) {
        for (const cid of ids) posting.delete(cid);
        if (!posting.size) terms.delete(term);
      }
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
    async insertChunkTerms(rows) {
      for (const r of rows) {
        const posting = terms.get(r.term) ?? new Map<string, number>();
        posting.set(r.chunkId, r.tf);
        terms.set(r.term, posting);
      }
    },
    async searchTerms(list, limit = 5000) {
      const out: TermHitRow[] = [];
      // 与 D1 实现同一口径：每个 term 各自限量，避免常见词吃掉全部配额
      const perTerm = Math.min(400, Math.max(50, Math.ceil(limit / Math.max(list.length, 1))));
      for (const term of list) {
        const posting = terms.get(term);
        if (!posting) continue;
        let taken = 0;
        for (const [chunkId, tf] of posting) {
          const chunk = chunks.get(chunkId);
          if (!chunk) continue;
          out.push({ term, chunkId, tf, dl: chunk.text.length });
          if (++taken >= perTerm) break;
        }
      }
      return out;
    },
    async chunkStats() {
      const ready = new Set(
        [...documents.values()].filter((d) => d.status === "ready").map((d) => d.id),
      );
      const list = [...chunks.values()].filter((c) => ready.has(c.docId));
      const total = list.reduce((sum, c) => sum + c.text.length, 0);
      return { n: list.length, avgdl: list.length ? total / list.length : 0 };
    },

    async insertConversation(c) {
      conversations.set(c.id, { ...c, turnCount: 0 });
    },
    async listConversations(limit = 50) {
      return [...conversations.values()]
        .map((c) => ({ ...c, turnCount: messages.filter((m) => m.conversationId === c.id).length }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    },
    async getConversation(id) {
      const c = conversations.get(id);
      if (!c) return null;
      return { ...c, turnCount: messages.filter((m) => m.conversationId === id).length };
    },
    async updateConversation(id, patch) {
      const c = conversations.get(id);
      if (!c) return;
      if (patch.title !== undefined) c.title = patch.title;
      if (patch.updatedAt !== undefined) c.updatedAt = patch.updatedAt;
    },
    async deleteConversation(id) {
      const n = messages.filter((m) => m.conversationId === id).length;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].conversationId === id) messages.splice(i, 1);
      }
      conversations.delete(id);
      return n;
    },

    async insertMessage(m) {
      messages.push(m);
    },
    async listMessages(conversationId, limit = 50) {
      return messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, limit);
    },
    async listRecentMessages(limit = 50) {
      // 孤儿消息（会话已删）不计入，与 D1 实现的 JOIN 同语义
      return [...messages]
        .filter((m) => conversations.has(m.conversationId))
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, limit);
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
