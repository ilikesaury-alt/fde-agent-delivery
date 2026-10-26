// 量化 React 内部循环次数 + 判定触发源（CDP 点击 vs DOM focus）
const task = await taskSpace("instrument-react-loop");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

// 装计数器：劫持 previousSibling / parentNode / focus 事件
const inst = await page.evaluate(() => {
  window.__c = { prev: 0, parent: 0, focusin: 0, click: 0, pointerdown: 0, mousedown: 0, selectstart: 0, selectionchange: 0 };

  const desc = Object.getOwnPropertyDescriptor(Node.prototype, "previousSibling");
  Object.defineProperty(Node.prototype, "previousSibling", {
    configurable: true,
    get() { window.__c.prev++; return desc.get.call(this); },
  });
  const pdesc = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode");
  Object.defineProperty(Node.prototype, "parentNode", {
    configurable: true,
    get() { window.__c.parent++; return pdesc.get.call(this); },
  });

  for (const ev of ["focusin", "click", "pointerdown", "mousedown", "selectstart", "selectionchange"]) {
    document.addEventListener(ev, () => { window.__c[ev]++; }, true);
  }

  window.__longtasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  return { ok: true };
});
log({ step: "instrumented", ...inst });

const snap = () => page.evaluate(() => ({ ...window.__c }));

const before = await snap();
log({ step: "counters_before", ...before });

// 测试 1：DOM focus()（不经 CDP 鼠标）
let focusRes = "ok";
try { await page.evaluate(() => document.getElementById("textInput").focus()); }
catch (e) { focusRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ step: "dom_focus", result: focusRes });

await page.waitForTimeout(3000);
const afterFocus = await Promise.race([
  snap().catch(() => ({ evalFailed: true })),
  new Promise((r) => setTimeout(() => r({ evalTimeout: true }), 8000)),
]);
log({ step: "counters_after_dom_focus", ...afterFocus });

const ltAfterFocus = await page.evaluate(() => window.__longtasks.slice()).catch(() => null);
log({ step: "longtasks_after_dom_focus", lt: ltAfterFocus });

// 测试 2：CDP 点击
await page.evaluate(() => { window.__c = { prev: 0, parent: 0, focusin: 0, click: 0, pointerdown: 0, mousedown: 0, selectstart: 0, selectionchange: 0 }; window.__longtasks.length = 0; });
let clickRes = "ok";
try { await page.click("#textInput", { timeout: 25000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ step: "cdp_click", result: clickRes });

const t0 = Date.now();
let recovered = null;
for (let i = 0; i < 60; i++) {
  const r = await Promise.race([
    page.evaluate(() => ({ ...window.__c, lt: window.__longtasks.slice() })).catch(() => ({ err: 1 })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 800)),
  ]);
  if (!r.timeout && !r.err) { recovered = { ms: Date.now() - t0, ...r }; break; }
  await page.waitForTimeout(200);
}
log({ step: "counters_after_cdp_click", ...(recovered || { recovered: false }) });

console.log("done");
