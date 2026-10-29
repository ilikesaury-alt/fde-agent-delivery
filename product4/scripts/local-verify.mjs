#!/usr/bin/env node
/**
 * 本地整链验证（沙箱友好）：不需要 workerd / 不需要出网。
 *
 * 为什么需要它（cf-worker-local-env 的既有结论）：
 *   本沙箱 `vite dev` 起不来（workerd 不能 spawn），Node 也出不了网。
 *   于是「服务端逻辑是否正确」只能靠：真业务代码 + 内存 Repo + 假网关。
 *   这不是"假装验证"—— 跑的是同一个 lib/，假掉的只有 IO 边界。
 *
 * 覆盖链路：文本 → 抽取（假网关）→ 校验 → 入库（内存）→ 趋势 → 解读（含红线拒答）
 *
 * 用法：node scripts/local-verify.mjs
 */

import { createMemoryRepo } from "../lib/repo.ts";
import { extractReport } from "../lib/extract.ts";
import { buildTrend } from "../lib/trend.ts";
import { interpretMetric } from "../lib/interpret.ts";
import { saveManualMetrics, saveReport } from "../lib/service.ts";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.log(`  ✖ ${name}${detail ? `：${detail}` : ""}`);
  }
}

const ENV = { MAGPIE_BASE_URL: "https://fake/v1", MAGPIE_API_KEY: "fake", MAGPIE_MODEL: "fake" };

