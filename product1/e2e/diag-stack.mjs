/**
 * 诊断 v3：用 CDP Debugger.pause 抓「点击后主线程卡死」时的 JS 调用栈。
 * 同时全量捕获 console（含 React 的 hydration 警告）。
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

const browser = await chromium.launch({
  channel: "msedge", headless: true, args: ["--disable-gpu"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const client = await page.context().newCDPSession(page);

await client.send("Runtime.enable");
await client.send("Debugger.enable");
await client.send("Log.enable");

client.on("Runtime.consoleAPICalled", (e) => {
  const text = e.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
  console.log(`[console.${e.type}] ${text.slice(0, 600)}`);
});
client.on("Runtime.exceptionThrown", (e) => {
  console.log(`[exception] ${e.exceptionDetails.text} :: ${(e.exceptionDetails.exception?.description ?? "").slice(0, 800)}`);
});
client.on("Log.entryAdded", (e) => console.log(`[log:${e.entry.level}] ${e.entry.text?.slice(0, 400)}`));

let paused = null;
client.on("Debugger.paused", (e) => {
  if (paused) return;
  paused = e;
});

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForSelector("#textInput", { timeout: 15_000 });
await page.waitForTimeout(2000);

console.log("=== 页面已加载，派发点击 ===");
const box = await page.locator("#textInput").boundingBox();
await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1 });
await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1 });
await new Promise((r) => setTimeout(r, 800));

console.log("=== 请求 Debugger.pause ===");
try {
  await client.send("Debugger.pause");
} catch (e) {
  console.log("pause 命令失败:", e.message.split("\n")[0]);
}
await new Promise((r) => setTimeout(r, 1500));

if (paused) {
  console.log("\n=== 暂停时调用栈 ===");
  console.log("reason:", paused.reason);
  const frames = paused.callFrames.slice(0, 25);
  frames.forEach((f, i) => {
    console.log(`  #${i} ${f.functionName || "(anonymous)"} @ ${f.url.split("/").pop()}:${f.location.lineNumber}:${f.location.columnNumber}`);
  });
  // 找用户代码帧
  const appFrame = paused.callFrames.find((f) => f.url.includes("pages-client"));
  if (appFrame) {
    console.log("\n=== app 帧局部变量 ===");
    for (const v of appFrame.scopeChain ?? []) {
      for (const p of v.object?.properties ?? []) {
        if (!p.value) continue;
        const val = p.value.value ?? p.value.description;
        console.log(`  ${v.type}.${p.name} = ${String(val).slice(0, 120)}`);
      }
    }
  }
  await client.send("Debugger.resume").catch(() => {});
} else {
  console.log("未捕获到 paused 事件（主线程可能不是在 JS 里死循环）");
}

await browser.close();
