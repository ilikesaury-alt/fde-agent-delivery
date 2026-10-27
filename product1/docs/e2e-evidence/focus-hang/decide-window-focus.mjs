// 决定性验证：窗口有焦点 vs 无焦点，点 textarea 的 long task 时长
// 若「有焦点时 0ms」→ 说明这是 ego 后台窗口假象，真实用户不会遇到
const task = await taskSpace("focus-window-focus-test");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

async function fresh() {
  await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
  await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] });
    } catch {}
  });
}

async function waitRecover(t0, maxMs = 45000) {
  for (let i = 0; i < maxMs / 400; i++) {
    const r = await Promise.race([
      page.evaluate(() => window.__lt.slice()).catch(() => ({ err: 1 })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 600)),
    ]);
    if (!r.timeout && !r.err) return { ms: Date.now() - t0, lt: r };
    await page.waitForTimeout(200);
  }
  return null;
}

// ── 场景 1：无焦点直接点 textarea（历史复现条件）
await fresh();
const f0 = await page.evaluate(() => document.hasFocus());
log({ scenario: "1_no_window_focus", hasFocusBefore: f0 });
let t0 = Date.now();
try { await page.click("#textInput", { timeout: 25000 }); } catch {}
const r1 = await waitRecover(t0);
log({ scenario: "1_no_window_focus", result: r1 ? { recoveredMs: r1.ms, maxLT: Math.max(0, ...r1.lt) } : "no-recover" });

// ── 场景 2：先点 body 让窗口拿到焦点，再点 textarea
await fresh();
// 先点非表单区域拿焦点
try { await page.click("h1", { timeout: 10000 }); } catch { try { await page.click("body", { timeout: 10000 }); } catch {} }
await page.waitForTimeout(500);
const f2 = await page.evaluate(() => document.hasFocus());
log({ scenario: "2_with_window_focus", hasFocusBefore: f2 });

t0 = Date.now();
let click2 = "ok";
try { await page.click("#textInput", { timeout: 25000 }); } catch (e) { click2 = "THREW: " + String(e.message).split("\n")[0]; }
const r2 = await waitRecover(t0);
log({ scenario: "2_with_window_focus", click: click2, result: r2 ? { recoveredMs: r2.ms, maxLT: Math.max(0, ...r2.lt) } : "no-recover" });

// ── 场景 3：有焦点后，DOM focus() 到 textarea
await fresh();
try { await page.click("h1", { timeout: 10000 }); } catch {}
await page.waitForTimeout(500);
log({ scenario: "3_with_focus_domfocus", hasFocusBefore: await page.evaluate(() => document.hasFocus()) });
t0 = Date.now();
try { await page.evaluate(() => document.getElementById("textInput").focus()); } catch {}
const r3 = await waitRecover(t0);
log({ scenario: "3_with_focus_domfocus", result: r3 ? { recoveredMs: r3.ms, maxLT: Math.max(0, ...r3.lt) } : "no-recover" });

console.log("done");
