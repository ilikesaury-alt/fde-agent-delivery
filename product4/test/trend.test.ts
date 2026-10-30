/** 趋势与异常判定（A4/A5 的核心逻辑，全部纯函数） */

import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  buildTrend,
  cleanValueText,
  determineStatus,
  parseRefRange,
  parseValueBound,
  parseValueNum,
} from "../lib/trend.ts";
import type { Metric, MetricStatus } from "../lib/types.ts";

function mkMetric(over: Partial<Metric> = {}): Metric {
  return {
    id: over.id ?? "m1",
    reportId: over.reportId ?? "r1",
    profileId: "default",
    standardName: over.standardName ?? "甘油三酯",
    rawName: over.rawName ?? "甘油三酯",
    // 注意：不能用 `??`（null ?? 1.2 → 1.2），否则「定性值」用例永远测不出 null
    valueNum: over.valueNum === undefined ? 1.2 : over.valueNum,
    valueText: over.valueText ?? "1.2",
    unit: over.unit ?? "mmol/L",
    refLow: over.refLow === undefined ? 0.45 : over.refLow,
    refHigh: over.refHigh === undefined ? 1.7 : over.refHigh,
    refText: over.refText === undefined ? "0.45-1.7" : over.refText,
    status: (over.status ?? "normal") as MetricStatus,
    sourceQuote: over.sourceQuote ?? null,
    createdAt: over.createdAt ?? 1,
  };
}

