/**
 * 存储抽象 —— 让「线上 D1+Vectorize」与「本地内存 shim」跑同一套业务代码与单测。
 *
 * 拆两个接口而不是一个：
 *   Repo        元数据（D1 / node:sqlite）
 *   VectorIndex 向量（Vectorize / 内存余弦）
 * 理由：两者的失败模式与可测性完全不同（SQL 语义 vs 近邻检索），混在一起会
 * 逼出「本地为了跑通而伪造 SQL」的假绿（产品② d1-shim 的教训）。
 */

import type {
  Chunk,
  Conversation,
  ConversationMessage,
  DocStatus,
  Document,
  DocumentSlim,
  DocSource,
  Hit,
  QaRecord,
} from "./types.ts";

export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

/** 倒排检索的一行（dl = 所在 chunk 的文本长度，作为 BM25 的文档长度） */
export type TermHitRow = { term: string; chunkId: string; tf: number; dl: number };

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
    patch: { status?: DocStatus; chunkCount?: number; error?: string | null; title?: string; indexedAt?: number },
  ): Promise<void>;
  /** 删除文档元数据 + 其全部 chunks；返回被删 chunk id（调用方据此删向量） */
  deleteDocument(id: string): Promise<string[]>;

  insertChunks(chunks: Chunk[]): Promise<void>;
  listChunksByDoc(docId: string): Promise<Chunk[]>;
  getChunksByIds(ids: string[]): Promise<Chunk[]>;

  // ── 关键词倒排（二期混合检索，CONTEXT D20）────────────────────
  /** 批量写入 term（调用方已按 chunk 截断到 MAX_TERMS_PER_CHUNK） */
  insertChunkTerms(rows: Array<{ term: string; chunkId: string; tf: number }>): Promise<void>;
  /** 倒排检索：返回每个 (term, chunk) 的 tf 与该 chunk 的文本长度（BM25 的 dl） */
  searchTerms(terms: string[], limit?: number): Promise<TermHitRow[]>;
  /** 库内可检索片段的规模统计（BM25 的 N 与 avgdl），只统计 ready 文档 */
  chunkStats(): Promise<{ n: number; avgdl: number }>;

  // ── 会话（二期多轮，CONTEXT D18/D19）──────────────────────────
  insertConversation(c: { id: string; title: string; createdAt: number; updatedAt: number }): Promise<void>;
  listConversations(limit?: number): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  updateConversation(id: string, patch: { title?: string; updatedAt?: number }): Promise<void>;
  /** 删除会话及其全部消息，返回被删消息数 */
  deleteConversation(id: string): Promise<number>;

  insertMessage(m: ConversationMessage): Promise<void>;
  /** 会话内消息，**倒序**（最新在前；生成上下文时由调用方反转） */
  listMessages(conversationId: string, limit?: number): Promise<ConversationMessage[]>;
  /** 跨会话的最近消息（历史接口用，倒序） */
  listRecentMessages(limit?: number): Promise<ConversationMessage[]>;

  // ── 一期兼容（qa_history 停止写入，仅兼容读，见 CONTEXT D23）──
  /** 一期写入口：保留给旧数据/测试夹具，路由不再调用 */
  insertQa(record: QaRecord): Promise<void>;
  /** 兼容读 qa_history（旧记录）；二期新真源是 messages，见 listRecentMessages */
  listQa(limit?: number): Promise<QaRecord[]>;
};

