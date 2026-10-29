// 决定性实验：区分 H1(真死循环) / H2(不产帧) / H3(CDP通道)
// 核心判据：hang 期间 evaluate（不需帧）是否仍可用？rAF（需帧）是否停止？
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();

const task = await taskSpace("focus-hang-hypothesis-split");
const page = task.page("p1");

const out = [];
function log(o) { out.push(o); console.log(JSON.stringify(o)); }

async function enter() {
  try { await page.goto(URL_, { waitUntil: "commit", timeout: 15000 }); } catch {}
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  try { await page.reload({ waitUntil: "commit", timeout: 15000 }); } catch {}
  await page.waitForSelector("#textInput", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

// 装 rAF 计数器（需帧才增长）
async function installProbe() {
  return page.evaluate(() => {
    const w = window;
    w.__frames = 0;
    w.__probeAlive = true;
    const tick = () => { if (!w.__probeAlive) return; w.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    // 同时装一个不需要帧的计数器（setInterval 由定时器驱动）
    w.__ticks = 0;
    w.__timer = setInterval(() => { w.__ticks++; }, 100);
    return { installed: true, visibility: document.visibilityState, hasFocus: document.hasFocus() };
  });
}

// 用 evaluate 读探针（evaluate 不需要帧）
async function readProbe(label, timeoutMs = 4000) {
  const r = await Promise.race([
    page.evaluate(() => ({
      frames: window.__frames,
      ticks: window.__ticks,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      activeEl: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    })).catch((e) => ({ evalError: String(e).split("\n")[0] })),
    new Promise((res) => setTimeout(() => res({ evalTimeout: true }), timeoutMs)),
  ]);
  log({ label, ...r });
  return r;
}

await enter();
const base = await installProbe();
log({ label: "installed", ...base });

await page.waitForTimeout(1000);
const f1 = await readProbe("t=1s after install");

await page.waitForTimeout(1000);
const f2 = await readProbe("t=2s after install");
log({ label: "FPS_BASELINE", fps: (f2.frames || 0) - (f1.frames || 0), timerTicks: (f2.ticks || 0) - (f1.ticks || 0) });

// 点击 textarea —— 这一步历史上会挂
let clickResult = "ok";
try {
  await page.click("#textInput", { timeout: 8000 });
} catch (e) {
  clickResult = "THREW: " + String(e.message).split("\n")[0];
}
log({ label: "click", result: clickResult });

// 点击后立刻用 evaluate 读探针（关键判据）
const p1 = await readProbe("t+0.3s after click");
await page.waitForTimeout(1000);
const p2 = await readProbe("t+1.3s after click");
log({ label: "FPS_AFTER_CLICK", fps: (p2.frames || 0) - (p1.frames || 0), timerTicks: (p2.ticks || 0) - (p1.ticks || 0) });

// 再测截图（需帧）
let shotResult = "ok";
try { await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/hypothesis-split.png" }); }
catch (e) { shotResult = "THREW: " + String(e.message).split("\n")[0]; }
log({ label: "screenshot", result: shotResult });

// 再读一次探针
await readProbe("t+ after screenshot");

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(out, null, 2));