describe("trend — 参考范围解析", () => {
  it("区间写法：短横 / 波浪 / 中文「至」都识别", () => {
    assertEqual(parseRefRange("0.45-1.7"), { low: 0.45, high: 1.7 });
    assertEqual(parseRefRange("3.5~5.5"), { low: 3.5, high: 5.5 });
    assertEqual(parseRefRange("3.5 至 5.5"), { low: 3.5, high: 5.5 });
  });

  it("全角与异体符号归一（≤＜ 都当上限；≤ 为非严格、< 为严格）", () => {
    assertEqual(parseRefRange("≤100"), { low: null, high: 100, highStrict: false });
    assertEqual(parseRefRange("＜100"), { low: null, high: 100, highStrict: true }); // ＜ 是严格比较
    assertEqual(parseRefRange("≦100"), { low: null, high: 100, highStrict: false }); // ≦ 是「小于等于」
    assertEqual(parseRefRange("⩽100"), { low: null, high: 100, highStrict: false });
    assertEqual(parseRefRange(">=1.0"), { low: 1, high: null, lowStrict: false });
    assertEqual(parseRefRange("＞1.0"), { low: 1, high: null, lowStrict: true }); // ＞ 是严格比较
    assertEqual(parseRefRange("≧1.0"), { low: 1, high: null, lowStrict: false });
    assertEqual(parseRefRange("⩾1.0"), { low: 1, high: null, lowStrict: false });
  });

  it("严格界限（<x / >x）被记录：值恰等于界限时不在范围内", () => {
    assertEqual(parseRefRange("<6.1"), { low: null, high: 6.1, highStrict: true });
    // 报告写「<6.1」而值正好 6.1，原报告已标 ↑ → 必须判偏高，不能漏判（审查阻塞项）
    assertEqual(determineStatus(6.1, parseRefRange("<6.1")), "high");
    assertEqual(determineStatus(6.1, parseRefRange("≤6.1")), "normal");
    assertEqual(determineStatus(1.0, parseRefRange(">1.0")), "low");
    assertEqual(determineStatus(1.0, parseRefRange("≥1.0")), "normal");
  });

  it("界值（<x / >x）能确定的结论要判（不确定的仍 unknown）", () => {
    // 真实报告：乙肝五项 `>5.00` 参考 0-0.15，原报告已标 ↑
    assertEqual(determineStatus(null, parseRefRange("0-0.15"), parseValueBound(">5.00")), "high");
    assertEqual(determineStatus(null, parseRefRange("0-0.35"), parseValueBound(">25.00")), "high");
    // `<2` 参考 0-10：2 落在区间内 → 值可能在区间内也可能偏低 → 不猜
    assertEqual(determineStatus(null, parseRefRange("0-10"), parseValueBound("<2.000")), "unknown");
    assertEqual(determineStatus(null, parseRefRange("0-0.1"), parseValueBound("<0.05")), "unknown");
    // `<0.01` 参考 3-5：必然低于下限 → low
    assertEqual(determineStatus(null, parseRefRange("3-5"), parseValueBound("<0.01")), "low");
    // 无参考范围 / 纯定性值 → unknown
    assertEqual(determineStatus(null, null, parseValueBound(">5")), "unknown");
    assertEqual(determineStatus(null, parseRefRange("0-10"), null), "unknown");
    // 界值解析只认 <、>（含 <= >=）；定性词仍 null
    assertEqual(parseValueBound("<0.01"), { op: "<", n: 0.01 });
    assertEqual(parseValueBound("阴性"), null);
  });

  it("分区范围（男/女/孕）→ null：没有性别字段就不能替人猜（审查阻塞项）", () => {
    assertEqual(parseRefRange("130-175（男）115-150（女）"), null);
    assertEqual(parseRefRange("3.5-5.5（成人）"), null);
    assertEqual(parseRefRange("1.0-2.5（孕期）"), null);
  });

  it("带数量级的范围（0-10^9/L）→ null：取 {0,10} 会差 9 个数量级（审查阻塞项）", () => {
    assertEqual(parseRefRange("0-10^9/L"), null);
    assertEqual(parseRefRange("100-300×10^9/L"), null);
    assertEqual(parseRefRange("2-10e3"), null);
  });

  it("中文上下限写法", () => {
    assertEqual(parseRefRange("100以下"), { low: null, high: 100 });
    assertEqual(parseRefRange("1.0以上"), { low: 1, high: null });
  });

  it("带单位尾巴仍能解析（单位忽略）", () => {
    assertEqual(parseRefRange("0.45-1.7 mmol/L"), { low: 0.45, high: 1.7 });
  });

  it("写反的区间 → null（不静默交换：交换等于替报告猜范围，反序更可能是抄写错误）", () => {
    assertEqual(parseRefRange("5.5-3.5"), null);
    assertEqual(parseRefRange("1.7-0.45"), null);
  });

  it("定性/文字描述 → null（宁可判 unknown，不猜）", () => {
    assertEqual(parseRefRange("阴性"), null);
    assertEqual(parseRefRange("未见异常"), null);
    assertEqual(parseRefRange(""), null);
    assertEqual(parseRefRange(null), null);
    assertEqual(parseRefRange("5-5"), null, "等值区间无意义");
  });
});

describe("trend — 异常判定（宁缺毋滥）", () => {
  it("区间内 normal / 超上限 high / 低于下限 low", () => {
    assertEqual(determineStatus(1.2, { low: 0.45, high: 1.7 }), "normal");
    assertEqual(determineStatus(2.0, { low: 0.45, high: 1.7 }), "high");
    assertEqual(determineStatus(0.3, { low: 0.45, high: 1.7 }), "low");
  });

  it("边界值算正常（不把「等于上限」判成偏高）", () => {
    assertEqual(determineStatus(1.7, { low: 0.45, high: 1.7 }), "normal");
    assertEqual(determineStatus(0.45, { low: 0.45, high: 1.7 }), "normal");
  });

  it("只有上限/只有下限也能判", () => {
    assertEqual(determineStatus(50, { low: null, high: 100 }), "normal");
    assertEqual(determineStatus(150, { low: null, high: 100 }), "high");
    assertEqual(determineStatus(0.5, { low: 1, high: null }), "low");
  });

  it("无数值 / 无范围 / 范围非法 → unknown（绝不假装正常）", () => {
    assertEqual(determineStatus(null, { low: 1, high: 2 }), "unknown");
    assertEqual(determineStatus(5, null), "unknown");
    assertEqual(determineStatus(5, { low: null, high: null }), "unknown");
    assertEqual(determineStatus(5, { low: 9, high: 1 }), "unknown", "low>high 视为解析异常");
  });
});

