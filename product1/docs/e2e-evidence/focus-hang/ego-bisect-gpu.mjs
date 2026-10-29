// ego-browser: 收集 CSS 合成层证据（header backdrop-filter / sticky）+ 复测点击
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";

const task = await taskSpace("focus-hang-gpu-bisect");
const page = task.page("p1");

async function alive(label) {
  const r = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => ({ ok: true })).catch((e) => ({ ok: false, e: e.message })),
    new Promise((res) => setTimeout(() => res({ ok: false, e: "TIMEOUT(主线程无响应/卡死)" }), 4000)),
  ]);
  console.log(`  [alive:${label}] ${r.ok ? "响应正常" : "卡死 → " + r.e}`);
  return r.ok;
}

console.log("=== 加载 ===");
await page.goto(URL_, { waitUntil: "commit", timeout: 45_000 });
await page.evaluate((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
try { await page.reload({ waitUntil: "commit", timeout: 30_000 }); }
catch (e) { console.log("  reload 超时(已忽略):", e.message.split("\n")[0]); }
await page.waitForSelector("#textInput", { timeout: 30_000 });
await page.waitForTimeout(1200);
await alive("baseline");

console.log("=== 收集 CSS 合成层证据 ===");
const cssInfo = await page.evaluate(() => {
  const hdr = document.querySelector("header");
  const cs = hdr ? getComputedStyle(hdr) : null;
  const ta = document.querySelector("#textInput");
  return {
    headerPosition: cs ? cs.position : "n/a",
    headerBackdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || "none") : "n/a",
    headerZIndex: cs ? cs.zIndex : "n/a",
    textareaExists: !!ta,
    hasBackdropClass: document.querySelectorAll('[class*="backdrop"]').length,
    mainOverflow: (() => { const m = document.querySelector("main"); return m ? getComputedStyle(m).overflow : "n/a"; })(),
  };
});
console.log("  CSS 证据:", JSON.stringify(cssInfo));

console.log("=== 点击 textarea（复测）===");
try { await page.click("#textInput", { label: "点击 textarea" }); }
catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
await page.waitForTimeout(800);
await alive("after-textarea-click");

await task.finish({ keep: [] });
