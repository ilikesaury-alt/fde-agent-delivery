/**
 * 扫描件路径线上验证（**真实扫描件**，跑完整链路）：
 *   真实 PDF → pdf.js 渲染页图 → 浏览器本地 PaddleOCR（PP-OCRv5）
 *   → 检测框按坐标重建表格 → 文本 → /api/extract → 预览确认闸（**不自动入库**）
 *
 * 为什么这个脚本重要：2026-10-29 之前服务端用 Workers AI 视觉模型读扫描件，
 * 同一份真实报告 4 次跑 0 次可用（值错行、名字认错、挂死）。改造后必须用**真实扫描件**
 * 回归，不能再用 canvas 合成图（合成图会掩盖真实失败，这是上一轮的教训）。
 *
 * 用法：ego-browser nodejs < e2e/live-scan.mjs
 * 输入：REAL_PDF 默认指向本机临时目录里的真实报告（不入库、不进 git）
 */

const fs = await import("node:fs");

const BASE = "https://health-track.ilikesaury.workers.dev";
const SECRETS = "H:/Work/Projects/Personal/fde-agent-delivery/product4/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(SECRETS, "utf8")).ACCESS_TOKEN;
const PDF = process.env.REAL_PDF || "C:/Users/lichun/AppData/Local/Temp/htreal/r.pdf";

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const task = await taskSpace("health-track 真实扫描件 e2e 2026-10-29");
const page = task.page("p1");

await page.goto(BASE, { waitUntil: "load", timeout: 45000 });
await page.evaluate((t) => localStorage.setItem("health_token", t), TOKEN);
await page.reload({ waitUntil: "load", timeout: 45000 });

/**
 * 等 React 水合完成再注入文件：否则 change 事件发出去了但 onChange 还没挂上，
 * 表现是「什么都没发生、也没有报错」（实测踩过：脚本超时、页面一片安静）。
 */
const hydrated = await (async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="extract-btn"]');
      const input = document.querySelector('[data-testid="ocr-input"]');
      // 水合后按钮会带 React 的受控属性；用「能点到输入框 + 按钮存在」作为就绪判据
      return !!btn && !!input && document.readyState === "complete";
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})();
check("页面已水合（可注入文件）", hydrated);

const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
check("跨源隔离已开启（多线程 WASM 前提）", isolated === true, String(isolated));

/* 把本机 PDF 注入文件输入框（DataTransfer + change 事件触发 React onChange）
 *
 * 为什么带重试：React 的水合与事件挂载不是「DOM ready」那一刻同时完成的，
 * 早注入会让 change 事件**被静默丢掉**（页面无进度、无报错，脚本干等到超时）。
 * 判据用「有没有出现识别进度」，而不是时间 —— 时间猜测在 CI/慢机器上必翻车。
 */
const b64 = fs.readFileSync(PDF).toString("base64");

const injectOnce = async () => {
  await page.evaluate(async (payload) => {
    const bin = atob(payload.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "real-report.pdf", { type: "application/pdf" });
    const input = document.querySelector('[data-testid="ocr-input"]');
    if (!input) throw new Error("找不到 ocr-input");
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { b64 });
};

const started = await (async () => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await injectOnce();
    // 给识别一个起势时间：进度条出现 = 事件被接住了
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const hit = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="ocr-progress"]');
        const t = document.querySelector('[data-testid="report-text"]');
        const n = document.querySelector('[data-testid="notice-banner"]');
        return Boolean(p) || ((t?.value ?? "").length > 0) || Boolean(n);
      });
      if (hit) return attempt;
    }
    console.log(`   注入未生效，重试（第 ${attempt} 次）…`);
  }
  return 0;
})();
check("文件注入被接住（识别已启动）", started > 0, started ? `第 ${started} 次生效` : "6 次均未生效");
console.log(`
已注入真实 PDF（${Math.round(b64.length / 1024)}KB），开始本地识别…`);

