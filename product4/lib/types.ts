/** 产品④ 领域类型（单一权威源：db 表、API、前端共享同一套形状） */

/** 报告来源。manual = 手工补录（B 路径，无原文全文） */
export type ReportSource = "pdf" | "ocr" | "manual";

/** 指标状态。unknown = 参考范围无法解析 → **不判异常**（宁缺毋滥，CONTEXT D4） */
export type MetricStatus = "normal" | "high" | "low" | "unknown";

export type Report = {
  id: string;
  profileId: string;
  sourceType: ReportSource;
  fileName: string | null;
  /** 检测日期 YYYY-MM-DD（取自报告本身，不是上传时间） */
  checkDate: string;
  hospital: string | null;
  rawText: string;
  metricCount: number;
  createdAt: number;
};

/** 列表用的轻量报告（不含 rawText，避免列表接口把全文都吐出去） */
export type ReportSlim = Omit<Report, "rawText">;

export type Metric = {
  id: string;
  reportId: string;
  profileId: string;
  /** 归一后的标准名（趋势聚合键） */
  standardName: string;
  /** 报告原文名（展示/追溯） */
  rawName: string;
  /** 数值；定性指标（阴性/阳性）为 null */
  valueNum: number | null;
  /** 原文值（含 "<0.01" / "阴性" 这类非纯数值） */
  valueText: string;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  /** 参考范围原文，永远保留 */
  refText: string | null;
  status: MetricStatus;
  /** 报告原文片段（人工复核锚点） */
  sourceQuote: string | null;
  createdAt: number;
};

/** 抽取阶段产出的指标（尚无 id / reportId） */
export type ExtractedMetric = Omit<Metric, "id" | "reportId" | "profileId" | "createdAt">;

/** 抽取结果（LLM 输出经校验后的形状） */
export type ExtractedReport = {
  /** 报告日期建议值：**可为 null**（识别不到时由用户在确认闸补填 —— 不猜日期） */
  checkDate: string | null;
  hospital: string | null;
  metrics: ExtractedMetric[];
};

/** 趋势点（一次检测一个点） */
export type TrendPoint = {
  reportId: string;
  checkDate: string;
  valueNum: number;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  status: MetricStatus;
};

/** 一个指标的完整趋势序列 */
export type TrendSeries = {
  standardName: string;
  rawNames: string[];
  unit: string | null;
  points: TrendPoint[];
  /** 跨次对比时参考范围发生过变化（前端须可见，D4） */
  refChanged: boolean;
  /**
   * 跨次对比时**单位**发生过变化（如 mmol/L → mg/dL）。
   * 一旦为 true，折线本身是**不可比**的（数值尺度完全不同），前端必须显式警告，
   * 不能让人看着一条线以为「在变好」—— 这比趋势断裂更危险。
   */
  unitChanged: boolean;
};