/**
 * 抽取评测（A1）：用**真实网关**跑标注用例，产出「行级准确率 / 字段级准确率」。
 *
 * 行级口径（主口径，写进 CONTEXT §5 A1）：
 *   一条指标 = (standardName, valueText, refText) 三元组全对才算「行对」。
 *   为什么不用「数值近似相等」：报告原文值本身是字符串，抄错一位就是错，
 *   不该用容差掩盖（0.45 与 0.54 差一位，临床上完全不是一件事）。
 *
 * 字段级口径（辅口径，用于定位弱点）：rawName / valueText / refText 各自命中率。
 *
 * 红线用例（A6）：确定性守卫，不调模型 —— 期望「必须拒答」的提问一律不通过模型。
 *
 * 用法：node --experimental-strip-types eval/run.ts
 * 环境：从 .secrets.json 或 process.env 读取 MAGPIE_BASE_URL / MAGPIE_API_KEY / MAGPIE_MODEL
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractReport } from "../lib/extract.ts";
import { interpretGuard } from "../lib/interpret-guard.ts";
import { normalizeMetricName } from "../lib/metrics-dict.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

type ExpectedMetric = { rawName: string; valueText: string; refText: string | null };
type ExtractCase = { id: string; note?: string; text: string; expect: { checkDate: string; metrics: ExpectedMetric[] } };
type RedlineCase = { id: string; question: string; mustRefuse: boolean };

function loadEnv(): { MAGPIE_BASE_URL?: string; MAGPIE_API_KEY?: string; MAGPIE_MODEL?: string } {
  const out: Record<string, string> = {};
  for (const key of ["MAGPIE_BASE_URL", "MAGPIE_API_KEY", "MAGPIE_MODEL"]) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  if (!out.MAGPIE_BASE_URL || !out.MAGPIE_API_KEY) {
    try {
      const raw = readFileSync(join(HERE, "..", ".secrets.json"), "utf8");
      const sec = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["MAGPIE_BASE_URL", "MAGPIE_API_KEY", "MAGPIE_MODEL"]) {
        const v = sec[key];
        if (typeof v === "string" && v) out[key] = v; // 环境变量优先，文件兜底
      }
    } catch {
      // 无文件则只用环境变量
    }
  }
  return out;
}

function keyOf(m: { standardName?: string; rawName: string; valueText: string; refText: string | null }): string {
  const name = m.standardName ?? normalizeMetricName(m.rawName);
  return `${name}|${m.valueText.trim()}|${(m.refText ?? "").trim()}`;
}

const extractCases = JSON.parse(readFileSync(join(HERE, "cases", "extract.cases.json"), "utf8")) as ExtractCase[];
const redlineCases = JSON.parse(readFileSync(join(HERE, "cases", "redline.cases.json"), "utf8")) as RedlineCase[];

const env = loadEnv();
if (!env.MAGPIE_BASE_URL || !env.MAGPIE_API_KEY) {
  console.error("✖ 缺少 MAGPIE_BASE_URL / MAGPIE_API_KEY（环境变量或 .secrets.json），无法跑真实评测。");
  process.exit(1);
}

console.log(`抽取评测：${extractCases.length} 例 · 红线评测：${redlineCases.length} 例`);
console.log(`网关：${env.MAGPIE_BASE_URL} · 模型：${env.MAGPIE_MODEL ?? "(默认)"}\n`);

let rowHit = 0;
let rowTotal = 0;
const fieldStats = { rawName: 0, valueText: 0, refText: 0, fields: 0 };
const failures: string[] = [];

for (const c of extractCases) {
  process.stdout.write(`· ${c.id} `);
  try {
    const r = await extractReport(env, c.text, { retry: 1 });
    const got = new Set(r.metrics.map(keyOf));
    const expected = c.expect.metrics.map((m) => keyOf({ rawName: m.rawName, valueText: m.valueText, refText: m.refText }));
    let hits = 0;
    for (const k of expected) {
      rowTotal++;
      if (got.has(k)) {
        hits++;
        rowHit++;
      } else {
        failures.push(`${c.id} 漏/错行：期望 ${k}`);
      }
    }
    rowTotal += Math.max(0, got.size - expected.length);
    // 字段级
    for (const m of c.expect.metrics) {
      const byName = r.metrics.filter((x) => x.standardName === normalizeMetricName(m.rawName));
      fieldStats.fields += 1;
      const match = byName.find((x) => x.valueText.trim() === m.valueText.trim()) ?? byName[0];
      if (match) {
        if (match.rawName.trim() === m.rawName.trim()) fieldStats.rawName++;
        if (match.valueText.trim() === m.valueText.trim()) fieldStats.valueText++;
        if ((match.refText ?? "").trim() === (m.refText ?? "").trim()) fieldStats.refText++;
      }
    }
    console.log(`✓ 行 ${hits}/${expected.length}（输出 ${r.metrics.length} 项）`);
  } catch (e) {
    rowTotal += c.expect.metrics.length;
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    failures.push(`${c.id} 整体失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log("\n── 红线（确定性守卫，不调模型）──");
let redOk = 0;
for (const c of redlineCases) {
  const refused = !interpretGuard(c.question).allowed;
  const pass = refused === c.mustRefuse;
  if (pass) redOk++;
  console.log(`  ${pass ? "✓" : "✗"} ${c.id}：${c.question} → ${refused ? "拒答" : "放行"}`);
  if (!pass) failures.push(`红线不符 ${c.id}：${c.question}`);
}

const rowAcc = rowTotal ? rowHit / rowTotal : 0;
const field = (n: number) => (fieldStats.fields ? n / fieldStats.fields : 0);
console.log(`\n${"=".repeat(56)}`);
console.log(`行级准确率：${(rowAcc * 100).toFixed(1)}%（${rowHit}/${rowTotal}）`);
console.log(
  `字段级：rawName ${(field(fieldStats.rawName) * 100).toFixed(1)}% · valueText ${(field(fieldStats.valueText) * 100).toFixed(1)}% · refText ${(field(fieldStats.refText) * 100).toFixed(1)}%`,
);
console.log(`红线：${(redOk / redlineCases.length * 100).toFixed(1)}%（${redOk}/${redlineCases.length}）`);

// 阈值：行级 ≥ 90%（低于此说明抽取链路不可交付）；红线必须 100%（红线不能有概率）
const REDLINE_MIN = 1;
const ROW_MIN = 0.9;
if (rowAcc < ROW_MIN) {
  console.error(`\n✖ 行级准确率低于阈值 ${ROW_MIN * 100}%`);
  process.exitCode = 1;
}
if (redOk / redlineCases.length < REDLINE_MIN) {
  console.error(`\n✖ 红线未达 100% —— 医疗红线不允许概率性漏放`);
  process.exitCode = 1;
}
if (failures.length) console.log(`\n失败详情:\n${failures.map((f) => `- ${f}`).join("\n")}`);