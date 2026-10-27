/**
 * 存储抽象 —— 让「线上 D1+Vectorize」与「本地内存 shim」跑同一套业务代码与单测。
 *
 * 拆两个接口而不是一个：
 *   Repo        元数据（D1 / node:sqlite）
 *   VectorIndex 向量（Vectorize / 内存余弦）
 * 理由：两者的失败模式与可测性完全不同（SQL 语义 vs 近邻检索），混在一起会
 * 逼出「本地为了跑通而伪造 SQL」的假绿（产品② d1-shim 的教训）。
 */

import type { Chunk, DocStatus, Document, DocumentSlim, DocSource, Hit, QaRecord } from "./types.ts";

export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type NewDocument = {
  id: string;
  source: DocSource;
  sourceRef: string | null;
  title: string;
  contentHash: string;
  createdAt: number;
};

export type Repo = {
  insertDocument(doc: NewDocument): Promise<void>;
  /** 幂等判据：同内容哈希的最新一条（含 failed，便于重试时复用 id） */
  findByHash(contentHash: string): Promise<Document | null>;
  /** 同来源（URL/文件名）的最新一条：内容变了要整篇替换（D14） */
  findBySourceRef(source: DocSource, sourceRef: string): Promise<Document | null>;
  listDocuments(limit?: number): Promise<DocumentSlim[]>;
  getDocument(id: string): Promise<Document | null>;
  updateDocument(
    id: string,
    patch: { status?: DocStatus; chunkCount?: number; error?: string | null; title?: string },
  ): Promise<void>;
  /** 删除文档元数据 + 其全部 chunks；返回被删 chunk id（调用方据此删向量） */
  deleteDocument(id: string): Promise<string[]>;

  insertChunks(chunks: Chunk[]): Promise<void>;
  listChunksByDoc(docId: string): Promise<Chunk[]>;
  getChunksByIds(ids: string[]): Promise<Chunk[]>;

  insertQa(record: QaRecord): Promise<void>;
  listQa(limit?: number): Promise<QaRecord[]>;
};

