/**
 * 线上评测（浏览器通道版）—— 在真模型 + 真 bge-m3 + 真 Vectorize 上算四项指标。
 *
 * 为什么不用 eval/run.ts：那个脚本走 Node fetch，沙箱出网被限（直连 workers.dev 超时），
 * 但 ego-browser 的 Chromium 进程网络栈不受同一限制（与 e2e/live-e2e.mjs 同理）。
 *
 * 与本地 eval 的等价性：判定逻辑（Recall@k / 拒答正确率 / 误拒率 / 引用准确率）与
 * eval/run.ts 逐条一致；语料与用例来自同一份 eval/ 目录（Node 侧读文件注入页面）。
 *
 * 库污染控制：导入前记录库快照 → 只导入 corpus 的 4 篇（sourceRef=文件名）→ 跑完按
 * sourceRef 精确删除这 4 篇。**不碰用户自己的文档**；但用户文档仍在库里，会影响
 * 召回排序（结论里会标注「库内还有 N 篇其它文档」）。
 *
 * 用法：ego-browser nodejs < e2e/live-eval.mjs
 */

const fs = await import("node:fs");
const path = await import("node:path");

const ROOT = "H:/Work/Projects/Personal/fde-agent-delivery/product3";
const BASE = "https://kb-ask.ilikesaury.workers.dev";
const TOKEN = JSON.parse(fs.readFileSync(`${ROOT}/.secrets.json`, "utf8")).ACCESS_TOKEN;

// ── Node 侧：读评测集与语料 ─────────────────────────────────────────
const spec = JSON.parse(fs.readFileSync(`${ROOT}/eval/cases.json`, "utf8"));
const corpusDir = `${ROOT}/eval/corpus`;
const corpus = fs
  .readdirSync(corpusDir)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({
    file: f,
    title: f.replace(/\.md$/, ""),
    text: fs.readFileSync(path.join(corpusDir, f), "utf8"),
  }));

const task = await taskSpace("kb-ask live eval");
const page = task.page("p1");
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.evaluate((t) => localStorage.setItem("kb_token", t), TOKEN);
await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, 1000));

// ── 注入评测数据 ───────────────────────────────────────────────────
await page.evaluate(() => {
  window.__corpus = [];
  window.__cases = [];
});
for (const c of corpus) await page.evaluate((c) => window.__corpus.push(c), c);
for (const c of spec.cases) await page.evaluate((c) => window.__cases.push(c), c);
console.log(`已注入：语料 ${corpus.length} 篇 · 用例 ${spec.cases.length} 条`);

// ── 页面内执行：导入 → 等索引 → 逐条问答 ──────────────────────────
await page.evaluate(() => {
  window.__evalResult = null;
  (async () => {
    const TOKEN = localStorage.getItem("kb_token") ?? "";
    const call = async (p, init = {}) => {
      const res = await fetch(p, {
        ...init,
        headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text.slice(0, 200) };
      }
      return { status: res.status, body };
    };

    const before = await call("/api/documents");
    const preExisting = (before.body?.documents ?? []).map((d) => ({ id: d.id, title: d.title }));

    const imported = [];
    for (const c of window.__corpus) {
      const r = await call("/api/documents", {
        method: "POST",
        body: JSON.stringify({ source: "file", sourceRef: c.file, title: c.title, text: c.text }),
      });
      imported.push({ file: c.file, id: r.body?.document?.id, status: r.status, skipped: r.body?.skipped });
    }
    const failedImport = imported.filter((x) => x.status !== 201 && x.status !== 200);

    // 等索引追上（Vectorize 异步；线上实测约 70s）
    let waited = 0;
    const probeId = imported.find((x) => x.id)?.id;
    while (waited < 180000) {
      await new Promise((r) => setTimeout(r, 10000));
      waited += 10000;
      if (!probeId) break;
      const p = await call("/api/probe", { method: "POST", body: JSON.stringify({ id: probeId }) });
      if (p.body?.searchable === true) break;
    }
    const indexWaitSec = Math.round(waited / 1000);

    const ask = async (question) => {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN },
        body: JSON.stringify({ question }),
      });
      const text = await res.text();
      const events = [];
      for (const block of text.split("\n\n")) {
        if (!block.trim()) continue;
        let event = "message";
        const data = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (!data.length) continue;
        try {
          events.push({ event, data: JSON.parse(data.join("\n")) });
        } catch {
          /* 心跳帧 */
        }
      }
      const done = events.find((e) => e.event === "done");
      const err = events.find((e) => e.event === "error");
      return {
        error: err?.data?.message ?? null,
        result: done?.data?.result ?? null,
        detail: String(
          events.find(
            (e) => e.event === "step" && e.data?.step === "retrieve" && e.data?.status === "done",
          )?.data?.detail ?? "",
        ),
      };
    };

    const rows = [];
    for (const c of window.__cases) {
      const r = await ask(c.question);
      const result = r.result;
      const citations = Array.isArray(result?.citations) ? result.citations : [];
      rows.push({
        id: c.id,
        error: r.error,
        refused: Boolean(result?.refused),
        citations: citations.length,
        docHit: c.expectDoc ? citations.some((x) => String(x.docTitle).includes(c.expectDoc)) : null,
        keywordHit: c.expectKeyword ? citations.some((x) => String(x.snippet).includes(c.expectKeyword)) : null,
        detail: r.detail,
      });
    }

    for (const x of imported) {
      if (x.id) await call(`/api/documents?id=${encodeURIComponent(x.id)}`, { method: "DELETE" });
    }

    window.__evalResult = { rows, imported, failedImport, preExisting, indexWaitSec };
  })().catch((e) => {
    window.__evalResult = { error: String(e) };
  });
});

