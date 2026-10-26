// 决定性对照实验：极简页面（无 React / 无 CSS / 无 Tailwind / 无 Void）
// 若点 textarea 也卡 → 与本项目代码无关，是 ego-browser 窗口/焦点环境问题
const task = await taskSpace("control-minimal-textarea");
const page = task.page("p1");

const out = [];
const log = (o) => { out.push(o); console.log(JSON.stringify(o)); };

// 纯 HTML：一个 textarea，零样式零脚本框架
const MINIMAL = "data:text/html," + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>minimal</title></head>
<body>
<h1>minimal control page</h1>
<textarea id="t" rows="8" cols="40"></textarea>
<input id="i" type="text">
</body></html>`);

async function installProbe() {
  return page.evaluate(() => {
    window.__frames = 0; window.__ticks = 0; window.__alive = true;
    const tick = () => { if (!window.__alive) return; window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__timer = setInterval(() => { window.__ticks++; }, 100);
    return { visibility: document.visibilityState, hasFocus: document.hasFocus() };
  });
}

async function readProbe(label, timeoutMs = 5000) {
  const r = await Promise.race([
    page.evaluate(() => ({
      frames: window.__frames, ticks: window.__ticks,
      visibility: document.visibilityState, hasFocus: document.hasFocus(),
      activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    })).catch((e) => ({ evalError: String(e.message).split("\n")[0] })),
    new Promise((res) => setTimeout(() => res({ evalTimeout: true }), timeoutMs)),
  ]);
  log({ label, ...r });
  return r;
}

await page.goto(MINIMAL, { waitUntil: "load", timeout: 20000 });
await page.waitForTimeout(800);
log({ label: "minimal-installed", ...(await installProbe()) });
await page.waitForTimeout(1200);
const a = await readProbe("baseline");
await page.waitForTimeout(1000);
const b = await readProbe("baseline+1s");
log({ label: "FPS_BASELINE", fps: (b.frames || 0) - (a.frames || 0) });

// 点 textarea（历史触发条件）
let clickRes = "ok";
try { await page.click("#t", { timeout: 8000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ label: "click-textarea", result: clickRes });

const c = await readProbe("click+0.3s");
await page.waitForTimeout(1000);
const d = await readProbe("click+1.3s");
log({ label: "FPS_AFTER_CLICK", fps: (d.frames || 0) - (c.frames || 0), timerTicks: (d.ticks || 0) - (c.ticks || 0) });

let shotRes = "ok";
try { await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/control-minimal.png" }); }
catch (e) { shotRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ label: "screenshot", result: shotRes });

await readProbe("after-screenshot");
console.log("\n=== CONTROL SUMMARY ===");
