// 线上最终验证：新隧道 + cheap-first + 修复后的 UI（完整用户流程）
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();

const task = await taskSpace("live-final-verify");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

await page.goto(URL_, { waitUntil: "commit", timeout: 30000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 30000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1500);

// 装 longtask 探针
await page.evaluate(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] });
  } catch {}
});

// 1. 结构检查
const struct = await page.evaluate(() => ({
  title: document.title,
  is1101: document.documentElement.outerHTML.includes("Error 1101"),
  hasTA: !!document.querySelector("#textInput"),
  appContainsMeta: !!document.querySelector("#app meta"),
  htmlHeadBodyComments: (document.documentElement.outerHTML.match(/<!--html-->|<!--head-->|<!--body-->/g) || []).length,
  counter: (document.body.innerText.match(/[\d,]+\s*\/\s*30,000/) || [null])[0],
}));
log({ step: "STRUCTURE", ...struct });

// 2. health
const health = await page.evaluate(async () => {
  try { const r = await fetch("/api/health"); return { status: r.status, body: await r.text() }; } catch (e) { return { err: String(e) }; }
});
log({ step: "HEALTH", ...health });

// 3. 点击 textarea（旧 bug 触发点）— 关键验证
const t0 = Date.now();
let clickOk = true;
try { await page.click("#textInput", { timeout: 8000 }); } catch { clickOk = false; }
const r1 = await Promise.race([
  page.evaluate(() => window.__lt.slice()).catch(() => ({ err: 1 })),
  new Promise((res) => setTimeout(() => res({ timeout: true }), 4000)),
]);
log({ step: "CLICK_TEXTAREA", clickOk, ms: Date.now() - t0, maxLongTask: (!r1.timeout && !r1.err) ? Math.max(0, ...r1) : "unavailable" });

// 4. 填示例 + 生成日报（真实 LLM）
await page.click("button:has-text('用示例文本试试')").catch(() => {});
await page.waitForTimeout(400);
const filled = await page.evaluate(() => (document.querySelector("#textInput")?.value || "").length);
log({ step: "SAMPLE_FILLED", chars: filled });

const tGen = Date.now();
await page.click("button:has-text('生成日报')").catch(() => {});
log({ step: "GENERATE_CLICKED" });

// 等日报渲染（最多 120s）
let rendered = null;
for (let i = 0; i < 120; i++) {
  const r = await page.evaluate(() => ({
    h2: document.querySelectorAll("article h2, .doc h2").length,
    tables: document.querySelectorAll("article table, .doc table").length,
    hint: (document.querySelector("[role=status]") || {}).innerText || "",
    status: (document.querySelector("header span[data-state]") || {}).innerText || "",
    bodyStart: document.body.innerText.slice(0, 300),
  })).catch(() => null);
  if (r && r.h2 >= 4) { rendered = { ...r, ms: Date.now() - tGen }; break; }
  if (r && /不可用|出错了|失败/.test(r.hint + r.status) && i > 3) { rendered = { ...r, ms: Date.now() - tGen, failed: true }; break; }
  await page.waitForTimeout(1000);
}
log({ step: "DIGEST_RESULT", ...(rendered || { timeout: true, ms: Date.now() - tGen }) });

// 5. 全程 long task 汇总
const lt = await page.evaluate(() => window.__lt.slice()).catch(() => null);
log({ step: "ALL_LONG_TASKS", count: lt ? lt.length : null, max: lt ? Math.max(0, ...lt) : null, list: lt });

console.log("done");
