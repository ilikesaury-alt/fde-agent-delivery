/**
 * eval/run.ts —— 阈值标定（纯本地，不触网）
 *
 * 输入：
 *   eval/labels.json   [{ contentKey, title, shouldPublish, note? }]
 *   eval/scores.json   线上 /api/top?threshold=0 的真实评分快照
 * 输出：控制台表格 + eval/report.md
 *
 * 用法：npm run eval
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));

type Label = { contentKey: string; title: string; shouldPublish: boolean; note?: string };
type ScoredItem = { contentKey: string; title: string; total: number; reason?: string };

type Snapshot = { items: ScoredItem[]; threshold?: number; storage?: string; model?: string };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(HERE, file), "utf8")) as T;
}

const labelsPath = join(HERE, "labels.json");
const scoresPath = join(HERE, "scores.json");

if (!existsSync(labelsPath) || !existsSync(scoresPath)) {
  console.error(
    "缺少评测数据：需要 eval/labels.json 与 eval/scores.json\n" +
      "  生成 scores.json：curl --proxy … \"/api/top?threshold=0&limit=60\" > eval/scores.json",
  );
  process.exit(1);
}

const labels = readJson<Array<Label>>("labels.json");
const snapshot = readJson<Snapshot>("scores.json");
const scored = new Map((snapshot.items ?? []).map((i) => [i.contentKey, i]));

/* ── 对齐检查：标签里有的，评分快照里必须也有（否则标定基数错误） ── */
const missing = labels.filter((l) => !scored.has(l.contentKey));
if (missing.length > 0) {
  console.error(`标签与评分快照未对齐：${missing.length} 条已标注但无评分`);
  for (const m of missing.slice(0, 5)) console.error(`  · ${m.title.slice(0, 60)}`);
  process.exit(1);
}

const positives = labels.filter((l) => l.shouldPublish).length;
if (positives === 0 || positives === labels.length) {
  console.error("标签全为正或全为负，无法计算 precision/recall");
  process.exit(1);
}

type Row = {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
};

const THRESHOLDS = [50, 55, 60, 65, 70, 75, 80];

function evaluate(threshold: number): Row {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const label of labels) {
    const item = scored.get(label.contentKey)!;
    const kept = item.total >= threshold;
    if (kept && label.shouldPublish) tp++;
    else if (kept && !label.shouldPublish) fp++;
    else if (!kept && label.shouldPublish) fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { threshold, tp, fp, fn, precision, recall, f1 };
}

const rows = THRESHOLDS.map(evaluate);

/** 推荐：F1 最高；并列取 Recall 更高（本产品倾向「宁可多一条，不可漏一条」） */
const best = [...rows].sort((a, b) => b.f1 - a.f1 || b.recall - a.recall || a.threshold - b.threshold)[0]!;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

console.log(`\n评测集：${labels.length} 条（正例 ${positives} / 负例 ${labels.length - positives}）`);
console.log(`评分来源：${snapshot.items?.length ?? 0} 条 · storage=${snapshot.storage ?? "?"}`);
console.log("");
console.log("阈值  TP  FP  FN   Precision  Recall   漏选率  F1");
for (const r of rows) {
  const mark = r.threshold === best.threshold ? " ←" : "";
  console.log(
    `${String(r.threshold).padStart(4)}  ${String(r.tp).padStart(2)}  ${String(r.fp).padStart(2)}  ${String(r.fn).padStart(2)}   ` +
      `${pct(r.precision).padStart(9)}  ${pct(r.recall).padStart(7)}  ${pct(1 - r.recall).padStart(6)}  ${r.f1.toFixed(3)}${mark}`,
  );
}

console.log(`\n推荐阈值：${best.threshold}（F1 ${best.f1.toFixed(3)}、Precision ${pct(best.precision)}、Recall ${pct(best.recall)}）`);

/* ── 报告落盘 ── */
const modelLine = snapshot.model ?? "（快照未带 model 字段）";
const report = `# 阈值标定报告（自动生成）

> 生成时间：${new Date().toISOString()}
> 评测集：${labels.length} 条（正例 ${positives} / 负例 ${labels.length - positives}）
> 评分来源：线上 \`/api/top?threshold=0\` 快照，共 ${snapshot.items?.length ?? 0} 条；model=${modelLine}
> 标签来源：**agent 初标，待用户复核**（见 eval/README.md §1）

## 阈值扫描

| 阈值 | TP | FP | FN | Precision | Recall | 漏选率 | F1 |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.threshold} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(1 - r.recall)} | ${r.f1.toFixed(3)} |`).join("\n")}

## 结论

**推荐阈值：${best.threshold}**（F1 ${best.f1.toFixed(3)}、Precision ${pct(best.precision)}、Recall ${pct(best.recall)}、漏选 ${pct(1 - best.recall)}）

取舍说明：本产品优先保 Recall（漏掉重要发布会削弱雷达价值），
因此并列时取 Recall 更高者；若后续标签质量提升后 Precision 偏低，可上调阈值。

> ⚠️ 标签为 agent 初标。用户复核 \`labels.json\` 后重跑 \`npm run eval\`，本报告会被覆盖更新。
`;

writeFileSync(join(HERE, "report.md"), report, "utf8");
console.log(`\n报告已写入 eval/report.md`);