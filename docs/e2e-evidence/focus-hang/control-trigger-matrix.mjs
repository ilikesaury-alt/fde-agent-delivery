// 精细对照：锁定"停帧"的触发条件
// A: 不点任何东西，纯等待（基线）
// B: CDP 点击 h1（不聚焦任何表单元素）
// C: evaluate 里调用 ta.focus()（DOM 聚焦，不走 CDP 鼠标）
// D: CDP 点击 textarea（历史触发条件）
const task = await taskSpace("control-trigger-matrix");
const page = task.page("p1");

const MINIMAL = "data:text/html," + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>matrix</title></head>
<body>
<h1 id="h">heading</h1>
<textarea id="t" rows="8" cols="40"></textarea>
<input id="i" type="text">
</body></html>`);

const out = [];
const log = (o) => { out.push(o); console.log(JSON.stringify(o)); };

async function installProbe() {
  await page.evaluate(() => {
    window.__frames = 0; window.__ticks = 0;
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => { window.__ticks++; }, 100);
  });
}
async function sample(ms = 1000) {
  const a = await page.evaluate(() => ({ f: window.__frames, t: window.__ticks, focus: document.hasFocus(), act: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null }));
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => ({ f: window.__frames, t: window.__ticks, focus: document.hasFocus(), act: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null }));
  return { fps: b.f - a.f, ticks: b.t - a.t, hasFocus: b.focus, activeEl: b.act };
}

async function scenario(name, action) {
  await page.goto(MINIMAL, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(500);
  await installProbe();
  await page.waitForTimeout(800);
  const before = await sample(800);
  let actRes = "ok";
  try { await action(); } catch (e) { actRes = "THREW: " + String(e.message).split("\n")[0]; }
  await page.waitForTimeout(300);
  const after = await sample(1000);
  log({ scenario: name, action: actRes, before, after, frameDrop: before.fps > 10 && after.fps < 10 });
}

// A: 纯等待
await scenario("A_noop_wait", async () => { await page.waitForTimeout(300); });

// B: 点 h1（CDP 鼠标，但不聚焦表单元素）
await scenario("B_click_h1", async () => { await page.click("#h", { timeout: 8000 }); });

// C: DOM focus() textarea（不经 CDP 鼠标）
await scenario("C_dom_focus_textarea", async () => { await page.evaluate(() => document.getElementById("t").focus()); });

// D: CDP 点击 textarea
await scenario("D_cdp_click_textarea", async () => { await page.click("#t", { timeout: 8000 }); });

// E: CDP 点击 input
await scenario("E_cdp_click_input", async () => { await page.click("#i", { timeout: 8000 }); });

console.log("\n=== MATRIX ===");
console.table(out.map(o => ({ scenario: o.scenario, beforeFps: o.before.fps, afterFps: o.after.fps, afterTicks: o.after.ticks, hasFocus: o.after.hasFocus, activeEl: o.after.activeEl, dropped: o.frameDrop })));
