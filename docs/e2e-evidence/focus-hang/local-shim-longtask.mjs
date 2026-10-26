// 本地 shim 对照：同一份代码，测点击 textarea 的 long task 时长
// 对照线上 30.9s —— 若本地无长阻塞，则问题在线上资源/运行时，而非代码
const URL_ = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";
const task = await taskSpace("local-shim-longtask");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

await page.goto(URL_, { waitUntil: "commit", timeout: 20000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "commit", timeout: 20000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

const installed = await page.evaluate(() => {
  window.__marks = []; window.__frames = 0; window.__longtasks = [];
  const tick = () => { window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    window.__marks.push({ t: Math.round(performance.now()), f: window.__frames });
    if (window.__marks.length > 600) window.__marks.shift();
  }, 100);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) });
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  return { hasTextarea: !!document.querySelector("#textInput"), visibility: document.visibilityState };
});
log({ step: "installed", ...installed });
await page.waitForTimeout(1200);

const pre = await page.evaluate(() => ({ t: Math.round(performance.now()), f: window.__frames }));
log({ step: "pre-click", ...pre });

let clickRes = "ok";
try { await page.click("#textInput", { timeout: 20000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ step: "click", result: clickRes });

const t0 = Date.now();
let recovered = null;
for (let i = 0; i < 40; i++) {
  const r = await Promise.race([
    page.evaluate(() => ({ t: Math.round(performance.now()), f: window.__frames })).catch((e) => ({ err: String(e.message).split("\n")[0] })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 800)),
  ]);
  if (!r.timeout && !r.err) { recovered = { attempt: i, elapsedMs: Date.now() - t0, ...r }; break; }
  await page.waitForTimeout(200);
}
log({ step: "recovered", ...(recovered || { recovered: false, elapsedMs: Date.now() - t0 }) });

const data = await Promise.race([
  page.evaluate(() => ({ marks: window.__marks, longtasks: window.__longtasks, frames: window.__frames })),
  new Promise((res) => setTimeout(() => res({ evalTimeout: true }), 6000)),
]);
if (data.marks) {
  const gaps = [];
  for (let i = 1; i < data.marks.length; i++) {
    const g = data.marks[i].t - data.marks[i - 1].t;
    if (g > 150) gaps.push({ gapMs: g, framesDuring: data.marks[i].f - data.marks[i - 1].f });
  }
  log({ step: "GAPS>150ms", count: gaps.length, gaps: gaps.slice(0, 5) });
  const lt = (data.longtasks || []).sort((a, b) => b.d - a.d).slice(0, 5);
  log({ step: "LONG_TASKS", count: (data.longtasks || []).length, top: lt });
} else {
  log({ step: "readback", result: data });
}
