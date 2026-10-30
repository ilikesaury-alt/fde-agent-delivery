/**
 * 真实语料批量走查（**只验证、不入库**）：把目录里的 PDF 逐个走一遍真实链路。
 *
 * 两种路径都覆盖（用户真实遇到的就是这两种）：
 *   - 有文字层的电子版 PDF → pdf.js 抽文字 → 抽取
 *   - 无文字层的扫描件 → 渲染页图 → 浏览器本地 PaddleOCR → 表格重建 → 抽取
 *
 * 每个文件都停在**预览确认闸**：不点「确认入库」，最后点「放弃」。
 * 真实体检数据是否入库由人决定，批处理脚本没有这个权力。
 *
 * 用法：ego-browser nodejs < e2e/live-corpus.mjs
 * 输入：CORPUS_DIR 默认指向本机某个临时目录（不入 git）
 */

const fs = await import("node:fs");
const path = await import("node:path");
const url = await import("node:url");
// 注意：ego-browser 的 nodejs 通道把脚本当**非模块** eval —— 不能用静态 import，
// 也不能用 import.meta（CJS 下直接 SyntaxError）；而且 `process.cwd()` 是 ego 自己的安装目录，
// 不是本仓目录。所以路径一律写绝对路径。
const P4 = "H:/Work/Projects/Personal/fde-agent-delivery/product4";
const { scoreReport, parsePreviewRows, aggregate } = await import(
  url.pathToFileURL(path.resolve(P4, "e2e/corpus-score.mjs")).href
);

const TRUTH = JSON.parse(fs.readFileSync(path.resolve(P4, "eval/corpus/truth.json"), "utf8"));

const BASE = "https://health-track.ilikesaury.workers.dev";
const SECRETS = "H:/Work/Projects/Personal/fde-agent-delivery/product4/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(SECRETS, "utf8")).ACCESS_TOKEN;
const DIR = process.env.CORPUS_DIR || "C:/Users/lichun/AppData/Local/Temp/corpus";
const OUT = "C:/Users/lichun/AppData/Local/Temp/htreal/corpus-result.json";

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith(".pdf"))
  .sort();

const task = await taskSpace("health-track 真实语料批量 2026-10-29");
const page = task.page("p1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 React 水合（否则 change 事件被静默丢掉） */
const waitHydrated = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      return document.readyState === "complete" &&
        !!document.querySelector('[data-testid="ocr-input"]') &&
        !!document.querySelector('[data-testid="pdf-input"]');
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
};

const state = () =>
  page.evaluate(() => ({
    text: document.querySelector('[data-testid="report-text"]')?.value ?? "",
    notice: document.querySelector('[data-testid="notice-banner"]')?.textContent ?? "",
    error: document.querySelector('[data-testid="error-banner"]')?.textContent ?? "",
    busy: !!document.querySelector('[data-testid="ocr-progress"]'),
    preview: !!document.querySelector('[data-testid="preview-panel"]'),
    rows: document.querySelectorAll('[data-testid^="check-row-"]').length,
    date: document.querySelector('[data-testid="preview-date"]')?.value ?? "",
    extracting: /解析中/.test(document.querySelector('[data-testid="extract-btn"]')?.textContent ?? ""),
  }));

/** 注入文件到指定 input，直到出现「起势」（文本/进度/提示），最多 6 次 */
const inject = async (testId, buf) => {
  const b64 = buf.toString("base64");
  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.evaluate(
      async (a) => {
        const bin = atob(a.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const input = document.querySelector(`[data-testid="${a.testId}"]`);
        if (!input) throw new Error("找不到输入框 " + a.testId);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], a.name, { type: "application/pdf" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { testId, b64, name: testId + ".pdf" },
    );
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const s = await state();
      if (s.text.length > 0 || s.busy || s.notice.length > 0 || s.error.length > 0) return attempt;
    }
  }
  return 0;
};

