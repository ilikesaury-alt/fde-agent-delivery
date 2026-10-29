/**
 * 诊断 v6：确认 DOM 实际结构 —— layout 是否在 #app 里又渲染了一套 <html>。
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

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log(`[console:${m.type()}] ${m.text().slice(0, 400)}`));

await page.addInitScript((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForSelector("#textInput", { timeout: 15_000 });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const app = document.getElementById("app");
  return {
    bodyChildren: [...document.body.children].map((e) => e.tagName + (e.id ? "#" + e.id : "")),
    appChildren: app ? [...app.children].map((e) => e.tagName + (e.id ? "#" + e.id : "")) : null,
    htmlChildren: [...document.documentElement.children].map((e) => e.tagName),
    headChildren: [...document.head.children].map((e) => e.tagName + (e.getAttribute("rel") ? `[rel=${e.getAttribute("rel")}]` : "")),
    titleInHead: document.title,
    appInnerStart: app ? app.innerHTML.slice(0, 220) : null,
    nestedHtmlInApp: app ? !!app.querySelector("html") : null,
    bodyFirstChildTag: document.body.firstElementChild?.tagName,
  };
});
console.log(JSON.stringify(info, null, 2));

await browser.close();
