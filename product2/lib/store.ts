/**
 * 历史记录存储。
 *
 * 为什么接口化：D1 在本地沙箱里起不来（workerd 不可 spawn），
 * 单测和 Node shim 必须能跑 → 测试/shim 用内存实现，线上用 D1 实现。
 *
 * 只用 D1 的最小 API 子集（prepare/bind/all/first/run），不引 ORM：
 * 单表 10 个字段，ORM 带来的类型与迁移成本 > 收益（奥卡姆）。
 */

import type { GenerationJob, GenerationJobSlim, JobStatus, XhsNote } from "./types.ts";

/** D1Database 的最小结构子集（避免依赖 workers-types 全局声明） */
export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type JobStore = {
  insert(job: GenerationJob): Promise<void>;
  /** 按时间倒序（不含原文全文与压缩要点，省流量） */
  list(limit?: number): Promise<GenerationJobSlim[]>;
  get(id: string): Promise<GenerationJob | null>;
  /** 返回是否真的删掉了一行 */
  remove(id: string): Promise<boolean>;
};

/** 注：id 拼写为 JobRow，与表列同名 */
type JobRow = {
  id: string;
  created_at: number;
  source_type: string;
  source_url: string | null;
  source_excerpt: string;
  /** 列表查询不含该列，此时为 undefined */
  source_text?: string;
  /** 列表查询不含该列，此时为 undefined */
  material_brief?: string | null;
  note_json: string | null;
  status: string;
  error: string | null;
};

function rowToJob(row: JobRow): GenerationJob {
  let note: XhsNote | null = null;
  if (row.note_json) {
    try {
      note = JSON.parse(row.note_json) as XhsNote;
    } catch {
      note = null;
    }
  }
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    sourceType: row.source_type === "url" ? "url" : "text",
    sourceUrl: row.source_url ?? null,
    sourceExcerpt: row.source_excerpt ?? "",
    sourceText: row.source_text ?? "",
    materialBrief: row.material_brief ?? null,
    note,
    // 未知 status 一律按失败处理：静默当成功会让脏数据看起来正常
    status: (row.status === "succeeded" ? "succeeded" : "failed") as JobStatus,
    error: row.error ?? null,
  };
}

function rowToSlim(row: JobRow): GenerationJobSlim {
  const { sourceText, materialBrief, ...rest } = rowToJob(row);
  void sourceText;
  void materialBrief;
  return rest;
}

/**
 * list 用的显式列：绝不 SELECT *
 * —— 否则一次历史列表最多要把 50 × 3 万字原文搬进 Worker 再丢掉（D1 读放大 + 内存）。
 */
const SLIM_COLUMNS = "id, created_at, source_type, source_url, source_excerpt, note_json, status, error";

export function createD1Store(db: D1Like): JobStore {
  return {
    async insert(job) {
      await db
        .prepare(
          `INSERT INTO jobs
             (id, created_at, source_type, source_url, source_excerpt, source_text, material_brief, note_json, status, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          job.id,
          job.createdAt,
          job.sourceType,
          job.sourceUrl,
          job.sourceExcerpt,
          job.sourceText,
          job.materialBrief,
          job.note ? JSON.stringify(job.note) : null,
          job.status,
          job.error,
        )
        .run();
    },
    async list(limit = 50) {
      const { results } = await db
        .prepare(`SELECT ${SLIM_COLUMNS} FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(limit)
        .all<JobRow>();
      return (results ?? []).map(rowToSlim);
    },
    async get(id) {
      const row = await db.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<JobRow>();
      return row ? rowToJob(row) : null;
    },
    async remove(id) {
      // 单条 DELETE ... RETURNING：一次 round-trip，且没有「先查再删」的 TOCTOU 窗口
      const deleted = await db
        .prepare(`DELETE FROM jobs WHERE id = ? RETURNING id`)
        .bind(id)
        .first<{ id: string }>();
      return deleted !== null;
    },
  };
}

/** 内存实现：单测 + Node shim 用。进程内有效，重启即清空。 */
export function createMemoryStore(): JobStore {
  const jobs = new Map<string, GenerationJob>();
  return {
    async insert(job) {
      // 存副本，避免调用方后续改动污染「已落库」的数据
      jobs.set(job.id, structuredClone(job));
    },
    async list(limit = 50) {
      return [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((j) => {
          const { sourceText, materialBrief, ...rest } = structuredClone(j);
          void sourceText;
          void materialBrief;
          return rest;
        });
    },
    async get(id) {
      const j = jobs.get(id);
      return j ? structuredClone(j) : null;
    },
    async remove(id) {
      return jobs.delete(id);
    },
  };
}
