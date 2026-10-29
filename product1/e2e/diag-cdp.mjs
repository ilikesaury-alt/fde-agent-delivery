/**
 * 诊断 v2：用 CDP 直接观测（不依赖 Playwright 的 evaluate 通道）
 * 1) 打印所有 404 / 请求失败
 * 2) 点击后用 CDP Runtime.evaluate 检测活性
 * 3) 监听 Runtime.exceptionThrown
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await import("playwright-core");

const URL_ = process.argv[2] || "https://meeting-digest.ilikesaury.workers.dev/";
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(workspace, "docs", "e2e-evidence", "focus-hang");
mkdirSync(outDir, { recursive: true });
const TOKEN = process.env.MD_TOKEN || process.env.ACCESS_TOKEN || "";

const browser = await chromium.launch({
  channel: "msedge", headless: true, args: ["--disable-gpu"],
  proxy: { server: "http://127.0.0.1:7890" },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const client = await page.context().newCDPSession(page);

await client.send("Network.enable");
await client.send("Runtime.enable");
await client.send("Log.enable");
client.on("Network.responseReceived", (e) => {
  if (e.response.status >= 400) console.log(`[HTTP ${e.response.status}] ${e.response.url}`);
});
client.on("Network.loadingFailed", (e) => console.log(`[loadingFailed] ${e.errorText} ${e.blockedReason ?? ""}`));
client.on("Runtime.exceptionThrown", (e) => console.log(`[exception] ${e.exceptionDetails.text} ${e.exceptionDetails.exception?.description ?? ""}`));
client.on("Log.entryAdded", (e) => console.log(`[log:${e.entry.level}] ${e.entry.text} @${e.entry.url ?? ""}`));

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector("#textInput", { timeout: 20_000 });
await page.waitForTimeout(2500);

async function cdpAlive(label) {
  const r = await Promise.race([
    client.send("Runtime.evaluate", { expression: "1+1", returnByValue: true })
      .then((v) => ({ ok: true, v: v.result?.value }))
      .catch((e) => ({ ok: false, e: e.message.split("\n")[0] })),
    new Promise((r) => setTimeout(() => r({ ok: false, e: "TIMEOUT 主线程无响应" }), 5000)),
  ]);
  console.log(`  [cdp:${label}] ${r.ok ? "响应正常 " + r.v : "卡死 → " + r.e}`);
  return r.ok;
}

console.log("\n=== 基线 ===");
await cdpAlive("baseline");

// 检查 React 是否已 hydrate：看有没有 React 内部标记
const hydrated = await client.send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.getElementById('textInput');
    const keys = el ? Object.keys(el).filter(k => k.startsWith('__react')) : [];
    return JSON.stringify({ reactKeys: keys, hasApp: !!document.getElementById('app') });
  })()`,
  returnByValue: true,
});
console.log("  hydrate 状态:", hydrated.result?.value);

console.log("\n=== 点击 textarea ===");
const box = await page.locator("#textInput").boundingBox();
await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1 });
await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 40, y: box.y + 30, button: "left", clickCount: 1 });
console.log("  已派发点击");
await new Promise((r) => setTimeout(r, 300));
const alive = await cdpAlive("after-click");

if (!alive) {
  console.log("\n=== 卡死时尝试 CDP 其它通道 ===");
  const t0 = Date.now();
  const dom = await Promise.race([
    client.send("DOM.getDocument", { depth: 1 }).then(() => "DOM 通道正常").catch((e) => "DOM 失败: " + e.message.split("\n")[0]),
    new Promise((r) => setTimeout(() => r("DOM 超时"), 5000)),
  ]);
  console.log("  " + dom, `${Date.now() - t0}ms`);

  const perf = await Promise.race([
    client.send("Performance.getMetrics").then((m) => m.metrics.map((x) => `${x.name}=${x.value}`).join(" ")).catch((e) => "perf 失败"),
    new Promise((r) => setTimeout(() => r("perf 超时"), 5000)),
  ]);
  console.log("  metrics:", perf);
}

await browser.close();
