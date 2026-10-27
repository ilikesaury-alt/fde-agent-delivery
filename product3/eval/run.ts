/**
 * 评测脚本 —— 让「质量」成为一条能跑的命令，而不是口头承诺。
 *
 * 指标（CONTEXT D5）：
 *   Recall@k        期望文档是否出现在引用里（有引用的用例）
 *   拒答正确率      库内无依据的用例是否真的拒答
 *   引用准确率      被引用的片段是否真的包含期望依据词
 *   误拒率          有依据的用例被拒答的比例
 *
 * 用法：
 *   node --experimental-strip-types eval/run.ts                       # 打本地 shim（假嵌入，验结构）
 *   BASE_URL=https://kb-ask.xxx.workers.dev ACCESS_TOKEN=... node --experimental-strip-types eval/run.ts
 *                                                            # 打线上（真 bge-m3，用于标定阈值）
 *
 * ⚠️ 两个环境的结果含义不同：
 *   本地 shim 用词袋假嵌入，只能证明「链路与指标计算正确」；
 *   阈值标定必须用线上真模型的数据（CONTEXT D16：评测驱动写死阈值）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8902";
const TOKEN = process.env.ACCESS_TOKEN ?? "";
const CORPUS_DIR = join(HERE, "corpus");

type EvalCase = {
  id: string;
  question: string;
  expectDoc: string | null;
  expectKeyword: string | null;
  shouldRefuse: boolean;
};

type Citation = { index: number; docTitle: string; headingPath: string; snippet: string; score: number };

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
  return h;
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: { raw: text.slice(0, 500) } };
  }
}

async function readSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const data: string[] = [];
    for (const raw of block.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) });
    } catch {
      /* 忽略心跳等非 JSON 帧 */
    }
  }
  return events;
}

async function seedCorpus(): Promise<{ imported: number; skipped: number; failed: number }> {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".md")).sort();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    const text = readFileSync(join(CORPUS_DIR, f), "utf8");
    const title = f.replace(/\.md$/, "");
    const { status, body } = await api("/api/documents", {
      method: "POST",
      body: JSON.stringify({ source: "file", sourceRef: f, title, text }),
    });
    if (status === 201) imported++;
    else if (status === 200 && body?.skipped) skipped++;
    else {
      failed++;
      console.error(`  ✖ 导入失败 ${f}: ${status} ${body?.error ?? ""}`);
    }
  }
  return { imported, skipped, failed };
}

