// 分治：禁用客户端 JS（拦 *.js），看 long task 是否消失
// 这能判定 30s long task 是「JS 执行」还是「浏览器原生/渲染管线」
const task = await taskSpace("bisect-js-disabled");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

async function installProbe() {
  return page.evaluate(() => {
    window.__longtasks = []; window.__frames = 0;
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__longtasks.push({ d: Math.round(e.duration), s: Math.round(e.startTime) });
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
    return { hasTA: !!document.querySelector("#textInput"), react: !!document.querySelector("[data-reactroot],#app") };
  });
}

async function run(label, blockJs) {
  if (blockJs) {
    // 用 CDP 网络拦截阻止所有 js 资源
    await page.cdp("Network.enable");
    await page.cdp("Network.setBlockedURLs", { urls: ["*.js"] });
  } else {
    await page.cdp("Network.enable").catch(() => {});
    await page.cdp("Network.setBlockedURLs", { urls: [] }).catch(() => {});
  }

  await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const inst = await installProbe();
  await page.waitForTimeout(1000);

  const hasTA = await page.evaluate(() => !!document.querySelector("#textInput"));
  if (!hasTA) { log({ label, skipped: "no textarea", ...inst }); return; }

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
    page.evaluate(() => ({ longtasks: window.__longtasks, frames: window.__frames })),
    new Promise((res) => setTimeout(() => res({ evalTimeout: true }), 5000)),
  ]);
  const maxLT = data.longtasks ? Math.max(0, ...data.longtasks.map((x) => x.d)) : null;
  log({ label, clickRes, recoveredMs: recovered, maxLongTaskMs: maxLT, longTaskCount: data.longtasks ? data.longtasks.length : null, ...inst });
}

await run("JS_BLOCKED", true);
await run("JS_NORMAL", false);
console.log("done");