// ── Node 侧轮询 + 汇总（口径与 eval/run.ts 一致）──────────────────
for (let i = 0; i < 900; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await page.evaluate(() => window.__evalResult);
  if (!res) {
    if (i % 15 === 14) console.log(`  … 运行中（${(i + 1) * 2}s）`);
    continue;
  }
  if (res.error) {
    console.log("评测异常:", res.error);
    break;
  }

  console.log(`\n库内原有文档: ${res.preExisting.length} 篇（未改动）`);
  console.log(
    `语料导入: ${res.imported.filter((x) => x.status === 201).length} 新增 / ${res.imported.filter((x) => x.skipped).length} 跳过 / ${res.failedImport.length} 失败`,
  );
  console.log(`索引等待: ${res.indexWaitSec}s`);
  console.log(`\n  ID    拒答  引用  Recall 引用准确 期望文档`);
  console.log(`  ${"-".repeat(64)}`);

  let recallHit = 0;
  let recallTotal = 0;
  let refusalCorrect = 0;
  let refusalTotal = 0;
  let falseRefusal = 0;
  let answerableTotal = 0;
  let citeChecked = 0;
  let citeCorrect = 0;

  for (const c of spec.cases) {
    const row = res.rows.find((r) => r.id === c.id);
    if (!row) {
      console.log(`  ${c.id.padEnd(5)} (无结果)`);
      continue;
    }
    let recallMark = "-";
    let citeMark = "-";
    if (c.shouldRefuse) {
      refusalTotal++;
      if (row.refused) {
        refusalCorrect++;
        recallMark = "OK(拒答)";
      } else {
        recallMark = "漏拒";
      }
    } else {
      answerableTotal++;
      if (row.refused) {
        falseRefusal++;
        recallMark = "误拒";
      } else {
        recallTotal++;
        const hit = Boolean(row.docHit);
        if (hit) recallHit++;
        recallMark = hit ? "✓" : "✗";
        if (c.expectKeyword) {
          citeChecked++;
          if (row.keywordHit) citeCorrect++;
          citeMark = row.keywordHit ? "✓" : "✗";
        }
      }
    }
    console.log(
      `  ${c.id.padEnd(5)} ${String(row.refused).padEnd(5)} ${String(row.citations).padEnd(5)} ${recallMark.padEnd(7)} ${citeMark.padEnd(8)} ${c.expectDoc ?? "（无，应拒答）"}${row.error ? "  ERROR:" + row.error : ""}`,
    );
  }

  const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);
  console.log(`\n  ${"=".repeat(52)}`);
  console.log(`  Recall@k（引用命中期望文档）   ${recallHit}/${recallTotal}  ${pct(recallHit, recallTotal)}`);
  console.log(`  拒答正确率（无依据→拒答）      ${refusalCorrect}/${refusalTotal}  ${pct(refusalCorrect, refusalTotal)}`);
  console.log(`  误拒率（有依据却被拒答）        ${falseRefusal}/${answerableTotal}  ${pct(falseRefusal, answerableTotal)}`);
  console.log(`  引用准确率（片段含期望依据词）  ${citeCorrect}/${citeChecked}  ${pct(citeCorrect, citeChecked)}`);
  console.log(`  ${"=".repeat(52)}`);

  const recallOk = recallTotal === 0 || recallHit / recallTotal >= 0.7;
  const refusalOk = refusalTotal === 0 || refusalCorrect / refusalTotal >= 0.7;
  const falseRefusalOk = answerableTotal === 0 || falseRefusal / answerableTotal <= 0.3;
  console.log(
    recallOk && refusalOk && falseRefusalOk
      ? "\n  ✔ 达到底线（Recall≥70% / 拒答正确≥70% / 误拒≤30%）"
      : "\n  ✖ 未达底线（Recall≥70% / 拒答正确≥70% / 误拒≤30%）",
  );
  console.log(`  ⚠️ 线上库内还有其它文档（见上方「库内原有文档」）→ 指标含污染，非纯净基线`);
  break;
}
