// 用 CDP Profiler 抓 31s long task 期间的真实 JS 调用栈
const task = await taskSpace("profile-long-task");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);

// 装 longtask 探针
await page.evaluate(() => {
  window.__longtasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) });
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
});

await page.cdp("Profiler.enable");
await page.cdp("Profiler.setSamplingInterval", { interval: 1000 });
await page.cdp("Profiler.start");
log({ step: "profiler-started" });

let clickRes = "ok";
try { await page.click("#textInput", { timeout: 25000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }
log({ step: "click", result: clickRes });

// 等待恢复
const t0 = Date.now();
let recovered = null;
for (let i = 0; i < 60; i++) {
  const r = await Promise.race([
    page.evaluate(() => 1).catch(() => ({ err: 1 })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 800)),
  ]);
  if (!r.timeout && !r.err) { recovered = Date.now() - t0; break; }
  await page.waitForTimeout(200);
}
log({ step: "recovered", ms: recovered });

// 停 profiler 并取 profile
let profile = null;
try {
  const r = await page.cdp("Profiler.stop");
  profile = r && (r.profile || r);
  log({ step: "profiler-stopped", hasProfile: !!profile, nodes: profile && profile.nodes ? profile.nodes.length : null, samples: profile && profile.samples ? profile.samples.length : null });
} catch (e) {
  log({ step: "profiler-stop-failed", err: String(e.message).split("\n")[0] });
}

if (profile && profile.nodes) {
  // 统计每个节点的 self time（按 samples + timeDeltas）
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = deltas[i] || 0;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const rows = [...self.entries()].map(([id, us]) => {
    const n = byId.get(id);
    const cf = n && n.callFrame ? n.callFrame : {};
    return {
      fn: cf.functionName || "(anonymous)",
      url: (cf.url || "").split("/").pop(),
      line: cf.lineNumber,
      ms: Math.round(us / 1000),
    };
  }).sort((a, b) => b.ms - a.ms);

  log({ step: "TOP_SELF_TIME", top: rows.slice(0, 25) });

  // 也统计按 url 汇总
  const byUrl = new Map();
  for (const r of rows) {
    byUrl.set(r.url, (byUrl.get(r.url) || 0) + r.ms);
  }
  log({ step: "BY_URL", rows: [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) });
}
console.log("done");