/** 向量索引抽象（写入的向量必须与 chunk id 一一对应） */
export type VectorIndex = {
  upsert(items: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<void>;
  query(vector: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
  deleteByIds(ids: string[]): Promise<void>;
  /** 回读校验用：返回实际存在的 id */
  existing(ids: string[]): Promise<string[]>;
  /** 用向量 id 直接查（可见性优于 getByIds；线上实测必需） */
  queryById(id: string, options: { topK: number }): Promise<{ matches?: Array<{ id: string; score: number }> }>;
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
  indexed_at?: number | null;
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
    indexedAt: r.indexed_at == null ? undefined : Number(r.indexed_at),
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

type ConvRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  turn_count?: number | null;
};

type MsgRow = {
  id: string;
  conversation_id: string;
  question: string;
  answer_json: string | null;
  cited_doc_ids: string | null;
  refused: number | null;
  retrieval_query: string | null;
  created_at: number;
};

function rowToConversation(r: ConvRow): Conversation {
  return {
    id: r.id,
    title: r.title ?? "",
    turnCount: Number(r.turn_count ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function parseIdList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // 单条坏数据不该让整页 500
    return [];
  }
}

function rowToMessage(r: MsgRow): ConversationMessage {
  let result: ConversationMessage["result"] = { answer: "", citations: [], refused: false };
  if (r.answer_json) {
    try {
      result = JSON.parse(r.answer_json) as ConversationMessage["result"];
    } catch {
      // 同上：坏数据降级为空结果
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    question: r.question,
    result,
    citedDocIds: parseIdList(r.cited_doc_ids),
    refused: Number(r.refused ?? 0) === 1 || Boolean(result.refused),
    retrievalQuery: r.retrieval_query ?? "",
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
  "id, source, source_ref, title, status, chunk_count, error, created_at, content_hash, indexed_at";

/**
 * ⚠️ D1 单条 SQL 的**绑定变量上限是 100**（本地 node:sqlite / SQLite 默认是 32766）。
 *
 * 这就是「本地全绿、线上 502」的来源：按「行数」分批是错的，必须按**变量个数**分批。
 * 实测（2026-10-28 线上）：`insert or replace … values (?,?,?) × 100 行` = 300 变量 →
 * `too many SQL variables at offset 330: SQLITE_ERROR [code: 7500]` → 导入整体 502。
 * 因此这里统一按变量数切批，任何多值语句都不得超过这个上限。
 */
export const D1_MAX_SQL_PARAMS = 100;

/**
 * 多值 INSERT 分批写入：按「变量数」切批（每行 3 个变量 → 每句最多 33 行）。
 */
async function insertTermRows(
  db: D1Like,
  rows: Array<{ term: string; chunkId: string; tf: number }>,
  paramsPerRow = 3,
): Promise<void> {
  const rowsPerStmt = Math.max(1, Math.floor(D1_MAX_SQL_PARAMS / paramsPerRow));
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const values = slice.map(() => "(?, ?, ?)").join(", ");
    const args = slice.flatMap((r) => [r.term, r.chunkId, r.tf]);
    await db.prepare(`INSERT OR REPLACE INTO chunk_terms (term, chunk_id, tf) VALUES ${values}`).bind(...args).run();
  }
}

/** 删除 chunk 时同步清倒排（否则关键词通道会召回已删文档的孤儿片段） */
async function deleteTermsByChunkIds(db: D1Like, ids: string[]): Promise<void> {
  const perStmt = D1_MAX_SQL_PARAMS; // 每行 1 个变量
  for (let i = 0; i < ids.length; i += perStmt) {
    const slice = ids.slice(i, i + perStmt);
    const holes = slice.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM chunk_terms WHERE chunk_id IN (${holes})`).bind(...slice).run();
  }
}

/**
 * 跨会话最近消息（`/api/history` 用）。
 *
 * JOIN conversations 是**必需的**：删会话不是事务（先删 messages 再删 conversation），
 * 并发场景（A 标签页在流式作答、B 标签页删了会话）会留下指向已删会话的孤儿 message
 * （cross-review 发现 #1）。这里从读侧兜住，孤儿行不会出现在历史里。
 */
async function selectRecentMessages(db: D1Like, limit: number): Promise<ConversationMessage[]> {
  const res = await db
    .prepare(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    )
    .bind(limit)
    .all<MsgRow>();
  return (res.results ?? []).map(rowToMessage);
}

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
      if (patch.indexedAt !== undefined) {
        sets.push("indexed_at = ?");
        args.push(patch.indexedAt);
      }
      if (!sets.length) return;
      args.push(id);
      await db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
    },

    async deleteDocument(id) {
      const res = await db.prepare(`SELECT id FROM chunks WHERE doc_id = ?`).bind(id).all<{ id: string }>();
      const ids = (res.results ?? []).map((r) => r.id);
      if (ids.length) await deleteTermsByChunkIds(db, ids);
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
      // 按变量数切批（D1 上限 100，见 D1_MAX_SQL_PARAMS 注释）
      const map = new Map<string, Chunk>();
      const perStmt = D1_MAX_SQL_PARAMS;
      for (let i = 0; i < ids.length; i += perStmt) {
        const slice = ids.slice(i, i + perStmt);
        const holes = slice.map(() => "?").join(", ");
        const res = await db.prepare(`SELECT * FROM chunks WHERE id IN (${holes})`).bind(...slice).all<ChunkRow>();
        for (const r of res.results ?? []) map.set(r.id, rowToChunk(r));
      }
      // 保持传入顺序（调用方按相似度排好序，重排会破坏引用编号）
      return ids.map((id) => map.get(id)).filter((c): c is Chunk => Boolean(c));
    },

    async insertChunkTerms(rows) {
      if (!rows.length) return;
      await insertTermRows(db, rows);
    },

    async searchTerms(terms, limit = 5000) {
      if (!terms.length) return [];
      // ⚠️ 按 term 分别取行，而不是一条 `WHERE term IN (...)` 查询：
      // 常见 bigram 的倒排行会整段吃掉全局 LIMIT 配额，导致罕见错误码被截断
      // （cross-review 发现 #6）。每 term 的上限让「每个词都有机会被看到」。
      const perTerm = Math.min(400, Math.max(50, Math.ceil(limit / terms.length)));
      const rows = await Promise.all(
        terms.map((term) =>
          db
            .prepare(
              // dl 用 LENGTH(c.text) 作代理（0004 不加列，见迁移注释的幂等约束）
              `SELECT t.term AS term, t.chunk_id AS chunkId, t.tf AS tf, LENGTH(c.text) AS dl
                 FROM chunk_terms t JOIN chunks c ON c.id = t.chunk_id
                WHERE t.term = ?
                LIMIT ?`,
            )
            .bind(term, perTerm)
            .all<{ term: string; chunkId: string; tf: number; dl: number }>(),
        ),
      );
      return rows.flatMap((res) =>
        (res.results ?? []).map((r) => ({
          term: String(r.term),
          chunkId: String(r.chunkId),
          tf: Number(r.tf),
          dl: Number(r.dl),
        })),
      );
    },

    async chunkStats() {
      // 只统计 ready 文档：与 retrieve 的「只认 ready」同一口径
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n, AVG(LENGTH(c.text)) AS avgdl
             FROM chunks c JOIN documents d ON d.id = c.doc_id
            WHERE d.status = 'ready'`,
        )
        .bind()
        .first<{ n: number | null; avgdl: number | null }>();
      return { n: Number(row?.n ?? 0), avgdl: Number(row?.avgdl ?? 0) };
    },

    async insertConversation(c) {
      await db
        .prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .bind(c.id, c.title, c.createdAt, c.updatedAt)
        .run();
    },

    async listConversations(limit = 50) {
      const res = await db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS turn_count
             FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all<ConvRow>();
      return (res.results ?? []).map(rowToConversation);
    },

    async getConversation(id) {
      const row = await db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS turn_count
             FROM conversations c WHERE c.id = ?`,
        )
        .bind(id)
        .first<ConvRow>();
      return row ? rowToConversation(row) : null;
    },

    async updateConversation(id, patch) {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (patch.title !== undefined) {
        sets.push("title = ?");
        args.push(patch.title);
      }
      if (patch.updatedAt !== undefined) {
        sets.push("updated_at = ?");
        args.push(patch.updatedAt);
      }
      if (!sets.length) return;
      args.push(id);
      await db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
    },

    async deleteConversation(id) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`)
        .bind(id)
        .first<{ n: number | null }>();
      await db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).bind(id).run();
      await db.prepare(`DELETE FROM conversations WHERE id = ?`).bind(id).run();
      return Number(row?.n ?? 0);
    },

    async insertMessage(m) {
      await db
        .prepare(
          `INSERT INTO messages (id, conversation_id, question, answer_json, cited_doc_ids, refused, retrieval_query, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          m.id,
          m.conversationId,
          m.question,
          JSON.stringify(m.result),
          JSON.stringify(m.citedDocIds),
          m.refused ? 1 : 0,
          m.retrievalQuery,
          m.createdAt,
        )
        .run();
    },

    async listMessages(conversationId, limit = 50) {
      // rowid 兜住「同毫秒写入的两条消息」的先后（随机 id 排序会把正序打乱，cross-review 发现 #2）
      const res = await db
        .prepare(
          `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .bind(conversationId, limit)
        .all<MsgRow>();
      return (res.results ?? []).map(rowToMessage);
    },

    async listRecentMessages(limit = 50) {
      return selectRecentMessages(db, limit);
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
  queryById?(
    id: string,
    options: { topK: number; returnValues?: boolean },
  ): Promise<{ matches?: Array<{ id: string; score: number; values?: number[] }> }>;
  /** 用向量 id 直接查（可见性优于 getByIds；运行时绑定提供） */
};

export function createVectorizeIndex(vec: VectorizeLike): VectorIndex {
  return {
    async upsert(items) {
      if (!items.length) return;
      await vec.upsert(items);
    },
    async query(vector, topK) {
      // ⚠️ 只传 topK。线上 runtime 绑定对 returnMetadata/returnValues 的 false 值解析会失败
      //    （实测 VECTOR_QUERY_ERROR 40026: returnMetadata expected value），
      //    且我们本来只需要 id 与 score（原文存在 D1，不靠 metadata 取）。
      const res = await vec.query(vector, { topK });
      return (res.matches ?? []).map((m) => ({ id: m.id, score: Number(m.score) }));
    },
    async deleteByIds(ids) {
      if (!ids.length) return;
      await vec.deleteByIds(ids);
    },
    /**
     * 判断向量是否已可见。
     *
     * ⚠️ 不能用 getByIds：线上实测 upsert 之后立即 getByIds 返回 []
     *    （即使索引 query 已经能命中、metadata 也已写入），可见性延迟明显。
     *    query 的可见性与写入同步，所以用它做探针（用 chunk 自己的向量查询自身）。
     */
    async queryById(id, options) {
      if (typeof vec.queryById !== "function") return { matches: [] };
      // 需要向量值才能做「二次 query 可见性探测」
      return vec.queryById(id, { topK: options.topK, returnValues: true });
    },

    /**
     * 判断向量是否已可见。
     *
     * ⚠️ 线上实测（2026-10-28，多次复现）：
     *    -  `getByIds` 在 upsert 之后 >10s 仍返回空
     *    -  `queryById` 同样滞后
     *    -  **`query` 在 upsert 之后即时可见**（同批向量能立即被检索命中，score 0.52+）
     * 所以可见性探针只能用 `query`。做法：用待确认向量的 id 回查索引，
     * 能查到自己（同 id 命中）即证明已可检索 —— 这也正是业务真正关心的事实。
     */
    async existing(ids) {
      if (!ids.length) return [];
      const rows = await vec.getByIds(ids);
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      if (!missing.length) return ids;

      // 用 queryById 取回该向量的自身向量，再用普通 query 验证可见性
      if (typeof vec.queryById === "function") {
        for (const id of missing) {
          try {
            const self = await vec.queryById(id, { topK: 1 });
            const vector = (self as { matches?: Array<{ id: string }> })?.matches?.[0];
            // queryById 也滞后时无法拿到向量，交给外层重试
            if (!vector || vector.id !== id) continue;
            const probe = await vec.query(
              (self as { matches?: Array<{ values?: number[] }> }).matches?.[0]?.values ?? [],
              { topK: 1 },
            );
            const hit = (probe as { matches?: Array<{ id: string }> })?.matches?.some((m) => m.id === id);
            if (hit) found.add(id);
          } catch {
            // 单条探测失败不影响整体结论
          }
        }
      }
      return ids.filter((id) => found.has(id));
    },
  };
}

// -------------------------------------------------- 最终一致性等待（线上实测必需）

/**
 * 确认向量写入「已被平台接受」。
 *
 * ⚠️ 语义边界（线上实测 2026-10-28，多次复现）：
 *   Vectorize 的 upsert 是**异步**的 —— 返回 mutationId 即代表已入队，
 *   但随后数十秒内 query / queryById / getByIds **全部读不到**新向量，
 *   数据会在几十秒~几分钟后进入索引。
 *   所以「写完立刻回读」不能用作失败判据，只能用于**观测**。
 *
 * 本函数做的是「可见性观测」：能在第一次就看见最好（内存替身永远如此），
 * 看不见也**不算失败**，由调用方按异步验收处理。
 * （第 3 个返回值 attempts 记录第几次才看见，用于日志。）
 */
export async function awaitVectorAcceptance(
  index: VectorIndex,
  ids: string[],
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<{ visible: string[]; missing: string[]; attempts: number }> {
  const attempts = opts.attempts ?? 2;
  const base = opts.baseDelayMs ?? 200;
  let missing = [...ids];
  for (let i = 0; i < attempts; i++) {
    const present = new Set(await index.existing(ids));
    missing = ids.filter((id) => !present.has(id));
    if (!missing.length) return { visible: ids, missing: [], attempts: i + 1 };
    // 只做极短探测：这里的目的是「顺手确认」，不是等待
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, base));
  }
  return { visible: ids.filter((id) => !missing.includes(id)), missing, attempts };
}

/** 等待向量「消失」（删除同样受最终一致性影响） */
export async function awaitVectorAbsence(
  index: VectorIndex,
  ids: string[],
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<{ leftover: string[]; attempts: number }> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 250;
  let leftover = [...ids];
  for (let i = 0; i < attempts; i++) {
    leftover = await index.existing(ids);
    if (!leftover.length) return { leftover: [], attempts: i + 1 };
    await new Promise((r) => setTimeout(r, Math.min(base * 2 ** i, 1500)));
  }
  return { leftover, attempts };
}