async function ask(question: string): Promise<{ refused: boolean; citations: Citation[]; answer: string; nearestCount: number }> {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ask 失败 ${res.status}: ${text.slice(0, 200)}`);
  }
  const events = await readSse(res);
  const done = events.find((e) => e.event === "done");
  const err = events.find((e) => e.event === "error");
  if (err) throw new Error(`ask 出错: ${err.data?.message ?? "unknown"}`);
  const result = done?.data?.result;
  if (!result) throw new Error("ask 未返回 done 事件");
  return {
    refused: Boolean(result.refused),
    citations: Array.isArray(result.citations) ? result.citations : [],
    answer: String(result.answer ?? ""),
    nearestCount: Array.isArray(result.nearest) ? result.nearest.length : 0,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log(`\n评测目标：${BASE}`);
  const spec = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")) as { cases: EvalCase[] };
  const cases = spec.cases;

  console.log("\n[1/3] 灌入示例语料…");
  const seed = await seedCorpus();
  console.log(`  导入 ${seed.imported} · 跳过 ${seed.skipped} · 失败 ${seed.failed}`);
  if (seed.failed > 0) {
    console.error("  语料导入有失败，评测结果不可信，终止。");
    process.exitCode = 1;
    return;
  }

  console.log(`\n[2/3] 逐条问答（${cases.length} 条）…\n`);
  console.log("  ID    拒答  引用数  Recall  引用准确  期望文档");
  console.log("  " + "-".repeat(64));

  let recallHit = 0;
  let recallTotal = 0;
  let refusalCorrect = 0;
  let refusalTotal = 0;
  let falseRefusal = 0;
  let answerableTotal = 0;
  let citationChecked = 0;
  let citationCorrect = 0;
  const rows: Array<{ id: string; ok: string }> = [];

  for (const c of cases) {
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(c.question);
    } catch (e) {
      console.log(`  ${c.id}  ERROR ${e instanceof Error ? e.message : String(e)}`);
      rows.push({ id: c.id, ok: "ERROR" });
      continue;
    }

    let recallMark = "-";
    let citeMark = "-";

    if (c.shouldRefuse) {
      refusalTotal++;
      if (r.refused) {
        refusalCorrect++;
        recallMark = "OK(拒答)";
      } else {
        recallMark = "漏拒";
      }
    } else {
      answerableTotal++;
      if (r.refused) {
        falseRefusal++;
        recallMark = "误拒";
      } else {
        recallTotal++;
        const hitDoc = r.citations.some((x) => String(x.docTitle).includes(c.expectDoc ?? "\u0000"));
        if (hitDoc) recallHit++;
        recallMark = hitDoc ? "✓" : "✗";

        for (const cit of r.citations) {
          if (!c.expectKeyword) continue;
          citationChecked++;
          if (String(cit.snippet).includes(c.expectKeyword)) citationCorrect++;
        }
        const anyKeyword = r.citations.some((x) => String(x.snippet).includes(c.expectKeyword ?? "\u0000"));
        citeMark = anyKeyword ? "✓" : "✗";
      }
    }

    console.log(
      `  ${c.id.padEnd(5)} ${String(r.refused).padEnd(5)} ${String(r.citations.length).padEnd(6)} ${recallMark.padEnd(8)} ${citeMark.padEnd(9)} ${c.expectDoc ?? "（无，应拒答）"}`,
    );
    rows.push({ id: c.id, ok: recallMark });
  }

  console.log("\n[3/3] 汇总\n");
  console.log("  " + "=".repeat(52));
  console.log(`  Recall@k（引用命中期望文档）   ${recallHit}/${recallTotal}  ${pct(recallHit, recallTotal)}`);
  console.log(`  拒答正确率（无依据→拒答）      ${refusalCorrect}/${refusalTotal}  ${pct(refusalCorrect, refusalTotal)}`);
  console.log(`  误拒率（有依据却被拒答）        ${falseRefusal}/${answerableTotal}  ${pct(falseRefusal, answerableTotal)}`);
  console.log(`  引用准确率（片段含期望依据词）  ${citationCorrect}/${citationChecked}  ${pct(citationCorrect, citationChecked)}`);
  console.log("  " + "=".repeat(52));

  if (BASE.includes("127.0.0.1") || BASE.includes("localhost")) {
    console.log(
      "\n  ⚠️ 本地 shim 用的是词袋假嵌入，以上数字只证明「链路与指标计算正确」，" +
        "\n     阈值标定必须在线上真模型环境跑同一脚本（CONTEXT D16）。",
    );
  }

  // 非零退出：让 CI / 人工一眼看出不达标（阈值按 CONTEXT D5 的底线）
  const recallOk = recallTotal === 0 || recallHit / recallTotal >= 0.7;
  const refusalOk = refusalTotal === 0 || refusalCorrect / refusalTotal >= 0.7;
  const falseRefusalOk = answerableTotal === 0 || falseRefusal / answerableTotal <= 0.3;
  if (!recallOk || !refusalOk || !falseRefusalOk) {
    console.error("\n  ✖ 评测未达底线（Recall≥70% / 拒答正确≥70% / 误拒≤30%）");
    process.exitCode = 1;
  } else {
    console.log("\n  ✔ 达到底线（Recall≥70% / 拒答正确≥70% / 误拒≤30%）");
  }
}

await main();
