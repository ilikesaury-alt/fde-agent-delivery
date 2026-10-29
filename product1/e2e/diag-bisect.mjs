/**
 * 诊断 v4：二分 —— 禁用 JS 后点击是否仍卡死？
 * - 若仍卡 → 渲染/CSS 层问题
 * - 若不卡 → JS 层（React / Void runtime）问题
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await import("playwright-core");

const URL_ = process.argv[2] || "http://localhost:8899/";
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(workspace, "docs", "e2e-evidence", "focus-hang");
mkdirSync(outDir, { recursive: true });

const TOKEN = process.env.MD_TOKEN || process.env.ACCESS_TOKEN || "";

async function probe(label, opts) {
  const browser = await chromium.launch({
    channel: "msedge", headless: true, args: ["--disable-gpu"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`  [console:${m.type()}] ${m.text().slice(0, 300)}`); });
  try {
    await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
    await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#textInput", { timeout: 15_000 });
    await page.waitForTimeout(1500);
    const box = await page.locator("#textInput").boundingBox();
    await page.mouse.click(box.x + 40, box.y + 30).catch((e) => console.log("  click err:", e.message.split("\n")[0]));
    await page.waitForTimeout(500);
    const r = await Promise.race([
      page.evaluate(() => 1 + 1).then(() => "响应正常").catch((e) => "evaluate 失败: " + e.message.split("\n")[0]),
      new Promise((res) => setTimeout(() => res("TIMEOUT → 卡死"), 5000)),
    ]);
    console.log(`[${label}] 点击后 → ${r}`);
  } catch (e) {
    console.log(`[${label}] 异常: ${e.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
}

console.log("=== A: JS 启用（基线）===");
await probe("JS on", {});

console.log("\n=== B: JS 禁用 ===");
await probe("JS off", { javaScriptEnabled: false });
