// 修复后量化复测：20 轮真实点击 + 完整用户流程（输入→生成→复制）
const task = await taskSpace("verify-fix-quant");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

async function fresh() {
  await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
  await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] });
    } catch {}
  });
}

// ── 20 轮点击 textarea 量化
let hang = 0, maxLT = 0, totalMs = 0;
for (let i = 1; i <= 20; i++) {
  await fresh();
  const t0 = Date.now();
  let ok = true;
  try { await page.click("#textInput", { timeout: 5000 }); } catch { ok = false; }
  // 立刻验证主线程可用
  const r = await Promise.race([
    page.evaluate(() => window.__lt.slice()).catch(() => ({ err: 1 })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 4000)),
  ]);
  const lt = (!r.timeout && !r.err) ? Math.max(0, ...r) : -1;
  const ms = Date.now() - t0;
  totalMs += ms;
  if (!ok || lt > 1000) { hang++; log({ round: i, HANG: true, clickOk: ok, maxLT: lt, ms }); }
  else { maxLT = Math.max(maxLT, lt); }
}
log({ step: "CLICK_20_ROUNDS", hang, maxLongTaskMs: maxLT, avgRoundMs: Math.round(totalMs / 20) });

// ── 完整用户流程
await fresh();
const flow = {};

// 1. 填入示例文本
await page.click("button:has-text('用示例文本试试')").catch(() => {});
await page.waitForTimeout(300);
flow.sampleFilled = await page.evaluate(() => (document.querySelector("#textInput")?.value || "").length);

// 2. 检查字数计数器
flow.counter = await page.evaluate(() => (document.body.innerText.match(/[\d,]+\s*\/\s*30,000/) || [null])[0]);

// 3. 点生成（会调 LLM；只验证按钮可点 + 不 hang，不等结果）
const t0 = Date.now();
let genOk = true;
try { await page.click("button:has-text('生成日报')", { timeout: 6000 }); } catch { genOk = false; }
flow.generateClickOk = genOk;
flow.generateClickMs = Date.now() - t0;

// 4. 生成中主线程仍可用？
const during = await Promise.race([
  page.evaluate(() => ({ alive: true, busy: document.body.innerText.includes("生成中") })).catch(() => ({ alive: false })),
  new Promise((res) => setTimeout(() => res({ timeout: true }), 4000)),
]);
flow.duringGenerate = during;

// 5. 等 LLM 返回（最多 60s），验证日报渲染
let rendered = null;
for (let i = 0; i < 60; i++) {
  const r = await page.evaluate(() => ({
    hasTable: !!document.querySelector("article table"),
    hasH2: document.querySelectorAll("article h2").length,
    chars: (document.body.innerText.match(/([\d,]+)\s*字符/) || [null, null])[1],
    text: document.body.innerText.slice(0, 200),
  })).catch(() => null);
  if (r && (r.hasH2 >= 4 || r.hasTable)) { rendered = r; break; }
  await page.waitForTimeout(1000);
}
flow.rendered = rendered;
flow.longTasksAfterFlow = await page.evaluate(() => window.__lt.slice()).catch(() => null);

log({ step: "USER_FLOW", ...flow });

// 6. 截图
try { await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/fixed-full-flow.png", fullPage: false }); log({ screenshot: "ok" }); }
catch (e) { log({ screenshot: "THREW: " + String(e.message).split("\n")[0] }); }

console.log("done");
