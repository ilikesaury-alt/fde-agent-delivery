// ego-browser: 最终复测 —— 在 live 页面注入"修复后的真实 DOM"（header 改 static、去 blur）
// 模拟生产代码修复后的渲染，复测点击 textarea 是否还卡。
const TOKEN = "REDACTED_TOKEN";
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";

const task = await taskSpace("focus-hang-verify-fix");
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

console.log("=== 注入修复后的 header（position:static, 去 blur）===");
await page.evaluate(() => {
  const h = document.querySelector("header");
  if (h) {
    h.style.position = "static";
    h.style.backdropFilter = "none";
    h.style.webkitBackdropFilter = "none";
    h.style.zIndex = "auto";
  }
});
await page.waitForTimeout(400);
console.log("  已注入修复 DOM");

console.log("=== 复测：点击 textarea（修复后预期不卡）===");
try { await page.click("#textInput", { label: "点击 textarea（修复后）" }); }
catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
await page.waitForTimeout(800);
await alive("after-textarea-click-FIXED");

console.log("=== 再点一次 + 输入，确认稳定 ===");
try { await page.fill("#textInput", "修复后输入测试"); } catch (e) { console.log("  fill err:", e.message.split("\n")[0]); }
await page.waitForTimeout(400);
await alive("after-fill-FIXED");

await task.finish({ keep: [] });
