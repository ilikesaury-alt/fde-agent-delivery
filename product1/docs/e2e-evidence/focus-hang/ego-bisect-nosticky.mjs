// ego-browser: 只关 sticky（保留 backdrop-filter），看 hang 是否消失
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";

const task = await taskSpace("focus-hang-nosticky");
const page = task.page("p1");

function alive(label) {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 4000)),
  ]).then((ok) => { console.log(`  [alive:${label}] ${ok ? "响应正常" : "卡死 → TIMEOUT"}`); return ok; });
}

console.log("=== 加载 ===");
await page.goto(URL_, { waitUntil: "commit", timeout: 45_000 });
await page.evaluate((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
try { await page.reload({ waitUntil: "commit", timeout: 30_000 }); } catch {}
await page.waitForSelector("#textInput", { timeout: 30_000 });
await page.waitForTimeout(1200);
await alive("baseline");

console.log("=== 只关 sticky（保留 backdrop-filter）===");
await page.evaluate(() => {
  const s = document.createElement("style");
  s.id = "__nosticky";
  s.textContent = `header { position: static !important; }`;
  document.head.appendChild(s);
});
await page.waitForTimeout(400);
console.log("  已注入(只关 sticky)");

console.log("=== 点击 textarea ===");
try { await page.click("#textInput", { label: "点击 textarea" }); }
catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
await page.waitForTimeout(800);
await alive("after-textarea-click-nosticky");

await task.finish({ keep: [] });
