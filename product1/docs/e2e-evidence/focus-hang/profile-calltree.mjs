// 终极实验：直接测 fm() 的调用次数与单次代价
// 思路：fm 是 React 内部函数，不可直接 hook。但它的特征行为是遍历 previousSibling。
// 用 CDP Profiler 抓「完整调用树」（不只是 self time），看 fm 被谁、调了多少次
const task = await taskSpace("profile-calltree");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

await page.cdp("Profiler.enable");
await page.cdp("Profiler.setSamplingInterval", { interval: 200 });
await page.cdp("Profiler.start");

// 用 DOM focus 触发（比 CDP click 快，且已证明同样触发）
try { await page.evaluate(() => document.getElementById("textInput").focus()); } catch {}

const t0 = Date.now();
for (let i = 0; i < 80; i++) {
  const r = await Promise.race([
    page.evaluate(() => 1).catch(() => ({ err: 1 })),
    new Promise((res) => setTimeout(() => res({ timeout: true }), 600)),
  ]);
  if (!r.timeout && !r.err) break;
  await page.waitForTimeout(200);
}
log({ recoveredMs: Date.now() - t0 });

const r = await page.cdp("Profiler.stop");
const profile = r.profile || r;
const nodes = profile.nodes || [];
const byId = new Map(nodes.map((n) => [n.id, n]));
const parentOf = new Map();
for (const n of nodes) for (const c of n.children || []) parentOf.set(c, n.id);

// 累计每个节点的 total time（含子节点）
const total = new Map();
const samples = profile.samples || [];
const deltas = profile.timeDeltas || [];
for (let i = 0; i < samples.length; i++) {
  let id = samples[i];
  const dt = deltas[i] || 0;
  const seen = new Set();
  while (id !== undefined) {
    if (!seen.has(id)) { total.set(id, (total.get(id) || 0) + dt); seen.add(id); }
    id = parentOf.get(id);
  }
}

function label(id) {
  const n = byId.get(id);
  if (!n || !n.callFrame) return { fn: "?", url: "" };
  return { fn: n.callFrame.functionName || "(anon)", url: (n.callFrame.url || "").split("/").pop(), line: n.callFrame.lineNumber };
}

// 找 fm 的节点
const fmNodes = nodes.filter((n) => n.callFrame && n.callFrame.functionName === "fm");
log({ fmNodeCount: fmNodes.length, fmTotalMs: fmNodes.map((n) => Math.round((total.get(n.id) || 0) / 1000)) });

// 打印 fm 的完整祖先调用链（带 total ms）
if (fmNodes.length) {
  const chains = fmNodes.map((n) => {
    const chain = [];
    let id = n.id;
    let guard = 0;
    while (id !== undefined && guard++ < 40) {
      const l = label(id);
      chain.push(`${l.fn}(${Math.round((total.get(id) || 0) / 1000)}ms)`);
      id = parentOf.get(id);
    }
    return chain;
  });
  log({ fmCallChains: chains });
}

// 打印 total time 最高的节点
const top = [...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, us]) => ({ ...label(id), ms: Math.round(us / 1000) }));
log({ topTotal: top });

// 统计每个函数的调用次数（samples 命中数）
const hit = new Map();
for (const s of samples) hit.set(s, (hit.get(s) || 0) + 1);
const topHit = [...hit.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, c]) => ({ ...label(id), sampleHits: c }));
log({ topSampleHits: topHit });

console.log("done");
