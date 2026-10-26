/**
 * 诊断：区分「点击 textarea 卡死」vs「点击任意元素都卡死」。
 * 用法：node e2e/diag-focus.mjs [url]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await import("playwright-core");

const URL_ = process.argv[2] || "https://meeting-digest.ilikesaury.workers.dev/";
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(workspace, "docs", "e2e-evidence", "focus-hang");
mkdirSync(outDir, { recursive: true });

const TOKEN = process.env.MD_TOKEN || "REDACTED_TOKEN";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--disable-gpu"],
  proxy: { server: "http://127.0.0.1:7890" },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector("#textInput", { timeout: 20_000 });
await page.waitForTimeout(2000);

async function alive(label) {
  const r = await Promise.race([
    page.evaluate(() => ({ ok: true, t: performance.now() })).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e: e.message })),
    new Promise((r) => setTimeout(() => r({ ok: false, e: "TIMEOUT(主线程无响应)" }), 4000)),
  ]);
  console.log(`  [alive:${label}] ${r.ok ? "响应正常" : "卡死 → " + r.e}`);
  return r.ok;
}

console.log("\n=== 基线（未点击任何东西）===");
await alive("baseline");

console.log("\n=== 实验 1：点击页面标题文字（非交互元素）===");
await page.getByText("会议日报", { exact: true }).first().click({ timeout: 5000 }).catch((e) => console.log("  click err", e.message.split("\n")[0]));
await page.waitForTimeout(500);
await alive("after-title-click");

console.log("\n=== 实验 2：点击「用示例文本试试」按钮 ===");
await page.getByRole("button", { name: "用示例文本试试" }).click({ timeout: 5000 }).catch((e) => console.log("  click err", e.message.split("\n")[0]));
await page.waitForTimeout(500);
await alive("after-sample-click");

console.log("\n=== 实验 3：点击 textarea ===");
const box = await page.locator("#textInput").boundingBox();
await page.mouse.click(box.x + 40, box.y + 30).catch((e) => console.log("  click err", e.message.split("\n")[0]));
await page.waitForTimeout(500);
const alive3 = await alive("after-textarea-click");

if (!alive3) {
  console.log("\n=== 确认卡死：尝试截图（超时则连渲染都卡） ===");
  const shot = await Promise.race([
    page.screenshot({ path: join(outDir, "diag-hung.png") }).then(() => "截图成功").catch((e) => "截图失败: " + e.message.split("\n")[0]),
    new Promise((r) => setTimeout(() => r("截图超时"), 8000)),
  ]);
  console.log("  " + shot);
}

await browser.close();
