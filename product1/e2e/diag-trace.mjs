/**
 * 诊断：抓「点击后主线程挂死」时的调用栈。
 * 手段：CDP Tracing（浏览器侧采集，不依赖主线程 JS 执行），导出 trace 分析。
 * 用法：node e2e/diag-trace.mjs [url]
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

const client = await page.context().newCDPSession(page);
const chunks = [];
client.on("Tracing.dataCollected", (e) => chunks.push(...e.value));
client.on("Tracing.tracingComplete", () => {
  writeFileSync(join(outDir, "trace.json"), JSON.stringify(chunks));
  console.log(`trace 事件数: ${chunks.length}`);
});

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector("#textInput", { timeout: 20_000 });
await page.waitForTimeout(2000);

await client.send("Tracing.start", {
  traceConfig: {
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "v8",
      "v8.execute",
      "blink.user_timing",
    ],
    recordMode: "recordAsMuchAsPossible",
  },
  transferMode: "ReportEvents",
});

// 触发点击（不用 page.click，避免它等待主线程）
const box = await page.locator("#textInput").boundingBox();
await client.send("Input.dispatchMouseEvent", {
  type: "mousePressed", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1,
});
await client.send("Input.dispatchMouseEvent", {
  type: "mouseReleased", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1,
});
console.log("已派发点击");

await new Promise((r) => setTimeout(r, 4000));
await client.send("Tracing.end");
await new Promise((r) => setTimeout(r, 3000));
await browser.close();