const waitUntil = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state();
    if (fn(s)) return s;
    await sleep(1500);
  }
  throw new Error(`超时：${label}`);
};

const results = [];

for (const file of files) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const t0 = Date.now();
  const key = file.replace(/\.pdf$/i, "");
  const rec = { file, sizeKB: Math.round(buf.length / 1024), path: "", note: "", ms: 0 };

  try {
    await page.goto(BASE, { waitUntil: "load", timeout: 45_000 });
    // 令牌要**确认写进去再重载**：偶发竞态会让第一个文件跑到「访问令牌缺失」（实测）
    for (let t = 0; t < 3; t++) {
      await page.evaluate((tok) => localStorage.setItem("health_token", tok), TOKEN);
      await page.reload({ waitUntil: "load", timeout: 45_000 });
      const has = await page.evaluate(() => localStorage.getItem("health_token")?.startsWith("ht_") === true);
      if (has) break;
    }
    await waitHydrated();

    /* ① 先走电子版路径 */
    const a1 = await inject("pdf-input", buf);
    if (a1 === 0) throw new Error("pdf-input 注入未生效");
    // 扫描件这一步的「成功」是**一条提示**（没有文字层），不是文本 —— 判据必须包含 notice
    let s = await waitUntil((x) => x.text.length > 0 || x.error.length > 0 || x.notice.length > 0, 60_000, "PDF 抽文本");

    if (s.error) {
      rec.path = "error";
      rec.failed = true;
      rec.note = s.error.slice(0, 80);
      results.push(rec);
      continue;
    }

    const noTextLayer = /没有文字层/.test(s.notice);
    if (noTextLayer) {
      /* ② 扫描件：走本地 OCR */
      const a2 = await inject("ocr-input", buf);
      if (a2 === 0) throw new Error("ocr-input 注入未生效");
      s = await waitUntil((x) => (x.text.length > 0 && !x.busy) || x.error.length > 0, 420_000, "OCR");
      if (s.error) throw new Error(s.error.slice(0, 120));
      rec.path = "scan";
      const rowCount = s.text.split("\n").filter((l) => l.includes("|")).length - 1;
      rec.scanRows = Math.max(0, rowCount);
      rec.scanHeaderOk = /项目名称/.test(s.text);
      rec.scanDate = (s.text.match(/检测日期：(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null;
      rec.note = /没认出表头/.test(s.notice) ? "表头未认出（按位置排）" : "";
      const slowest = (s.notice.match(/最慢一页 (\d+)s/) ?? [])[1];
      rec.pageSec = slowest ? Number(slowest) : null;
    } else {
      rec.path = "text";
      rec.note = (s.notice.match(/已抽取 (\d+) 页/) ?? ["", "?"])[1] + " 页文本";
    }

    /* ③ 抽取 → 预览（不入库） */
    await page.evaluate(() => document.querySelector('[data-testid="extract-btn"]')?.click());
    s = await waitUntil((x) => x.preview || x.error.length > 0, 240_000, "抽取");
    if (s.error) throw new Error(s.error.slice(0, 120));
    rec.extractRows = s.rows;
    rec.checkDate = s.date;
    // 记录勾选数：散文式报告（无参考范围）默认应当「一条都不勾」
    rec.checked = await page.evaluate(() => document.querySelectorAll('[data-testid^="check-row-"]:checked').length);
    const rawRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="preview-panel"] table tbody tr')).map((tr) => ({
        checked: tr.querySelector('[data-testid^="check-row-"]')?.checked ?? false,
        cells: Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()),
      })),
    );
    rec.preview = rawRows;
    await page.evaluate(() => document.querySelector('[data-testid="discard-preview"]')?.click());
    await sleep(600);
  } catch (e) {
    rec.failed = true;
    rec.note = `${rec.note ? rec.note + " · " : ""}失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
  }

  // 真值按**文件名前缀**匹配（真值集里只写 hash 前 20 位，便于人读）
  const truthEntry = Object.entries(TRUTH).find(([k]) => k !== "_readme" && key.startsWith(k));
  const truth = truthEntry?.[1];
  if (truth && rec.preview?.length) {
    rec.score = scoreReport(truth, parsePreviewRows(rec.preview));
    rec.dateOk = rec.checkDate === truth.date;
    rec.title = truth.title;
  }
  delete rec.preview;

  rec.ms = Date.now() - t0;
  results.push(rec);
  console.log(
    `${rec.failed ? "✖" : "✔"} ${file.slice(0, 26)}… ${rec.path.padEnd(6)} ` +
      `抽取=${rec.extractRows ?? "-"}行 日期=${rec.checkDate ?? "-"} ` +
      `${rec.path === "scan" ? `重建=${rec.scanRows}行 表头=${rec.scanHeaderOk ? "ok" : "no"} 单页=${rec.pageSec ?? "?"}s ` : ""}` +
      `${(rec.ms / 1000).toFixed(0)}s ${rec.note}`,
  );
  if (rec.score) {
    const sc = rec.score;
    const lines = [
      `    真值标定 ${rec.title}：行 ${sc.matched}/${sc.truth} · 名称 ${sc.name}/${sc.truth} · 结果 ${sc.value}/${sc.truth} · 单位 ${sc.unit}/${sc.truth} · 参考范围 ${sc.ref}/${sc.truth} · 状态 ${sc.status}/${sc.truth} · 日期 ${rec.dateOk ? "✓" : "✗"}`,
    ];
    if (sc.missed.length) lines.push(`    漏行：${sc.missed.join("、")}`);
    if (sc.extra.length) lines.push(`    多行：${sc.extra.join("、")}`);
    for (const m of sc.misses) lines.push(`    ${m}`);
    const NL = String.fromCharCode(10);
    console.log(lines.join(NL));
  }
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");

const ok = results.filter((r) => !r.failed).length;
console.log(`\n${"=".repeat(64)}`);
console.log(`语料走查：可用 ${ok} / ${results.length}`);
console.log(`扫描件 ${results.filter((r) => r.path === "scan").length} 份 · 电子版 ${results.filter((r) => r.path === "text").length} 份`);
for (const r of results.filter((x) => x.path === "scan")) {
  console.log(`  · ${r.file.slice(0, 20)}… 重建 ${r.scanRows} 行 · 表头 ${r.scanHeaderOk ? "识别" : "未识别"} · 抽取 ${r.extractRows ?? "-"} 行`);
}
const scored = results.filter((r) => r.score);
if (scored.length) {
  const agg = aggregate(scored.map((r) => r.score));
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  console.log(`
真值标定（${scored.length} 份有真值的报告）：`);
  console.log(`  行对齐 ${agg.matched}/${agg.truth} ${pct(agg.matched, agg.truth)}`);
  console.log(`  名称   ${agg.name}/${agg.truth} ${pct(agg.name, agg.truth)}`);
  console.log(`  结果   ${agg.value}/${agg.truth} ${pct(agg.value, agg.truth)}`);
  console.log(`  单位   ${agg.unit}/${agg.truth} ${pct(agg.unit, agg.truth)}`);
  console.log(`  参考范围 ${agg.ref}/${agg.truth} ${pct(agg.ref, agg.truth)}`);
  console.log(`  状态   ${agg.status}/${agg.truth} ${pct(agg.status, agg.truth)}`);
  console.log(`  日期   ${scored.filter((r) => r.dateOk).length}/${scored.length}`);
  console.log(`  多行合计 ${scored.reduce((n, r) => n + r.score.extra.length, 0)} 行 · 漏行合计 ${scored.reduce((n, r) => n + r.score.missed.length, 0)} 行`);
}
console.log(`明细：${OUT}`);
await task.close?.();