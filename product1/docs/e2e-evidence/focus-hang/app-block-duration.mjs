// 量化 app 页面的主线程阻塞时长（极简页只停帧不停主线程，app 页两者都停）
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();
const task = await taskSpace("app-block-duration");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

await page.goto(URL_, { waitUntil: "commit", timeout: 20000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "commit", timeout: 20000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// 装探针：记录每个 interval 的时间戳 + rAF 帧数 + longtask
const installed = await page.evaluate(() => {
  window.__marks = [];      // 每 100ms 一条 {t, frames}
  window.__frames = 0;
  window.__longtasks = [];
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
  return { ok: true, hasTextarea: !!document.querySelector("#textInput"), visibility: document.visibilityState, hasFocus: document.hasFocus() };
});
log({ step: "installed", ...installed });

await page.waitForTimeout(1200);

// 记录点击前的 mark 索引
const pre = await page.evaluate(() => ({ n: window.__marks.length, t: Math.round(performance.now()), f: window.__frames }));
log({ step: "pre-click", ...pre });

// CDP 点击 textarea
let clickRes = "ok";
try { await page.click("#textInput", { timeout: 15000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ step: "click", result: clickRes });

// 轮询直到 evaluate 恢复，测量无响应时长
const t0 = Date.now();
let recovered = null;
for (let i = 0; i < 60; i++) {
  const r = await Promise.race([
    page.evaluate(() => ({ t: Math.round(performance.now()), f: window.__frames, marks: window.__marks.length })).catch((e) => ({ err: String(e.message).split("\n")[0] })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 1000)),
  ]);
  if (!r.timeout && !r.err) { recovered = { attempt: i, elapsedMs: Date.now() - t0, ...r }; break; }
  await page.waitForTimeout(500);
}
log({ step: "recovered", ...(recovered || { recovered: false, elapsedMs: Date.now() - t0 }) });

// 读回完整 marks + longtask，算最大间隔
const data = await Promise.race([
  page.evaluate(() => ({ marks: window.__marks, longtasks: window.__longtasks, frames: window.__frames })),
  new Promise((res) => setTimeout(() => res({ evalTimeout: true }), 6000)),
]);

if (data.marks) {
  const gaps = [];
  for (let i = 1; i < data.marks.length; i++) {
    const g = data.marks[i].t - data.marks[i - 1].t;
    if (g > 150) gaps.push({ from: data.marks[i - 1].t, to: data.marks[i].t, gapMs: g, framesDuring: data.marks[i].f - data.marks[i - 1].f });
  }
  log({ step: "GAPS>150ms", count: gaps.length, gaps: gaps.slice(0, 10) });
  const lt = (data.longtasks || []).sort((a, b) => b.d - a.d).slice(0, 10);
  log({ step: "LONG_TASKS", count: (data.longtasks || []).length, top: lt });
  log({ step: "totalFrames", frames: data.frames, marks: data.marks.length });
} else {
  log({ step: "readback", result: data });
}
