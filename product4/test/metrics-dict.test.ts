/** 指标名归一字典（趋势不断裂的前提） */

import { assert, assertEqual, describe, it } from "./harness.ts";
import { cleanLoose, isKnownMetric, normalizeMetricName, STANDARD_METRICS } from "../lib/metrics-dict.ts";

describe("metrics-dict — 归一", () => {
  it("中英文别名都归到同一标准名（甘油三酯/TG/triglyceride）", () => {
    for (const raw of ["甘油三酯", "甘油三脂", "TG", "tg", "Triglyceride", "triglyceride"]) {
      assertEqual(normalizeMetricName(raw), "甘油三酯", `raw=${raw}`);
    }
  });

  it("带括号说明的名也能归一（白细胞(血常规)）", () => {
    assertEqual(normalizeMetricName("白细胞(血常规)"), "白细胞计数");
    assertEqual(normalizeMetricName("白细胞（全血）"), "白细胞计数");
  });

  it("尾部的箭头标记被剥掉（肌酐 ↑）", () => {
    assertEqual(normalizeMetricName("肌酐 ↑"), "肌酐");
    assertEqual(normalizeMetricName("肌酐↑"), "肌酐");
  });

  it("未命中字典 → 宽松清洗后原样保留（不丢指标）", () => {
    assertEqual(normalizeMetricName("某罕见指标"), "某罕见指标");
    assertEqual(normalizeMetricName("Some Rare Marker"), "some rare marker");
  });

  it("空名 → 空串（调用方据此丢弃该行）", () => {
    assertEqual(normalizeMetricName(""), "");
    assertEqual(normalizeMetricName("   "), "");
    assertEqual(normalizeMetricName("↑"), "");
  });

  it("cleanLoose 不做危险的合并（不同指标不会被并到一起）", () => {
    // 只做安全清洗：去括号/去标记/小写，不做语义相似度
    assertEqual(cleanLoose("ALT"), "alt");
    assertEqual(cleanLoose("AST"), "ast");
    assert(cleanLoose("ALT") !== cleanLoose("AST"), "ALT 与 AST 绝不能并成同一个");
  });

  it("isKnownMetric 区分命中/未命中", () => {
    assert(isKnownMetric("TSH"));
    assert(!isKnownMetric("某罕见指标"));
    assert(!isKnownMetric(""));
  });

  it("字典自身无重复别名（否则归一结果取决于 Map 写入顺序）", () => {
    const seen = new Map<string, string>();
    for (const def of STANDARD_METRICS) {
      const keys = [def.standard.toLowerCase(), ...def.aliases.map((a) => a.toLowerCase())];
      for (const k of keys) {
        const prev = seen.get(k);
        assert(prev === undefined || prev === def.standard, `别名冲突：${k} 同时属于 ${prev} 与 ${def.standard}`);
        seen.set(k, def.standard);
      }
    }
  });
});