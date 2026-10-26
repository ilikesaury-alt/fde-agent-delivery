// 判定触发点：是「React 树内节点」还是「文档级任意可聚焦元素」
const task = await taskSpace("bisect-focus-target");
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

async function measure(label, action, maxWaitMs = 45000) {
  const t0 = Date.now();
  let actRes = "ok";
  try { await action(); } catch (e) { actRes = "THREW: " + String(e.message).split("\n")[0]; }
  // 等主线程恢复
  let recovered = null;
  for (let i = 0; i < maxWaitMs / 400; i++) {
    const r = await Promise.race([
      page.evaluate(() => window.__lt.slice()).catch(() => ({ err: 1 })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 600)),
    ]);
    if (!r.timeout && !r.err) { recovered = { ms: Date.now() - t0, longtasks: r }; break; }
    await page.waitForTimeout(200);
  }
  const max = recovered && Array.isArray(recovered.longtasks) ? Math.max(0, ...recovered.longtasks) : null;
  log({ label, actRes, recoveredMs: recovered ? recovered.ms : null, maxLongTaskMs: max, HANG: max !== null && max > 3000 });
  return max;
}

// T1 对照：聚焦 React 渲染的 textarea
await fresh();
await measure("T1_react_textarea_focus", () => page.evaluate(() => document.getElementById("textInput").focus()));

// T2：聚焦「运行时新插入到 body 的普通 textarea」（不在 React 树内）
await fresh();
await measure("T2_plain_textarea_outside_react", async () => {
  await page.evaluate(() => {
    const ta = document.createElement("textarea");
    ta.id = "plainTA";
    document.body.appendChild(ta);
  });
  await page.evaluate(() => document.getElementById("plainTA").focus());
});

// T3：聚焦普通 input（不在 React 树内）
await fresh();
await measure("T3_plain_input_outside_react", async () => {
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "plainIN";
    document.body.appendChild(i);
  });
  await page.evaluate(() => document.getElementById("plainIN").focus());
});

// T4：聚焦 React 渲染的按钮（可聚焦但非表单控件）
await fresh();
await measure("T4_react_button_focus", () => page.evaluate(() => {
  const b = document.querySelector("button");
  if (b) b.focus();
  return !!b;
}));

console.log("done");