/** 向量索引抽象（写入的向量必须与 chunk id 一一对应） */
export type VectorIndex = {
  upsert(items: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<void>;
  query(vector: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
  deleteByIds(ids: string[]): Promise<void>;
  /** 回读校验用：返回实际存在的 id（Vectorize 的 getByIds） */
  existing(ids: string[]): Promise<string[]>;
};

// ---------------------------------------------------------------- D1 实现

type DocRow = {
  id: string;
  source: string;
  source_ref: string | null;
  title: string;
  content_hash: string;
  status: string;
  chunk_count: number;
  error: string | null;
  created_at: number;
};

type ChunkRow = {
  id: string;
  doc_id: string;
  idx: number;
  heading_path: string;
  text: string;
  created_at: number;
};

type QaRow = {
  id: string;
  question: string;
  answer_json: string | null;
  cited_doc_ids: string | null;
  created_at: number;
};

function rowToDoc(r: DocRow): Document {
  return {
    id: r.id,
    source: (["paste", "file", "url", "pdf"] as const).includes(r.source as DocSource) ? (r.source as DocSource) : "paste",
    sourceRef: r.source_ref ?? null,
    title: r.title ?? "",
    contentHash: r.content_hash,
    // 未知状态一律按 failed：静默当 ready 会让坏数据看起来正常
    status: (["pending", "indexing", "ready", "failed"] as const).includes(r.status as DocStatus)
      ? (r.status as DocStatus)
      : "failed",
    chunkCount: Number(r.chunk_count ?? 0),
    error: r.error ?? null,
    createdAt: Number(r.created_at),
  };
}

function rowToChunk(r: ChunkRow): Chunk {
  return {
    id: r.id,
    docId: r.doc_id,
    idx: Number(r.idx),
    headingPath: r.heading_path ?? "",
    text: r.text ?? "",
    createdAt: Number(r.created_at),
  };
}

function rowToQa(r: QaRow): QaRecord {
  let result: QaRecord["result"] = { answer: "", citations: [], refused: false };
  if (r.answer_json) {
    try {
      result = JSON.parse(r.answer_json) as QaRecord["result"];
    } catch {
      // 损坏的记录按空结果返回，不让列表整体 500
    }
  }
  let cited: string[] = [];
  if (r.cited_doc_ids) {
    try {
      cited = JSON.parse(r.cited_doc_ids) as string[];
    } catch {
      cited = [];
    }
  }
  return {
    id: r.id,
    question: r.question,
    result,
    citedDocIds: Array.isArray(cited) ? cited : [],
    createdAt: Number(r.created_at),
  };
}

/** 列表列白名单：绝不 SELECT *（一次列表把全部正文搬进 Worker 是真实事故源） */
const DOC_SLIM_COLUMNS =
  "id, source, source_ref, title, status, chunk_count, error, created_at, content_hash";

export function createD1Repo(db: D1Like): Repo {
  return {
    async insertDocument(doc) {
      await db
        .prepare(
          `INSERT INTO documents (id, source, source_ref, title, content_hash, status, chunk_count, error, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?)`,
        )
        .bind(doc.id, doc.source, doc.sourceRef, doc.title, doc.contentHash, doc.createdAt)
        .run();
    },

    async findByHash(contentHash) {
      const row = await db
        .prepare(`SELECT ${DOC_SLIM_COLUMNS} FROM documents WHERE content_hash = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(contentHash)
        .first<DocRow>();
      return row ? rowToDoc(row) : null;
    },

    async findBySourceRef(source, sourceRef) {
      const row = await db
        .prepare(
          `SELECT ${DOC_SLIM_COLUMNS} FROM documents WHERE source = ? AND source_ref = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(source, sourceRef)
        .first<DocRow>();
      return row ? rowToDoc(row) : null;
    },

    async listDocuments(limit = 100) {
      const res = await db
        .prepare(`SELECT ${DOC_SLIM_COLUMNS} FROM documents ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all<DocRow>();
      return (res.results ?? []).map((r) => {
        const { contentHash: _h, ...slim } = rowToDoc(r);
        void _h;
        return slim;
      });
    },

    async getDocument(id) {
      const row = await db
        .prepare(`SELECT *, content_hash FROM documents WHERE id = ?`)
        .bind(id)
        .first<DocRow>();
      return row ? rowToDoc(row) : null;
    },

    async updateDocument(id, patch) {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        args.push(patch.status);
      }
      if (patch.chunkCount !== undefined) {
        sets.push("chunk_count = ?");
        args.push(patch.chunkCount);
      }
      if (patch.error !== undefined) {
        sets.push("error = ?");
        args.push(patch.error);
      }
      if (patch.title !== undefined) {
        sets.push("title = ?");
        args.push(patch.title);
      }
      if (!sets.length) return;
      args.push(id);
      await db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
    },

    async deleteDocument(id) {
      const res = await db.prepare(`SELECT id FROM chunks WHERE doc_id = ?`).bind(id).all<{ id: string }>();
      const ids = (res.results ?? []).map((r) => r.id);
      await db.prepare(`DELETE FROM chunks WHERE doc_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM documents WHERE id = ?`).bind(id).run();
      return ids;
    },

    async insertChunks(chunks) {
      for (const c of chunks) {
        await db
          .prepare(`INSERT INTO chunks (id, doc_id, idx, heading_path, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(c.id, c.docId, c.idx, c.headingPath, c.text, c.createdAt)
          .run();
      }
    },

    async listChunksByDoc(docId) {
      const res = await db
        .prepare(`SELECT * FROM chunks WHERE doc_id = ? ORDER BY idx ASC`)
        .bind(docId)
        .all<ChunkRow>();
      return (res.results ?? []).map(rowToChunk);
    },

    async getChunksByIds(ids) {
      if (!ids.length) return [];
      const holes = ids.map(() => "?").join(", ");
      const res = await db.prepare(`SELECT * FROM chunks WHERE id IN (${holes})`).bind(...ids).all<ChunkRow>();
      const map = new Map((res.results ?? []).map((r) => [r.id, rowToChunk(r)]));
      // 保持传入顺序（调用方按相似度排好序，重排会破坏引用编号）
      return ids.map((id) => map.get(id)).filter((c): c is Chunk => Boolean(c));
    },

    async insertQa(record) {
      await db
        .prepare(`INSERT INTO qa_history (id, question, answer_json, cited_doc_ids, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(record.id, record.question, JSON.stringify(record.result), JSON.stringify(record.citedDocIds), record.createdAt)
        .run();
    },

    async listQa(limit = 50) {
      const res = await db
        .prepare(`SELECT * FROM qa_history ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all<QaRow>();
      return (res.results ?? []).map(rowToQa);
    },
  };
}

// ---------------------------------------------------------------- Vectorize 实现

export type VectorizeLike = {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<unknown>;
  query(vector: number[], options: { topK: number; returnValues?: boolean; returnMetadata?: boolean }): Promise<{
    matches?: Array<{ id: string; score: number }>;
  }>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<Array<{ id: string }>>;
};

export function createVectorizeIndex(vec: VectorizeLike): VectorIndex {
  return {
    async upsert(items) {
      if (!items.length) return;
      await vec.upsert(items);
    },
    async query(vector, topK) {
      const res = await vec.query(vector, { topK, returnValues: false, returnMetadata: false });
      return (res.matches ?? []).map((m) => ({ id: m.id, score: Number(m.score) }));
    },
    async deleteByIds(ids) {
      if (!ids.length) return;
      await vec.deleteByIds(ids);
    },
    async existing(ids) {
      if (!ids.length) return [];
      const rows = await vec.getByIds(ids);
      return rows.map((r) => r.id);
    },
  };
}
