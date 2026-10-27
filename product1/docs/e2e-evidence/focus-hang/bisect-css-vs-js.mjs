// 分治实验：把真实页面拆成 CSS / JS 两层，定位 30s long task 来源
// A: 真实页面禁用全部 CSS（去 link + 去 style）
// B: 真实页面禁用客户端 JS（拦截 *.js 请求）
// C: 真实页面原样（对照）
const task = await taskSpace("bisect-css-vs-js");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

async function installProbe() {
  return page.evaluate(() => {
    window.__marks = []; window.__frames = 0; window.__longtasks = [];
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => {
      window.__marks.push({ t: Math.round(performance.now()), f: window.__frames });
      if (window.__marks.length > 800) window.__marks.shift();
    }, 100);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) });
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
    return { hasTA: !!document.querySelector("#textInput"), cssLinks: document.querySelectorAll('link[rel=stylesheet]').length };
  });
}

async function run(label, prep) {
  await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
  await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  if (prep) await prep();

  const inst = await installProbe();
  await page.waitForTimeout(1000);

  let clickRes = "ok";
  try { await page.click("#textInput", { timeout: 20000 }); } catch (e) { clickRes = "THREW: " + String(e.message).split("\n")[0]; }

  const t0 = Date.now();
  let recovered = null;
  for (let i = 0; i < 45; i++) {
    const r = await Promise.race([
      page.evaluate(() => ({ t: Math.round(performance.now()) })).catch(() => ({ err: 1 })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 800)),
    ]);
    if (!r.timeout && !r.err) { recovered = Date.now() - t0; break; }
    await page.waitForTimeout(200);
  }

  const data = await Promise.race([
    page.evaluate(() => ({ longtasks: window.__longtasks })),
    new Promise((res) => setTimeout(() => res({ evalTimeout: true }), 5000)),
  ]);
  const maxLT = data.longtasks ? Math.max(0, ...data.longtasks.map((x) => x.d)) : null;
  log({ label, clickRes, recoveredMs: recovered, maxLongTaskMs: maxLT, cssLinks: inst.cssLinks, hasTA: inst.hasTA });
}

// A: 去 CSS（页面加载后移除样式表 + 注入 style 关掉所有样式）
await run("A_no_css", async () => {
  await page.evaluate(() => {
    document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
    document.querySelectorAll("style").forEach((s) => s.remove());
    // 同时禁用 backdrop-filter / sticky 等合成层特性
    const st = document.createElement("style");
    st.textContent = "*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;animation:none!important;transition:none!important}";
    document.head.appendChild(st);
  });
  await page.waitForTimeout(500);
});

// B: 原样（对照）
await run("B_baseline", null);

console.log("done");
