/**
 * 服务层：把「抽取 → 校验 → 落库」串起来，让路由保持薄。
 *
 * 单独一层的价值：同一段逻辑被「确认入库」路由、本地 verify、E2E 三处复用，
 * 不会出现「路由里的实现和测试里的实现不一样」的漂移。
 */

import { ACTIVE_PROFILE } from "./http.ts";
import type { Repo } from "./repo.ts";
import type { ExtractedMetric, Metric, Report, ReportSource } from "./types.ts";

/** 单页/单份报告的 id（crypto.randomUUID 在 Workers 与 Node 都可用） */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type SaveInput = {
  sourceType: ReportSource;
  fileName: string | null;
  checkDate: string;
  hospital: string | null;
  rawText: string;
  metrics: ExtractedMetric[];
};

/**
 * 落库：一份报告 + 其全部指标（一次性写入，避免半份报告入库）。
 * 调用方必须先经过「人工确认闸」——本函数不判断来源，只负责写。
 */
export async function saveReport(repo: Repo, input: SaveInput): Promise<{ report: Report; metrics: Metric[] }> {
  const now = Date.now();
  const reportId = newId("rpt");
  const report: Report = {
    id: reportId,
    profileId: ACTIVE_PROFILE,
    sourceType: input.sourceType,
    fileName: input.fileName,
    checkDate: input.checkDate,
    hospital: input.hospital,
    rawText: input.rawText,
    metricCount: input.metrics.length,
    createdAt: now,
  };

  // 同一份报告里同一标准指标只保留一条（后填覆盖先填）：
  // 否则同一天会出现两个同名趋势点（折线自我折返），解读历史里也会重复引用（审查发现）
  const metrics: Metric[] = dedupeByName(input.metrics).map((m) => ({
    ...m,
    id: newId("mtr"),
    reportId,
    profileId: ACTIVE_PROFILE,
    createdAt: now,
  }));

  await repo.insertReport(report, metrics);
  return { report, metrics };
}

/**
 * 手工录入：把「补录一次检测」建模成一份 source_type='manual' 的报告。
 *
 * 为什么不直接往已有报告里加指标：报告 = 「一次检测」的快照，
 * 补录的指标只要检测日期与某份报告一致，就属于同一次检测 —— 因此按
 * (checkDate, 手工报告) 复用同一份手工报告，把指标并进去，趋势与异常判定才一致。
 */
export async function saveManualMetrics(
  repo: Repo,
  checkDate: string,
  metrics: ExtractedMetric[],
): Promise<{ report: Report; metrics: Metric[] }> {
  // 同一次补录里重复的指标只保留最后一条：
  // 不去重会让同一天出现两个同名点（趋势图同 x 轴两值，看起来像抖动），
  // 抽取路径本来就按 `rawName|valueText` 去重，手工路径必须同口径。
  const deduped = dedupeByName(metrics);
  // 直接查库，而不是在 listReports(200) 的结果里筛：报告数 >200（或补录较旧日期）时
  // 带截断的列表会找不到已有手工报告 → 新建第二份同日报告，归并语义失效（审查发现）
  const existing = await repo.findManualReport(ACTIVE_PROFILE, checkDate);

  if (existing) {
    // 增量追加而不是「删了重写」：删-插之间若失败，用户原有数据就丢了。
    // 追加失败最多是「这次没加进去」，原有数据仍在。
    const now = Date.now();
    const current = await repo.listMetricsByReport(existing.id);
    const added: Metric[] = deduped.map((m) => ({
      ...m,
      id: newId("mtr"),
      reportId: existing.id,
      profileId: ACTIVE_PROFILE,
      createdAt: now,
    }));
    await repo.appendMetrics(existing.id, added);
    const report = (await repo.getReport(existing.id)) ?? {
      ...existing,
      rawText: manualRawText(checkDate, current.length + added.length),
    };
    return { report, metrics: [...current, ...added] };
  }

  return saveReport(repo, {
    sourceType: "manual",
    fileName: null,
    checkDate,
    hospital: null,
    rawText: manualRawText(checkDate, deduped.length),
    metrics: deduped,
  });
}

/** 按标准指标名去重（同批次内保留最后一条：后填的覆盖先填的） */
export function dedupeByName<T extends { standardName: string }>(metrics: T[]): T[] {
  const byName = new Map<string, T>();
  for (const m of metrics) byName.set(m.standardName, m);
  return [...byName.values()];
}

/** 手工录入没有原文 —— 用结构化摘要代替，保持 rawText 非空（表约束 + 复核可读） */
export function manualRawText(checkDate: string, count: number): string {
  return `手工录入（检测日期 ${checkDate}）：共 ${count} 项指标，无报告原文。`;
}