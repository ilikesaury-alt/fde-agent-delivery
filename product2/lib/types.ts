/** 产品② 领域类型（术语表口径：SourceMaterial / XhsNote / GenerationJob / pipeline） */

/** 素材来源类型 */
export type SourceType = "url" | "text";

/** 小红书图文笔记（输出结构） */
export type XhsNote = {
  /** titles[0] = 主标题，其余为备选（目标 3 个） */
  titles: string[];
  /** 正文（含 emoji，目标 300–600 字） */
  body: string;
  /** 话题标签（不含 # 前缀，3–6 个） */
  tags: string[];
};

export type JobStatus = "succeeded" | "failed";

/** 一次流水线运行 = 一条历史记录 */
export type GenerationJob = {
  id: string;
  /** Unix 毫秒 */
  createdAt: number;
  sourceType: SourceType;
  /** 仅 sourceType=url 时有值 */
  sourceUrl: string | null;
  /** 素材摘要（列表展示用，取正文前 N 字） */
  sourceExcerpt: string;
  /** 原始素材全文（「重新生成」复用） */
  sourceText: string;
  /** 超长素材经 LLM 压缩的要点；未压缩时为 null */
  materialBrief: string | null;
  /** 生成结果；失败时为 null */
  note: XhsNote | null;
  status: JobStatus;
  /** status=failed 时的用户可读原因 */
  error: string | null;
};

/** 历史列表用（不含原文全文与压缩要点，省流量） */
export type GenerationJobSlim = Omit<GenerationJob, "sourceText" | "materialBrief">;

/** 流水线步骤标识 */
export type PipelineStep = "fetch" | "prepare" | "generate";

/** 流水线进度事件 */
export type PipelineEvent =
  | { type: "step"; step: PipelineStep; status: "started" | "done" | "failed" | "skipped"; detail?: string }
  | { type: "token"; text: string };
