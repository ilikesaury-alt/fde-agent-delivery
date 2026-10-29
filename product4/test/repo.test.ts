/** 存储层（内存实现语义 = D1 实现语义的对照标准） */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { createMemoryRepo } from "../lib/repo.ts";
import { saveManualMetrics, saveReport } from "../lib/service.ts";
import type { ExtractedMetric } from "../lib/types.ts";

function mkMetric(over: Partial<ExtractedMetric> = {}): ExtractedMetric {
  return {
    standardName: over.standardName ?? "甘油三酯",
    rawName: over.rawName ?? "甘油三酯",
    valueNum: over.valueNum === undefined ? 1.2 : over.valueNum,
    valueText: over.valueText ?? "1.2",
    unit: over.unit === undefined ? "mmol/L" : over.unit,
    refLow: over.refLow === undefined ? 0.45 : over.refLow,
    refHigh: over.refHigh === undefined ? 1.7 : over.refHigh,
    refText: over.refText === undefined ? "0.45-1.7" : over.refText,
    status: over.status ?? "normal",
    sourceQuote: over.sourceQuote ?? null,
  };
}

describe("repo — 报告与指标", () => {
  it("入库后可读回（含原文与指标数）", async () => {
    const repo = createMemoryRepo();
    const saved = await saveReport(repo, {
      sourceType: "pdf",
      fileName: "2025.pdf",
      checkDate: "2025-03-14",
      hospital: "示例医院",
      rawText: "报告原文",
      metrics: [mkMetric(), mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖", valueNum: 5.4 })],
    });
    assertEqual(saved.report.metricCount, 2);

    const back = await repo.getReport(saved.report.id);
    assert(back);
    assertEqual(back.rawText, "报告原文");
    assertEqual(back.checkDate, "2025-03-14");
    assertEqual(back.metricCount, 2);
    assertEqual((await repo.listMetricsByReport(saved.report.id)).length, 2);
  });

  it("列表按检测日期倒序且不含原文全文", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "a", metrics: [mkMetric()] });
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-06-01", hospital: null, rawText: "b", metrics: [mkMetric()] });

    const list = await repo.listReports();
    assertEqual(list.map((r) => r.checkDate), ["2025-06-01", "2025-01-01"]);
    assert(!("rawText" in list[0]), "列表不应带原文全文");
  });

  it("删除报告连带删除其指标（不留悬挂指标）", async () => {
    const repo = createMemoryRepo();
    const a = await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "a",
      metrics: [mkMetric(), mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖" })],
    });
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-02-01", hospital: null, rawText: "b", metrics: [mkMetric()] });

    assertEqual(repo._size(), { reports: 2, metrics: 3 });
    assertEqual(await repo.deleteReport(a.report.id), true);
    assertEqual(repo._size(), { reports: 1, metrics: 1 });
    assertEqual((await repo.listMetricsByReport(a.report.id)).length, 0);
    assertEqual(await repo.deleteReport("nope"), false, "不存在的 id 返回 false");
  });

  it("趋势输入只含可绘制点，并按日期升序", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-03-01", hospital: null, rawText: "a", metrics: [mkMetric({ valueNum: 2 })] });
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "b", metrics: [mkMetric({ valueNum: 1 })] });
    await saveReport(repo, { sourceType: "pdf", fileName: null, checkDate: "2025-02-01", hospital: null, rawText: "c", metrics: [mkMetric({ valueNum: null, valueText: "阴性" })] });

    const inputs = await repo.listTrendInputs("default");
    assertEqual(inputs.map((i) => i.checkDate), ["2025-01-01", "2025-03-01"], "定性值不成点");
  });

  it("某标准指标的历史只返回它自己", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "a",
      metrics: [mkMetric(), mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖" })],
    });
    const h = await repo.listMetricHistory("default", "甘油三酯");
    assertEqual(h.length, 1);
    assertEqual(h[0].metric.standardName, "甘油三酯");
  });
});

