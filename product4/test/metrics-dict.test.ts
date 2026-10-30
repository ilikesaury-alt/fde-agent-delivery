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

  it("上下文否决：餐后/尿/甲状腺 等不同测项不得被并入（审查阻塞项）", () => {
    // 餐后血糖 ≠ 空腹血糖（同单位，错并后无任何告警 → 假趋势 + 错误异常结论）
    assertEqual(normalizeMetricName("葡萄糖(餐后2h)"), "葡萄糖");
    assertEqual(normalizeMetricName("空腹血糖"), "空腹血糖");
    // 尿糖 ≠ 空腹血糖
    assertEqual(normalizeMetricName("尿糖"), "尿糖");
    assertEqual(normalizeMetricName("GLU"), "glu");
    // 甲状腺球蛋白 TG ≠ 甘油三酯
    assertEqual(normalizeMetricName("甲状腺球蛋白 TG"), "甲状腺球蛋白 tg");
    assertEqual(normalizeMetricName("TG"), "甘油三酯");
    // 尿白细胞 ≠ 血常规白细胞计数
    assertEqual(normalizeMetricName("尿白细胞"), "尿白细胞");
    assertEqual(normalizeMetricName("白细胞"), "白细胞计数");
    // 尿微量白蛋白 ≠ 血清白蛋白
    assertEqual(normalizeMetricName("尿微量白蛋白"), "尿微量白蛋白");
    assertEqual(normalizeMetricName("ALB"), "白蛋白");
  });

  it("「尿素」不并入「尿素氮」（标度差 2.14 倍且单位相同，错并无法告警）", () => {
    assertEqual(normalizeMetricName("尿素"), "尿素");
    assertEqual(normalizeMetricName("尿素氮 BUN"), "尿素氮");
  });

  it("中文名 + 缩写互相印证时才合并（两半必须指向同一标准名）", () => {
    assertEqual(normalizeMetricName("谷丙转氨酶 ALT"), "丙氨酸氨基转移酶");
    assertEqual(normalizeMetricName("促甲状腺激素 TSH"), "促甲状腺激素");
    // 两半指向不同标准名 → 不合并（保持原文名）
    assertEqual(normalizeMetricName("甲状腺球蛋白 TG"), "甲状腺球蛋白 tg");
  });

  it("乙肝五项归一（真实报告实测的定量组套）", () => {
    assertEqual(normalizeMetricName("HBsAg"), "乙肝表面抗原");
    assertEqual(normalizeMetricName("HBsAg(H)"), "乙肝表面抗原"); // 高值稀释复测，同一分析物
    // 清洗会剥掉 `*` 与括号内的方法学标记（(CLIA)），与定量的别名同归一处
    assertEqual(normalizeMetricName("*乙肝表面抗原定量(CLIA)"), "乙肝表面抗原");
    assertEqual(normalizeMetricName("HBsAb"), "乙肝表面抗体");
    assertEqual(normalizeMetricName("HBeAg"), "乙肝e抗原");
    assertEqual(normalizeMetricName("HBeAb"), "乙肝e抗体");
    assertEqual(normalizeMetricName("HBcAb"), "乙肝核心抗体");
  });

  it("血常规：绝对值 # 与百分比 % 不混，OCR 混淆名能归位", () => {
    assertEqual(normalizeMetricName("NEU#"), "中性粒细胞绝对值");
    assertEqual(normalizeMetricName("NEU%"), "中性粒细胞百分比");
    assert(normalizeMetricName("NEU#") !== normalizeMetricName("NEU%"), "绝对值与百分比必须是两条线");
    assertEqual(normalizeMetricName("MON0%"), "单核细胞百分比", "0↔O 混淆要能归位");
    assertEqual(normalizeMetricName("BAS0%"), "嗜碱性粒细胞百分比");
    assertEqual(normalizeMetricName("P-LcR"), "大血小板比率");
    assertEqual(normalizeMetricName("EoS%"), "嗜酸性粒细胞百分比");
    assertEqual(normalizeMetricName("RDW-SD"), "红细胞分布宽度标准差");
    // 撞车项不合并：PCT 既可能是血小板压积也可能是降钙素原
    assertEqual(normalizeMetricName("PCT"), "pct");
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