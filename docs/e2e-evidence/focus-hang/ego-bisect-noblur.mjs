// ego-browser: 注入 CSS 关闭 backdrop-filter / 降低合成压力后，点击 textarea 看是否还卡
const TOKEN = "REDACTED_TOKEN";
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";

const task = await taskSpace("focus-hang-noblur");
const page = task.page("p1");

function alive(label) {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 4000)),
  ]).then((ok) => { console.log(`  [alive:${label}] ${ok ? "响应正常" : "卡死 → TIMEOUT"}`); return ok; });
}

async function clickTextareaTry() {
  try { await page.click("#textInput", { label: "点击 textarea" }); }
  catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
}

console.log("=== 加载 ===");
await page.goto(URL_, { waitUntil: "commit", timeout: 45_000 });
await page.evaluate((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
try { await page.reload({ waitUntil: "commit", timeout: 30_000 }); } catch {}
await page.waitForSelector("#textInput", { timeout: 30_000 });
await page.waitForTimeout(1200);
await alive("baseline");

console.log("=== 对照 A：原样点击 textarea（不干预）===");
await clickTextareaTry();
await page.waitForTimeout(800);
await alive("after-textarea-click-A");

console.log("=== 注入 CSS：关闭 backdrop-filter + 关闭 sticky ===");
await page.evaluate(() => {
  const s = document.createElement("style");
  s.id = "__nobf";
  s.textContent = `
    header { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; position: static !important; }
    [class*="backdrop"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  `;
  document.head.appendChild(s);
});
await page.waitForTimeout(500);
console.log("  已注入");

console.log("=== 对照 B：关掉 blur 后再点 textarea ===");
await clickTextareaTry();
await page.waitForTimeout(800);
await alive("after-textarea-click-B");

await task.finish({ keep: [] });
