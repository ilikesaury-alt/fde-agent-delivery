/**
 * 存储层：D1 实现 + 内存实现同接口（同③ 的 Repo 模式）。
 *
 * 为什么两份实现都放在 lib/ 而不是把内存版塞进 test/：
 *   本地 `verify:local` 也要跑完整链路（沙箱起不了 workerd），
 *   内存版是「本地可验证」这条链的一等公民，不是测试专用的假货。
 */

import type {
  Metric,
  MetricStatus,
  Report,
  ReportSlim,
  ReportSource,
} from "./types.ts";
import type { TrendInput } from "./trend.ts";

export type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type NewReport = Omit<Report, "metricCount"> & { metricCount?: number };
export type NewMetric = Metric;

export type Repo = {
  insertReport(report: NewReport, metrics: Metric[]): Promise<void>;
  /**
   * 向已有报告**追加**指标并更新 metric_count（手工补录合并用）。
   * 为什么不是「删了重写」：删-插之间有一个窗口，若插入失败，用户原有数据就没了。
   * 追加是幂等无关的单向操作，失败最多是「这次没加进去」。
   */
  appendMetrics(reportId: string, metrics: Metric[], newCount: number): Promise<void>;
  listReports(limit?: number): Promise<ReportSlim[]>;
  getReport(id: string): Promise<Report | null>;
  listMetricsByReport(reportId: string): Promise<Metric[]>;
  /** 全部指标 + 检测日期（趋势聚合输入）。limit 用于防御性上限。 */
  listTrendInputs(profileId: string, limit?: number): Promise<TrendInput[]>;
  /** 某标准指标的全部历史（解读用，含检测日期） */
  listMetricHistory(profileId: string, standardName: string): Promise<TrendInput[]>;
  /** 删除报告（其指标级联删除）；返回是否真的删掉了 */
  deleteReport(id: string): Promise<boolean>;
};

/* ─────────────────────────── D1 ─────────────────────────── */

type ReportRow = {
  id: string;
  profile_id: string;
  source_type: string;
  file_name: string | null;
  check_date: string;
  hospital: string | null;
  raw_text: string;
  metric_count: number;
  created_at: number;
};

type MetricRow = {
  id: string;
  report_id: string;
  profile_id: string;
  standard_name: string;
  raw_name: string;
  value_num: number | null;
  value_text: string;
  unit: string | null;
  ref_low: number | null;
  ref_high: number | null;
  ref_text: string | null;
  status: string;
  source_quote: string | null;
  created_at: number;
};

function toReport(r: ReportRow): Report {
  return {
    id: r.id,
    profileId: r.profile_id,
    sourceType: r.source_type as ReportSource,
    fileName: r.file_name,
    checkDate: r.check_date,
    hospital: r.hospital,
    rawText: r.raw_text,
    metricCount: r.metric_count,
    createdAt: r.created_at,
  };
}

function toSlim(r: ReportRow): ReportSlim {
  const { rawText: _rawText, ...rest } = toReport(r);
  return rest;
}

function toMetric(r: MetricRow): Metric {
  return {
    id: r.id,
    reportId: r.report_id,
    profileId: r.profile_id,
    standardName: r.standard_name,
    rawName: r.raw_name,
    valueNum: r.value_num,
    valueText: r.value_text,
    unit: r.unit,
    refLow: r.ref_low,
    refHigh: r.ref_high,
    refText: r.ref_text,
    status: r.status as MetricStatus,
    sourceQuote: r.source_quote,
    createdAt: r.created_at,
  };
}

/** D1 单条 SQL 的绑定变量上限：100（实测，见 cf-worker-local-env）。批量插入按变量数分批。 */
const MAX_SQL_PARAMS = 100;

const METRIC_COLS = 14;
const METRICS_PER_BATCH = Math.floor(MAX_SQL_PARAMS / METRIC_COLS);

