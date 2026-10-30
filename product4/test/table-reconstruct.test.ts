/**
 * 表格重建（纯函数）—— 用**真实报告的几何**做回归。
 *
 * 夹具来源：2026-10-29 一份真实扫描件经 PP-OCRv5 识别出的 41 个文本框，
 * 坐标与置信度是实测值，**文字已脱敏替换**成另一组检验项（不把本人检验数据入库）。
 */

import { readFileSync } from "node:fs";

import { assert, assertEqual, describe, it } from "./harness.ts";
import {
  clusterRows,
  detectColumns,
  findReportDate,
  isMetricRow,
  normalizeUnitText,
  reconstructTable,
  rowsToText,
  type TableLine,
} from "../lib/table-reconstruct.ts";

type Fixture = { width: number; height: number; lines: TableLine[] };

const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/paddle-lines.json", import.meta.url), "utf8"),
) as Fixture;

function fixtureLines(): TableLine[] {
  return FIXTURE.lines.map((l) => ({ ...l }));
}

describe("table-reconstruct — 真实报告几何", () => {
  it("6 行检验项按坐标重建，列语义正确", () => {
    const r = reconstructTable(fixtureLines(), { imageWidth: FIXTURE.width });
    assertEqual(r.reliable, true, "应识别到表头");

    const keys = r.columns.map((c) => c.key);
    assert(keys.includes("name") && keys.includes("value") && keys.includes("ref"), `列识别: ${keys.join(",")}`);

    const rows = r.rows.filter((row) => (row.cells.value ?? "").trim() !== "");
    assertEqual(rows.length, 6, "应有 6 个有结果值的行");

    const expected = [
      ["甘油三酯", "2.31", "mmol/L", "0.45-1.7"],
      ["TG", "2.310", "mmol/L", "0.45-1.7"],
      ["空腹血糖", "<5.6", "mmol/L", "3.9-6.1"],
      ["糖化血红蛋白", "<0.05", "%", "4.0-6.0"],
      ["尿素氮", ">5.00", "mmol/L", "2.9-8.2"],
      ["肌酐", ">25.00", "mmol/L", "57-97"],
    ];
    for (let i = 0; i < expected.length; i++) {
      const [name, value, unit, ref] = expected[i];
      assertEqual(rows[i].cells.name, name, `第 ${i + 1} 行名称`);
      assertEqual(rows[i].cells.value, value, `第 ${i + 1} 行结果`);
      assertEqual(rows[i].cells.unit, unit, `第 ${i + 1} 行单位`);
      assertEqual(rows[i].cells.ref, ref, `第 ${i + 1} 行参考范围`);
    }
  });

  it("序号列的竖长框被剔除 —— 否则它会把相邻两行并成一行（实测踩过）", () => {
    const lines = fixtureLines();
    const tall = lines.find((l) => l.text === "123456");
    assert(tall != null, "夹具里应保留那个竖长框");
    assert(tall.y1 - tall.y0 > 150, `竖长框高度应远大于行高（实际 ${tall.y1 - tall.y0}）`);

    const { rows, droppedLines } = clusterRows(lines);
    assertEqual(droppedLines, 1, "应剔除 1 个高度离群框");
    // 若没剔除，462 那个框会把「空腹血糖 / 糖化血红蛋白」两行并成一行
    const merged = rows.some((r) => r.cells.length > 7);
    assert(!merged, "不应出现把两行并成一行的情况");
  });

  it("行内单元格按 x 排序（列序不依赖识别顺序）", () => {
    const { rows } = clusterRows(fixtureLines());
    for (const row of rows) {
      for (let i = 1; i < row.cells.length; i++) {
        assert(row.cells[i - 1].x0 <= row.cells[i].x0, "cells 必须按 x0 升序");
      }
    }
  });

  it("去掉表头 → reliable=false 但原始顺序仍保留（不猜列语义）", () => {
    const noHeader = fixtureLines().filter((l) => !/^(序号|项目名称|中文名称|结果|单位|参考区间)$/.test(l.text));
    const r = reconstructTable(noHeader, { imageWidth: FIXTURE.width });
    assertEqual(r.reliable, false, "没有表头就不能声称列语义可信");
    assertEqual(r.columns.length, 0);
    const first = r.rows.find((row) => (row.raw[0] ?? "").includes("甘油三酯"));
    assert(first != null, "无表头时仍应返回按 y 聚好的原始行");
    assert(first!.raw.length >= 4, `原始行应保留全部单元格：${first!.raw.join("|")}`);
  });

  it("表头写法变体也能认（参考范围 / 项目 / 中文名 / 测定值）", () => {
    const make = (labels: string[]) => {
      const cols = [
        { x0: 90, x1: 150 },
        { x0: 200, x1: 320 },
        { x0: 420, x1: 540 },
        { x0: 890, x1: 960 },
        { x0: 1140, x1: 1210 },
        { x0: 1310, x1: 1420 },
      ];
      return labels.map((text, i) => ({
        text,
        score: 0.99,
        x0: cols[i].x0,
        x1: cols[i].x1,
        y0: 280,
        y1: 312,
      })) as TableLine[];
    };

    for (const labels of [
      ["序号", "项目", "中文名", "测定值", "单位", "参考范围"],
      ["No.", "检验项目", "中文名称", "结果值", "单位", "正常参考值"],
    ]) {
      const { rows } = clusterRows(make(labels));
      const cols = detectColumns(rows[0]);
      assert(cols != null, `应识别表头：${labels.join(",")}`);
      const keys = cols!.map((c) => c.key);
      for (const k of ["name", "value", "unit", "ref"]) assert(keys.includes(k), `缺列 ${k}（${labels.join(",")}）`);
    }
  });

  it("长单元格按列边界归位，不跳到隔壁列", () => {
    const r = reconstructTable(fixtureLines(), { imageWidth: FIXTURE.width });
    const row = r.rows.find((x) => (x.cells.name ?? "").trim() === "空腹血糖");
    assert(row != null, "应找到空腹血糖行");
    assertEqual(row!.cells.value, "<5.6");
    assertEqual(row!.cells.ref, "3.9-6.1");
    // 中文名称很长，但不能被归到 value/unit
    assertEqual(row!.cells.cname, "空腹血糖测定(己糖激酶法)");
  });

  it("页脚/时间/页码行不算指标行（真实报告表格下面有一大坨）", () => {
    assertEqual(isMetricRow({ name: "申请时间：2026-04-08 08:18", value: "采集时间：2026-04-08 08:44" }), false);
    assertEqual(isMetricRow({ name: "报告时间：2026-04-08 10:57", value: "检验者：魏徵霄" }), false);
    assertEqual(isMetricRow({ name: "第1页，共1页", value: "1" }), false);
    assertEqual(isMetricRow({ name: "以下为空", value: "" }), false);
    assertEqual(isMetricRow({ name: "HBsAg", value: "78.44" }), true);
    assertEqual(isMetricRow({ name: "尿潜血", value: "阴性" }), true);
    // 值里带「键：值」也判页脚（实测：检验者/打印者/审核者那一行会漏进来）
    assertEqual(isMetricRow({ name: "李美娴", value: "打印者： 李美娴" }), false);
  });

  it("报告日期：从页脚行确定性提取，优先级 采集>报告>申请", () => {
    const mk = (text: string): TableLine => ({ text, score: 0.99, x0: 0, y0: 0, x1: 10, y1: 10 });
    const lines = [
      mk("申请时间：2026-04-08 08:18"),
      mk("采集时间：2026-04-08 08:44"),
      mk("报告时间：2026-04-08 10:57"),
    ];
    assertEqual(findReportDate(lines), "2026-04-08");
    // 只有报告时间也能用
    assertEqual(findReportDate([mk("报告时间：2025-11-02 10:57")]), "2025-11-02");
    // 中文年月日
    assertEqual(findReportDate([mk("采集时间：2025年3月7日")]), "2025-03-07");
    // 没有日期 → null（不猜）
    assertEqual(findReportDate([mk("HBsAg 78.44")]), null);
    // 非法月/日 → 不采纳
    assertEqual(findReportDate([mk("采集时间：2025-13-45")]), null);
  });

  it("单位 OCR 混淆修正：IU/m1 → IU/ml、lU/ml → IU/ml", () => {
    assertEqual(normalizeUnitText("IU/m1"), "IU/ml");
    assertEqual(normalizeUnitText("IU/mI"), "IU/ml");
    assertEqual(normalizeUnitText("lU/ml"), "IU/ml");
    assertEqual(normalizeUnitText("mmol/L"), "mmol/L", "合法单位不得被改");
    // 血常规单位：上标在扫描件里几乎必丢
    assertEqual(normalizeUnitText("109/L"), "10^9/L");
    assertEqual(normalizeUnitText("1012/L"), "10^12/L");
    // `$10{/L$` 里连指数数字都没有 → 还原不出 → 单位未知（不写假单位）
    assertEqual(normalizeUnitText("$10{/L$"), "");
    assertEqual(normalizeUnitText("10^9/L"), "10^9/L", "本来就对的不要改");
    // 指数整段丢了 → 单位未知（空），不写假单位（否则跨报告比较会误报「单位变了」）
    assertEqual(normalizeUnitText("10^/L"), "");
    assertEqual(normalizeUnitText("10/L"), "");
  });

  it("rowsToText：输出表头 + 只保留「有名称且有结果」的行", () => {
    const r = reconstructTable(fixtureLines(), { imageWidth: FIXTURE.width });
    const text = rowsToText(r);
    const lines = text.split("\n");
    assertEqual(lines[0], "项目名称 | 中文名称 | 结果 | 单位 | 参考范围", "首行应是列序说明");
    const body = lines.slice(1);
    assertEqual(body.length, 6, `正文应为 6 条（实际 ${body.length}）:\n${text}`);
    assertEqual(body[0], "甘油三酯 | 甘油三酯测定(酶法) | 2.31 | mmol/L | 0.45-1.7");
    // 以下为空 / 备注 / 页脚没有结果值 → 不进入文本
    assert(!text.includes("以下为空") && !text.includes("备注"), "页脚行不应进入抽取文本");
  });

  it("空输入 / 全空文本 → 空结果（不抛）", () => {
    const r = reconstructTable([], { imageWidth: 1000 });
    assertEqual(r.rows.length, 0);
    assertEqual(r.reliable, false);
    assertEqual(rowsToText(r), "项目名称 | 结果");
    const blank = reconstructTable([{ text: "  ", score: 0.1, x0: 0, y0: 0, x1: 1, y1: 1 }], {});
    assertEqual(blank.rows.length, 0);
  });

  it("低置信度框保留但记录 minScore（供上层提示人工核对）", () => {
    const r = reconstructTable(fixtureLines(), { imageWidth: FIXTURE.width });
    const row = r.rows.find((x) => (x.cells.name ?? "").trim() === "甘油三酯");
    assert(row != null);
    assert(row!.minScore > 0 && row!.minScore <= 1, `minScore 应在 (0,1]：${row!.minScore}`);
  });
});