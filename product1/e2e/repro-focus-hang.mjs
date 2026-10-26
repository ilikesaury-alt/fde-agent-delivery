/**
 * 复现「点击输入框聚焦即卡死」。
 *
 * 用法：
 *   node e2e/repro-focus-hang.mjs [url]
 * 默认 url = https://meeting-digital.ilikesaury.workers.dev（线上）
 * 也可指向本地 e2e shim（http://localhost:8899）。
 *
 * 判定「卡死」的方式：
 *   在主线程里跑 requestAnimationFrame 计数 + setInterval 心跳，
 *   点击聚焦后若 2s 内心跳次数接近 0，即主线程被同步任务占死。
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const { chromium } = await import("playwright-core");

const URL_ = process.argv[2] || "https://meeting-digest.ilikesaury.workers.dev/";
const root = fileURLToPath(new URL("..", import.meta.url));
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(workspace, "docs", "e2e-evidence", "focus-hang");
mkdirSync(outDir, { recursive: true });

const TOKEN = "REDACTED_TOKEN";

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--disable-gpu"],
  proxy: { server: "http://127.0.0.1:7890" },
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

try {
  await page.addInitScript((t) => {
    window.localStorage.setItem("md_token", t);
  }, TOKEN);

  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
  rec("页面打开", true, `${Date.now() - t0}ms`);
  await page.waitForSelector("#textInput", { timeout: 20_000 });
  await page.waitForTimeout(1500); // 等水合
  await page.screenshot({ path: join(outDir, "01-loaded.png") });

  // 心跳探针：rAF + setInterval
  await page.evaluate(() => {
    window.__hb = { raf: 0, tick: 0 };
    const loop = () => {
      window.__hb.raf++;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    setInterval(() => {
      window.__hb.tick++;
    }, 16);
  });

  const before = await page.evaluate(() => ({ ...window.__hb }));
  await page.waitForTimeout(1000);
  const idle = await page.evaluate(() => ({ ...window.__hb }));
  rec("空闲时主线程正常", idle.tick - before.tick > 20, `tick+${idle.tick - before.tick}`);

  // ── 点击 textarea（聚焦）──
  const box = await page.locator("#textInput").boundingBox();
  console.log("textarea box:", JSON.stringify(box));

  const clickStart = Date.now();
  let clickErr = null;
  const clickPromise = page.mouse.click(box.x + 40, box.y + 30).catch((e) => {
    clickErr = e;
  });
  const clickDone = await Promise.race([
    clickPromise.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 6000)),
  ]);
  rec("点击 textarea 返回", clickDone, `${Date.now() - clickStart}ms${clickErr ? ` err=${clickErr.message}` : ""}`);

  // 聚焦后心跳是否还在跑（卡死检测）
  const afterClick = await page.evaluate(() => ({ ...window.__hb })).catch((e) => ({ err: e.message }));
  await page.waitForTimeout(1200);
  const afterWait = await page.evaluate(() => ({ ...window.__hb })).catch((e) => ({ err: e.message }));
  const ticks = afterWait.tick - afterClick.tick;
  rec("聚焦后主线程仍响应", ticks > 20, `tick+${ticks} ${JSON.stringify(afterWait)}`);

  // 尝试输入
  let typed = false;
  try {
    await page.keyboard.type("测试输入", { delay: 30 });
    typed = (await page.inputValue("#textInput")) !== "";
  } catch (e) {
    console.log("type error:", e.message);
  }
  rec("聚焦后可输入", typed, typed ? await page.inputValue("#textInput") : "未输入成功");

  const focused = await page.evaluate(() => document.activeElement?.id ?? "(none)");
  rec("activeElement 为 textInput", focused === "textInput", focused);

  await page.screenshot({ path: join(outDir, "02-after-click.png") });
} catch (e) {
  rec("未预期异常", false, e.message);
  await page.screenshot({ path: join(outDir, "99-error.png") }).catch(() => {});
} finally {
  writeFileSync(
    join(outDir, "repro.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), url: URL_, results }, null, 2),
  );
  await browser.close();
}