export function createD1Repo(db: D1Like | undefined): Repo {
  if (!db) throw new Error("D1 绑定缺失（env.DB），请检查部署绑定。");

  return {
    async insertReport(report, metrics) {
      await db
        .prepare(
          `INSERT INTO reports (id, profile_id, source_type, file_name, check_date, hospital, raw_text, metric_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          report.id,
          report.profileId,
          report.sourceType,
          report.fileName,
          report.checkDate,
          report.hospital,
          report.rawText,
          metrics.length,
          report.createdAt,
        )
        .run();

      // 按**变量数**分批（不是按行数）—— 14 列 × 7 行 = 98 ≤ 100
      try {
      for (let i = 0; i < metrics.length; i += METRICS_PER_BATCH) {
        const batch = metrics.slice(i, i + METRICS_PER_BATCH);
        const valuesSql = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
        const params: unknown[] = [];
        for (const m of batch) {
          params.push(
            m.id,
            m.reportId,
            m.profileId,
            m.standardName,
            m.rawName,
            m.valueNum,
            m.valueText,
            m.unit,
            m.refLow,
            m.refHigh,
            m.refText,
            m.status,
            m.sourceQuote,
            m.createdAt,
          );
        }
        await db
          .prepare(
            `INSERT INTO metrics (id, report_id, profile_id, standard_name, raw_name, value_num, value_text, unit, ref_low, ref_high, ref_text, status, source_quote, created_at)
             VALUES ${valuesSql}`,
          )
          .bind(...params)
          .run();
      }
      } catch (err) {
        // 半份报告比没有报告更糟：指标不全但界面看起来「已入库」。
        // 失败时把它删掉，让用户看到明确的失败而不是残缺数据。
        await db.prepare(`DELETE FROM metrics WHERE report_id = ?`).bind(report.id).run().catch(() => {});
        await db.prepare(`DELETE FROM reports WHERE id = ?`).bind(report.id).run().catch(() => {});
        throw err;
      }
    },

    async appendMetrics(reportId, metrics, newCount) {
      for (let i = 0; i < metrics.length; i += METRICS_PER_BATCH) {
        const batch = metrics.slice(i, i + METRICS_PER_BATCH);
        const valuesSql = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
        const params: unknown[] = [];
        for (const m of batch) {
          params.push(
            m.id, m.reportId, m.profileId, m.standardName, m.rawName, m.valueNum, m.valueText,
            m.unit, m.refLow, m.refHigh, m.refText, m.status, m.sourceQuote, m.createdAt,
          );
        }
        await db
          .prepare(
            `INSERT INTO metrics (id, report_id, profile_id, standard_name, raw_name, value_num, value_text, unit, ref_low, ref_high, ref_text, status, source_quote, created_at)
             VALUES ${valuesSql}`,
          )
          .bind(...params)
          .run();
      }
      await db.prepare(`UPDATE reports SET metric_count = ? WHERE id = ?`).bind(newCount, reportId).run();
    },

    async listReports(limit = 100) {
      const { results } = await db
        .prepare(
          `SELECT id, profile_id, source_type, file_name, check_date, hospital, raw_text, metric_count, created_at
             FROM reports ORDER BY check_date DESC, created_at DESC LIMIT ?`,
        )
        .bind(Math.max(1, Math.min(limit, 500)))
        .all<ReportRow>();
      return (results ?? []).map(toSlim);
    },

    async getReport(id) {
      const row = await db
        .prepare(
          `SELECT id, profile_id, source_type, file_name, check_date, hospital, raw_text, metric_count, created_at
             FROM reports WHERE id = ?`,
        )
        .bind(id)
        .first<ReportRow>();
      return row ? toReport(row) : null;
    },

    async listMetricsByReport(reportId) {
      const { results } = await db
        .prepare(
          `SELECT id, report_id, profile_id, standard_name, raw_name, value_num, value_text, unit,
                  ref_low, ref_high, ref_text, status, source_quote, created_at
             FROM metrics WHERE report_id = ? ORDER BY id`,
        )
        .bind(reportId)
        .all<MetricRow>();
      return (results ?? []).map(toMetric);
    },

    async listTrendInputs(profileId, limit = 5000) {
      const { results } = await db
        .prepare(
          `SELECT m.id, m.report_id, m.profile_id, m.standard_name, m.raw_name, m.value_num, m.value_text,
                  m.unit, m.ref_low, m.ref_high, m.ref_text, m.status, m.source_quote, m.created_at,
                  r.check_date AS check_date
             FROM metrics m JOIN reports r ON r.id = m.report_id
            WHERE m.profile_id = ? AND m.value_num IS NOT NULL
            ORDER BY r.check_date ASC LIMIT ?`,
        )
        .bind(profileId, Math.max(1, Math.min(limit, 20_000)))
        .all<MetricRow & { check_date: string }>();
      return (results ?? []).map((row) => ({ metric: toMetric(row), checkDate: row.check_date }));
    },

    async listMetricHistory(profileId, standardName) {
      const { results } = await db
        .prepare(
          `SELECT m.id, m.report_id, m.profile_id, m.standard_name, m.raw_name, m.value_num, m.value_text,
                  m.unit, m.ref_low, m.ref_high, m.ref_text, m.status, m.source_quote, m.created_at,
                  r.check_date AS check_date
             FROM metrics m JOIN reports r ON r.id = m.report_id
            WHERE m.profile_id = ? AND m.standard_name = ?
            ORDER BY r.check_date ASC`,
        )
        .bind(profileId, standardName)
        .all<MetricRow & { check_date: string }>();
      return (results ?? []).map((row) => ({ metric: toMetric(row), checkDate: row.check_date }));
    },

    async deleteReport(id) {
      // 先删子行（不依赖 D1 是否开启外键级联），再删报告 —— 顺序固定，避免悬挂指标
      await db.prepare(`DELETE FROM metrics WHERE report_id = ?`).bind(id).run();
      const res = (await db.prepare(`DELETE FROM reports WHERE id = ?`).bind(id).run()) as
        | { meta?: { changes?: number }; changes?: number }
        | undefined;
      const changes = res?.meta?.changes ?? res?.changes;
      return changes == null ? true : changes > 0;
    },
  };
}

/* ────────────────────────── 内存实现 ────────────────────────── */

/** 内存 Repo：本地 verify、单测、沙箱演示用；语义必须与 D1 版逐条对齐。 */
export function createMemoryRepo(): Repo & { _size(): { reports: number; metrics: number } } {
  const reports = new Map<string, Report>();
  const metrics = new Map<string, Metric>();

  const inputs = (pred: (m: Metric) => boolean): TrendInput[] => {
    const out: TrendInput[] = [];
    for (const m of metrics.values()) {
      if (!pred(m)) continue;
      const r = reports.get(m.reportId);
      if (!r) continue;
      out.push({ metric: m, checkDate: r.checkDate });
    }
    out.sort((a, b) =>
      a.checkDate < b.checkDate ? -1 : a.checkDate > b.checkDate ? 1 : a.metric.id < b.metric.id ? -1 : 1,
    );
    return out;
  };

  return {
    async insertReport(report, rows) {
      reports.set(report.id, { ...report, metricCount: rows.length });
      for (const m of rows) metrics.set(m.id, m);
    },

    async appendMetrics(reportId, rows, newCount) {
      const r = reports.get(reportId);
      if (!r) throw new Error(`报告不存在：${reportId}`);
      for (const m of rows) metrics.set(m.id, m);
      reports.set(reportId, { ...r, metricCount: newCount });
    },

    async listReports(limit = 100) {
      const all = [...reports.values()]
        .sort((a, b) => (a.checkDate < b.checkDate ? 1 : a.checkDate > b.checkDate ? -1 : b.createdAt - a.createdAt))
        .slice(0, Math.max(1, limit));
      return all.map(({ rawText: _rawText, ...rest }) => rest);
    },

    async getReport(id) {
      return reports.get(id) ?? null;
    },

    async listMetricsByReport(reportId) {
      return [...metrics.values()].filter((m) => m.reportId === reportId).sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    async listTrendInputs(profileId, limit = 5000) {
      return inputs((m) => m.profileId === profileId && m.valueNum != null).slice(0, limit);
    },

    async listMetricHistory(profileId, standardName) {
      return inputs((m) => m.profileId === profileId && m.standardName === standardName);
    },

    async deleteReport(id) {
      if (!reports.has(id)) return false;
      for (const [mid, m] of metrics) if (m.reportId === id) metrics.delete(mid);
      reports.delete(id);
      return true;
    },

    _size() {
      return { reports: reports.size, metrics: metrics.size };
    },
  };
}