describe("service — 手工补录合并语义", () => {
  it("同日补录合并进同一份手工报告（趋势同构）", async () => {
    const repo = createMemoryRepo();
    await saveManualMetrics(repo, "2025-05-01", [mkMetric()]);
    await saveManualMetrics(repo, "2025-05-01", [mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖", valueNum: 5.1 })]);

    const list = await repo.listReports();
    assertEqual(list.length, 1, "同一天只应有一份手工报告");
    assertEqual(list[0].sourceType, "manual");
    assertEqual(list[0].metricCount, 2, "两次补录的指标应合并");
  });

  it("合并后原有指标不丢（增量追加，而不是删了重写）", async () => {
    const repo = createMemoryRepo();
    const first = await saveManualMetrics(repo, "2025-05-01", [mkMetric()]);
    await saveManualMetrics(repo, "2025-05-01", [
      mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖", valueNum: 5.1 }),
    ]);
    // 原报告 id 保持不变（若走「删了重写」，id 会变 —— 前端选中的报告会突然 404）
    const stillSame = await repo.getReport(first.report.id);
    assert(stillSame, "原报告应仍存在（同 id）");
    assertEqual(stillSame.metricCount, 2);
    const rows = await repo.listMetricsByReport(first.report.id);
    assertEqual(rows.length, 2);
  });

  it("入库时同一标准指标只保留一条（同报告内「甘油三酯」与「TG」不能并存）", async () => {
    const repo = createMemoryRepo();
    await saveReport(repo, {
      sourceType: "pdf", fileName: null, checkDate: "2025-01-01", hospital: null, rawText: "a",
      metrics: [
        mkMetric({ rawName: "甘油三酯", standardName: "甘油三酯", valueNum: 2.1 }),
        mkMetric({ rawName: "TG", standardName: "甘油三酯", valueNum: 1.4 }),
      ],
    });
    const list = await repo.listReports();
    assertEqual(list[0].metricCount, 1, "同一标准指标只应入库一条（否则趋势同日两点）");
  });

  it("同一批补录里的重复指标只保留一条（否则同一天出现两个同名趋势点）", async () => {
    const repo = createMemoryRepo();
    await saveManualMetrics(repo, "2025-05-01", [
      mkMetric({ valueNum: 1.2, valueText: "1.2" }),
      mkMetric({ valueNum: 1.5, valueText: "1.5" }), // 同名指标，后填的应生效
    ]);
    const list = await repo.listReports();
    assertEqual(list[0].metricCount, 1, "同名指标应去重");
    const rows = await repo.listMetricsByReport(list[0].id);
    assertEqual(rows.length, 1);
    assertEqual(rows[0].valueNum, 1.5, "后者覆盖前者");
  });

  it("找同日手工报告不依赖列表截断（报告数 >200 也能找到）", async () => {
    const repo = createMemoryRepo();
    // 造 205 份其它日期的报告，把手工目标日期挤到列表截断之外
    for (let i = 0; i < 205; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const month = String((i % 12) + 1).padStart(2, "0");
      await saveReport(repo, {
        sourceType: "pdf", fileName: null, checkDate: `2020-${month}-${day}`, hospital: null, rawText: "x",
        metrics: [mkMetric({ standardName: `指标${i}`, rawName: `指标${i}` })],
      });
    }
    const target = "2025-05-01";
    await saveManualMetrics(repo, target, [mkMetric()]);
    // 再来一次同日补录：必须并进同一份，而不是新建第二份
    await saveManualMetrics(repo, target, [mkMetric({ standardName: "空腹血糖", rawName: "空腹血糖" })]);
    const manuals = (await repo.listReports(1000)).filter((r) => r.sourceType === "manual" && r.checkDate === target);
    assertEqual(manuals.length, 1, `同日手工报告应只有一份，实际 ${manuals.length}`);
  });

  it("趋势输入截断时保留最近的检测（不是最旧的）", async () => {
    const repo = createMemoryRepo();
    for (const d of ["2024-01-01", "2025-01-01", "2026-01-01"]) {
      await saveReport(repo, {
        sourceType: "pdf", fileName: null, checkDate: d, hospital: null, rawText: "x",
        metrics: [mkMetric({ standardName: "甘油三酯", rawName: "甘油三酯", valueNum: Number(d.slice(0, 4)) })],
      });
    }
    const inputs = await repo.listTrendInputs("default", 2);
    assertEqual(inputs.map((i) => i.checkDate), ["2025-01-01", "2026-01-01"], "截断应丢最旧的，且结果仍升序");
  });

  it("不同日期各自独立成报告", async () => {
    const repo = createMemoryRepo();
    await saveManualMetrics(repo, "2025-05-01", [mkMetric()]);
    await saveManualMetrics(repo, "2025-06-01", [mkMetric()]);
    assertEqual((await repo.listReports()).length, 2);
  });

  it("手工报告 rawText 非空（表约束 + 可读）", async () => {
    const repo = createMemoryRepo();
    const saved = await saveManualMetrics(repo, "2025-05-01", [mkMetric()]);
    assert(saved.report.rawText.includes("手工录入"));
    assert(saved.report.rawText.includes("2025-05-01"));
  });
});