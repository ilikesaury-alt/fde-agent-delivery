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

/** 命中来自哪条通道（混合检索：向量 / 关键词，可能叠加） */
export type HitSource = "vector" | "keyword";

/** 检索命中：chunk + 相似度（+ 混合检索的通道与名次信息） */
export type Hit = {
  chunk: Chunk;
  /** 向量相似度（关键词单独命中时为 0，不要拿它当「是否相关」的唯一判据） */
  score: number;
  /** 命中通道；一期只有 vector */
  sources?: HitSource[];
  /** 关键词通道的 BM25 分（无关键词命中时为空） */
  keywordScore?: number;
  /** 查询 term 覆盖率 0–1（对库内词表，关键词通道的入池判据） */
  coverage?: number;
  /** 命中项里的最小 df（越小越罕见；罕见词是关键词通道的价值来源） */
  minDf?: number;
  /** 是否命中了 code-like term（错误码/型号——融合时权重更高，过闸也不受选择性命中数限制） */
  codeMatched?: boolean;
  /** 命中的「选择性 term」个数（过闸：code-like 或 ≥2） */
  selectiveHits?: number;
  /** RRF 融合分（两路名次倒数之和） */
  rrf?: number;
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
  /** 这条引用是靠向量相似度还是关键词命中的（前端据此换展示文案） */
  matchedBy?: HitSource;
};

/** 拒答时展示的「最相近片段」（未通过阈值） */
export type NearestHit = {
  chunkId: string;
  docTitle: string;
  headingPath: string;
  snippet: string;
  score: number;
  /** 该片段没通过闸的原因：向量分太低，还是关键词覆盖率不够 */
  matchedBy?: HitSource;
  coverage?: number;
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
  /** 本次真正拿去检索的查询（多轮时可能是规则改写后的拼接查询，可观测/可核对） */
  retrievalQuery?: string;
  /** 检索查询是否被多轮上下文改写 */
  rewritten?: boolean;
};

export type QaRecord = {
  id: string;
  question: string;
  result: AskResult;
  citedDocIds: string[];
  createdAt: number;
};

/** 会话（一次连续追问 = 一个会话，标题取首问截断） */
export type Conversation = {
  id: string;
  title: string;
  /** 轮数（messages 行数），列表展示用 */
  turnCount: number;
  createdAt: number;
  updatedAt: number;
};

/** 会话内的一轮问答（二期新真源；一行 = 一问一答） */
export type ConversationMessage = {
  id: string;
  conversationId: string;
  question: string;
  result: AskResult;
  citedDocIds: string[];
  refused: boolean;
  /** 规则改写后真正用于检索的查询（为空表示与 question 一致） */
  retrievalQuery: string;
  createdAt: number;
};

/** 切分产物（入库前） */
export type ChunkDraft = {
  idx: number;
  headingPath: string;
  text: string;
};
