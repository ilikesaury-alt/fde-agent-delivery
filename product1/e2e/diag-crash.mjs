/**
 * 诊断 v5：判定是「主线程死循环」还是「渲染进程崩溃」。
 * 手段：监听 page 'crash' 事件 + 浏览器 stderr 日志 + 独立 CDP 会话探测。
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await import("playwright-core");

const URL_ = process.argv[2] || "http://localhost:8899/";
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(workspace, "docs", "e2e-evidence", "focus-hang");
mkdirSync(outDir, { recursive: true });
const TOKEN = process.env.MD_TOKEN || "REDACTED_TOKEN";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--disable-gpu",
    "--enable-logging=stderr",
    "--v=1",
    "--crash-dumps-dir=" + join(outDir, "crash"),
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("crash", () => console.log("!!! page CRASH 事件"));
page.on("close", () => console.log("!!! page CLOSE 事件"));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
page.on("dialog", async (d) => {
  console.log(`!!! dialog: type=${d.type()} message=${d.message()}`);
  await d.dismiss().catch(() => {});
});
page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text().slice(0, 300)}`));

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForSelector("#textInput", { timeout: 15_000 });
await page.waitForTimeout(1500);

console.log("=== 点击前 ===");
console.log("  crash? ", page.isClosed());

const box = await page.locator("#textInput").boundingBox();
console.log("  textarea box:", JSON.stringify(box));

await page.mouse.click(box.x + 40, box.y + 30).catch((e) => console.log("  click err:", e.message.split("\n")[0]));
console.log("  已点击");

for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 700));
  const st = await Promise.race([
    page.evaluate(() => ({ rs: document.readyState, ae: document.activeElement?.tagName })).then((v) => `alive ${JSON.stringify(v)}`).catch((e) => `eval-fail ${e.message.split("\n")[0]}`),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 4000)),
  ]);
  console.log(`  t+${(i + 1) * 0.7}s: ${st}`);
  if (st === "TIMEOUT") break;
}

// 独立 CDP 会话（绕开 Playwright 的连接层）
try {
  const c2 = await browser.newBrowserCDPSession();
  const targets = await c2.send("Target.getTargets");
  console.log("\n=== Targets ===");
  for (const t of targets.targetInfos) console.log(`  ${t.type} ${t.url.slice(0, 80)} attached=${t.attached}`);
} catch (e) {
  console.log("\nTarget 查询失败:", e.message.split("\n")[0]);
}

await browser.close().catch(() => {});