describe("trend — 原文值转数值", () => {
  it("纯数值可转（含负号与小数）", () => {
    assertEqual(parseValueNum("5.31"), 5.31);
    assertEqual(parseValueNum("-2"), -2);
    assertEqual(parseValueNum("1,200"), 1200);
  });

  it("带方向标记（2.31 ↑）剥掉后仍能取数值 —— 否则偏高会被算成无法判断", () => {
    assertEqual(cleanValueText("2.31 ↑"), "2.31");
    assertEqual(cleanValueText("0.21↓"), "0.21");
    assertEqual(cleanValueText("4.2 *"), "4.2");
    assertEqual(parseValueNum("2.31 ↑"), 2.31);
    assertEqual(determineStatus(parseValueNum("2.31 ↑"), { low: 0.45, high: 1.7 }), "high");
  });

  it("非纯数值 → null（不插值、不猜）", () => {
    assertEqual(parseValueNum("<0.01"), null);
    assertEqual(parseValueNum("阴性"), null);
    assertEqual(parseValueNum("±"), null);
    assertEqual(parseValueNum(""), null);
  });
});

describe("trend — 序列聚合", () => {
  it("按标准名聚合，点按检测日期升序", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", reportId: "r2", valueNum: 2.1, status: "high" }), checkDate: "2025-06-01" },
      { metric: mkMetric({ id: "b", reportId: "r1", valueNum: 1.2, status: "normal" }), checkDate: "2025-01-01" },
    ]);
    assertEqual(series.length, 1);
    assertEqual(series[0].points.map((p) => p.checkDate), ["2025-01-01", "2025-06-01"]);
    assertEqual(series[0].points.map((p) => p.valueNum), [1.2, 2.1]);
  });

  it("定性值不成点（阴性不画成 0）", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", valueNum: null, valueText: "阴性", status: "unknown" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b", valueNum: 1.4, valueText: "1.4" }), checkDate: "2025-02-01" },
    ]);
    assertEqual(series.length, 1);
    assertEqual(series[0].points.length, 1);
  });

  it("不同标准名分开成多条序列", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", standardName: "甘油三酯" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b", standardName: "空腹血糖" }), checkDate: "2025-01-01" },
    ]);
    assertEqual(series.map((s) => s.standardName).sort(), ["甘油三酯", "空腹血糖"]);
  });

  it("参考范围跨次变化 → refChanged 标记（D4）", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", refLow: 0.45, refHigh: 1.7 }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b", refLow: 0.4, refHigh: 1.8 }), checkDate: "2025-02-01" },
    ]);
    assert(series[0].refChanged, "范围变过必须可见");
  });

  it("范围一致 → refChanged=false", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b" }), checkDate: "2025-02-01" },
    ]);
    assertEqual(series[0].refChanged, false);
  });

  it("单位跨次不同 → unitChanged（数值不可直接比较，必须告警而不是静默画一条线）", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", unit: "mmol/L" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b", unit: "mg/dL" }), checkDate: "2025-02-01" },
    ]);
    assert(series[0].unitChanged, "单位变过必须标记");
  });

  it("单位一致 → unitChanged=false", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b" }), checkDate: "2025-02-01" },
    ]);
    assertEqual(series[0].unitChanged, false);
  });

  it("原文名变体都保留（甘油三酯 / TG 同属一条线）", () => {
    const series = buildTrend([
      { metric: mkMetric({ id: "a", rawName: "甘油三酯" }), checkDate: "2025-01-01" },
      { metric: mkMetric({ id: "b", rawName: "TG" }), checkDate: "2025-02-01" },
    ]);
    assertEqual(series[0].rawNames, ["甘油三酯", "TG"]);
  });
});