/** 等某个条件成立（OCR 在 Worker 里跑，主线程可响应） */
const waitFor = async (label, fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last?.done) return last;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`超时等待 ${label}：${JSON.stringify(last)}`);
};

const ocrState = await waitFor(
  "OCR 完成",
  () => {
    const ta = document.querySelector('[data-testid="report-text"]');
    const banner = document.querySelector('[data-testid="notice-banner"],[data-testid="error-banner"]');
    const progress = document.querySelector('[data-testid="ocr-progress"]');
    const text = ta?.value ?? "";
    return {
      done: text.trim().length > 0 && !progress,
      chars: text.length,
      text,
      notice: banner?.textContent ?? "",
      error: !!document.querySelector('[data-testid="error-banner"]'),
    };
  },
  420_000,
);

check("扫描件识别出文本", ocrState.chars > 100, `${ocrState.chars} 字符`);
check("没有错误横幅", ocrState.error !== true, ocrState.error ? ocrState.notice : "");
check("提示里说明「本地推理不上传」", /本地推理/.test(ocrState.notice), ocrState.notice.slice(0, 120));

console.log("\n────── 重建后的待抽取文本 ──────");
console.log(ocrState.text.trim().split("\n").map((l) => `  | ${l}`).join("\n"));

/* 表格重建质量：真实报告的 6 行（真值见 CONTEXT §10） */
const GT = [
  ["HBsAg (H)", "78.44", "0-0.05"],
  ["HBsAg", "78.440", "0-0.05"],
  ["HBsAb", "<2.000", "0-10"],
  ["HBeAg", "<0.05", "0-0.1"],
  ["HBeAb", ">5.00", "0-0.15"],
  ["HBcAb", ">25.00", "0-0.35"],
];
const norm = (t) => String(t).replace(/\s+/g, "");
const bodyLines = ocrState.text
  .trim()
  .split("\n")
  .filter((l) => l.includes("|"))
  .map((l) => norm(l));
check("首行是列序说明", /项目名称.*结果.*单位.*参考范围/.test(bodyLines[0] ?? ""), bodyLines[0] ?? "");
let rowHits = 0;
for (const [name, value, ref] of GT) {
  const line = bodyLines.find((l) => l.includes(norm(name)) && l.includes(norm(value)));
  if (line && line.includes(norm(ref))) rowHits++;
  else console.log(`   ✖ 未对上：${name} / ${value} / ${ref}`);
}
check("6 行指标（名称+值+参考范围）全对", rowHits === 6, `${rowHits}/6`);

/* 抽取 → 预览确认闸（**不入库**） */
await page.click('[data-testid="extract-btn"]');
const preview = await waitFor(
  "抽取完成",
  () => {
    const panel = document.querySelector('[data-testid="preview-panel"]');
    const date = document.querySelector('[data-testid="preview-date"]');
    return {
      done: !!panel,
      rows: document.querySelectorAll('[data-testid^="check-row-"]').length,
      date: date?.value ?? "",
      text: panel?.textContent?.slice(0, 200) ?? "",
    };
  },
  180_000,
);

check("抽取出指标行", preview.rows >= 5, `${preview.rows} 行`);
check("日期可编辑且有值（扫描件常丢页脚日期）", /^\d{4}-\d{2}-\d{2}$/.test(preview.date), preview.date);

/* 停在确认闸前：真实体检数据要不要入库由人决定 */
await page.click('[data-testid="discard-preview"]');
const cleared = await page.evaluate(() => !document.querySelector('[data-testid="preview-panel"]'));
check("放弃预览后状态回正（未入库）", cleared === true);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`真实扫描件链路：通过 ${passed} / ${results.length}`);
if (passed < results.length) {
  console.log("\n失败项:");
  for (const f of results.filter((r) => !r.ok)) console.log(`- ${f.name} — ${f.detail ?? ""}`);
}
await task.close?.();