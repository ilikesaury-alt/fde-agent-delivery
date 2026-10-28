/**
 * 领域类型（单一真源：D1 列名 ↔ 领域对象 ↔ API 返回）
 */

export type DocSource = "paste" | "file" | "url" | "pdf";
export type DocStatus = "pending" | "indexing" | "ready" | "failed";

export type Document = {
  id: string;
  source: DocSource;
  sourceRef: string | null;
  title: string;
  contentHash: string;
  status: DocStatus;
  chunkCount: number;
  error: string | null;
  createdAt: number;
  /** 索引确认时间（向量写入被平台接受的时刻；检索立即可见性由 Vectorize 决定） */
  indexedAt?: number;
};

/** 列表用：不含正文（避免一次列表把全部原文搬进 Worker） */
export type DocumentSlim = Omit<Document, "contentHash">;

export type Chunk = {
  id: string;
  docId: string;
  idx: number;
  /** 「3.2 部署」这类可读路径；引用展示用，空串表示无标题上下文 */
  headingPath: string;
  text: string;
  createdAt: number;
};

/** 检索命中：chunk + 相似度 */
export type Hit = {
  chunk: Chunk;
  score: number;
};

/** 引用块（返回给前端 / 落库） */
export type Citation = {
  /** 1-based，与回答正文里的 [1][2] 对应 */
  index: number;
  docId: string;
  docTitle: string;
  headingPath: string;
  /** 片段原文（截断展示） */
  snippet: string;
  score: number;
};

/** 拒答时展示的「最相近片段」（未通过阈值） */
export type NearestHit = {
  chunkId: string;
  docTitle: string;
  headingPath: string;
  snippet: string;
  score: number;
};

export type AskResult = {
  answer: string;
  citations: Citation[];
  refused: boolean;
  /** 拒答时给出「最相近片段」帮助用户判断是否该补语料 */
  nearest?: NearestHit[];
  /**
   * 拒答时另有说明：库内最近 90 秒有文档刚写完索引。
   * 动机（线上实测 2026-10-28）：Vectorize 的 upsert 是异步的，导入接口早就返回
   * ready，但真正可检索约需 50 秒。这期间提问必然拒答 —— 不给提示的话，
   * 用户会判定成「上传失败 / 搜索坏了」。
   */
  indexingRecently?: boolean;
};

export type QaRecord = {
  id: string;
  question: string;
  result: AskResult;
  citedDocIds: string[];
  createdAt: number;
};

/** 切分产物（入库前） */
export type ChunkDraft = {
  idx: number;
  headingPath: string;
  text: string;
};