function fakeGateway(content) {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const REPORT_TEXT = `示例医院 体检报告
采样日期：2025-03-14

甘油三酯 2.31 mmol/L 0.45-1.7
空腹血糖 5.31 mmol/L 3.9-6.1
白细胞计数 6.2 10^9/L 3.5-9.5`;

const EXTRACT_JSON = JSON.stringify({
  check_date: "2025-03-14",
  hospital: "示例医院",
  metrics: [
    { raw_name: "甘油三酯", value_text: "2.31", unit: "mmol/L", ref_text: "0.45-1.7", source_quote: "甘油三酯 2.31 mmol/L 0.45-1.7" },
    { raw_name: "空腹血糖", value_text: "5.31", unit: "mmol/L", ref_text: "3.9-6.1", source_quote: "空腹血糖 5.31 mmol/L 3.9-6.1" },
    { raw_name: "白细胞计数", value_text: "6.2", unit: "10^9/L", ref_text: "3.5-9.5", source_quote: "白细胞计数 6.2 10^9/L 3.5-9.5" },
  ],
});

console.log("── 1. 抽取（假网关，真 lib/extract.ts）──");
const extracted = await extractReport(ENV, REPORT_TEXT, { fetchImpl: fakeGateway(EXTRACT_JSON), retry: 1 });
check("检测日期解析", extracted.checkDate === "2025-03-14", extracted.checkDate);
check("机构解析", extracted.hospital === "示例医院", String(extracted.hospital));
check("指标数 = 3", extracted.metrics.length === 3, String(extracted.metrics.length));
const tg = extracted.metrics.find((m) => m.rawName === "甘油三酯");
check("服务端算数值（2.31）", tg?.valueNum === 2.31, String(tg?.valueNum));
check("服务端判异常（>1.7 → high）", tg?.status === "high", String(tg?.status));
const wbc = extracted.metrics.find((m) => m.rawName === "白细胞计数");
check("标准名归一（白细胞计数）", wbc?.standardName === "白细胞计数", String(wbc?.standardName));
check("原文片段保留（可复核）", Boolean(tg?.sourceQuote?.includes("2.31")), String(tg?.sourceQuote));

console.log("\n── 2. 人工确认闸 → 入库（内存 Repo）──");
const repo = createMemoryRepo();
const saved = await saveReport(repo, {
  sourceType: "pdf",
  fileName: "示例.pdf",
  checkDate: extracted.checkDate,
  hospital: extracted.hospital,
  rawText: REPORT_TEXT,
  metrics: extracted.metrics,
});
check("报告入库且指标数一致", saved.report.metricCount === 3, String(saved.report.metricCount));
check("原文全文入库", saved.report.rawText === REPORT_TEXT);

console.log("\n── 3. 第二份报告（趋势）──");
const EXTRACT_JSON_2 = JSON.stringify({
  check_date: "2025-09-20",
  hospital: "示例医院",
  metrics: [
    { raw_name: "甘油三酯", value_text: "1.42", unit: "mmol/L", ref_text: "0.45-1.7", source_quote: "甘油三酯 1.42" },
    { raw_name: "空腹血糖", value_text: "5.6", unit: "mmol/L", ref_text: "3.9-6.1", source_quote: "空腹血糖 5.6" },
  ],
});
const extracted2 = await extractReport(ENV, "化验单 2025-09-20", { fetchImpl: fakeGateway(EXTRACT_JSON_2) });
await saveReport(repo, {
  sourceType: "pdf",
  fileName: null,
  checkDate: extracted2.checkDate,
  hospital: extracted2.hospital,
  rawText: "化验单 2025-09-20",
  metrics: extracted2.metrics,
});

const inputs = await repo.listTrendInputs("default");
const series = buildTrend(inputs);
const tgSeries = series.find((s) => s.standardName === "甘油三酯");
check("甘油三酯成序列", Boolean(tgSeries));
check("两个时间点", tgSeries?.points.length === 2, String(tgSeries?.points.length));
check(
  "点按日期升序",
  tgSeries?.points[0].checkDate === "2025-03-14" && tgSeries?.points[1].checkDate === "2025-09-20",
  JSON.stringify(tgSeries?.points.map((p) => p.checkDate)),
);
check("趋势值正确", tgSeries?.points[1].valueNum === 1.42, String(tgSeries?.points[1].valueNum));

console.log("\n── 4. 手工补录（同日合并）──");
await saveManualMetrics(repo, extracted.checkDate, [
  {
    standardName: "尿酸",
    rawName: "尿酸",
    valueNum: 420,
    valueText: "420",
    unit: "μmol/L",
    refLow: 208,
    refHigh: 428,
    refText: "208-428",
    status: "normal",
    sourceQuote: null,
  },
]);
const reports = await repo.listReports();
const manual = reports.filter((r) => r.sourceType === "manual");
check("手工报告入库", manual.length === 1, String(manual.length));

console.log("\n── 5. 解读（假网关 + 红线）──");
const history = await repo.listMetricHistory("default", "甘油三酯");
const interp = await interpretMetric(ENV, "甘油三酯", history, {
  fetchImpl: fakeGateway("甘油三酯是血脂的一种，用于评估脂代谢情况。"),
});
check("两次数据 → 趋势模式", interp.mode === "trend", interp.mode);
check("引用 = 2 条历史数据", interp.citations.length === 2, String(interp.citations.length));
check("带免责声明", interp.disclaimer.includes("不构成医疗诊断"), interp.disclaimer);

const refusedNoData = await interpretMetric(ENV, "不存在的指标", [], {});
check("无数据 → 拒答", refusedNoData.refused === true, String(refusedNoData.refused));

let modelCalled = false;
const spy = async () => {
  modelCalled = true;
  return new Response("{}");
};
const refusedGuard = await interpretMetric(ENV, "甘油三酯", history, { fetchImpl: spy, question: "我该吃什么药" });
check("红线提问 → 拒答", refusedGuard.refused === true, String(refusedGuard.refused));
check("红线提问不调模型", modelCalled === false);

console.log("\n── 6. 删除级联 ──");
const before = repo._size();
await repo.deleteReport(saved.report.id);
const after = repo._size();
check("删除报告连带删除其指标", after.metrics === before.metrics - 3, `${before.metrics} → ${after.metrics}`);

console.log(`\n${"=".repeat(56)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) process.exitCode = 1;