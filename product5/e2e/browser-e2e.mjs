/**
 * 浏览器级 E2E（Playwright + 真实 Chromium）
 *
 * 与 `e2e/local-e2e.mjs` 的分工：
 *   local-e2e.mjs  —— 真实构建产物 + 真实 HTTP + 真实 feed 夹具（**接口/SSR 级**，本机可跑）
 *   browser-e2e.mjs —— 真实浏览器 + **真实线上站点**（**交互/水合级**，需出网）
 *
 * 补的是 local-e2e 覆盖不到的部分：客户端水合是否成功、页签点击是否真的切换、
 * 折叠区能否展开、按钮是否可点。这些是「页面能打开」和「页面能用」的区别。
 *
 * 用法：
 *   node e2e/browser-e2e.mjs                       # 跑本地 shim（需先起 local-e2e 的 server）
 *   BASE=https://ai-hot-radar.ilikesaury.workers.dev node e2e/browser-e2e.mjs
 *   PROXY=http://127.0.0.1:7890 BASE=... node e2e/browser-e2e.mjs
 *
 * 注意：断言必须落到 **DOM 文本 / 网络响应**，不能只截图（截图不算证据）。
 */

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "https://ai-hot-radar.ilikesaury.workers.dev";
const PROXY = process.env.PROXY ?? "";
const TIMEOUT = Number.parseInt(process.env.E2E_TIMEOUT ?? "45000", 10);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const launchOptions = { headless: true };
if (PROXY) launchOptions.proxy = { server: PROXY };

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: "zh-CN",
});
const page = await context.newPage();

/* 收集页面错误与失败请求 —— 水合失败的典型信号 */
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
});
page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err).slice(0, 200)));
page.on("requestfailed", (req) => {
  failedRequests.push(`${req.method()} ${req.url().slice(0, 120)}`);
});

console.log(`[browser-e2e] 目标：${BASE}${PROXY ? `（代理 ${PROXY}）` : ""}\n`);

/* ── ① 首屏加载 ── */
const resp = await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
check("① 首页 HTTP 200", resp?.status() === 200, `status=${resp?.status()}`);

const title = await page.title();
check("② 标题正确", title.includes("AI 资讯雷达"), title);

/* ── ③ 水合成功（React 接管后按钮才可点）── */
await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => undefined);

// 点「刷新」后按钮文案会变成「抓取中…」再变回来 —— 说明 React 状态更新生效（= 已水合）
const refreshBtn = page.locator("button", { hasText: "刷新" }).first();
const hasRefresh = (await refreshBtn.count()) > 0;
check("③ 刷新按钮存在", hasRefresh);

if (hasRefresh) {
  const before = (await refreshBtn.textContent()) ?? "";
  await refreshBtn.click({ timeout: TIMEOUT });
  await page.waitForTimeout(600);
  const during = (await page.locator("button").first().textContent()) ?? "";
  const reacted = during !== before || during.includes("抓取中");
  check("④ 点击「刷新」触发 React 状态更新（= 客户端已水合）", reacted, `按钮文案：${before.trim()} → ${during.trim()}`);
  // 等抓取结束
  await page
    .waitForFunction(() => !document.body.innerText.includes("抓取中…"), { timeout: TIMEOUT })
    .catch(() => undefined);
}

/* ── ⑤ 四个页签可见 ── */
for (const tab of ["日报", "精选", "历史", "源健康"]) {
  const loc = page.locator("button", { hasText: tab }).first();
  check(`⑤ 页签「${tab}」存在`, (await loc.count()) > 0);
}

/* ── ⑥ 逐个点页签，验证内容真的切换 ── */
const bodyText = async () => (await page.locator("body").innerText()) ?? "";

const topTab = page.locator("button", { hasText: "精选" }).first();
await topTab.click({ timeout: TIMEOUT });
await page.waitForTimeout(500);
const topText = await bodyText();
check(
  "⑥ 点「精选」→ 显示精选区块（阈值说明 + 分数徽标）",
  topText.includes("精选") && (topText.includes("阈值") || topText.includes("维度")),
  topText.slice(0, 120).replace(/\s+/g, " "),
);
const scoreBadge = await page.locator("text=/^\\d{2}$/").count();
check("⑥b 精选里有分数徽标", scoreBadge > 0, `分数徽标数=${scoreBadge}`);

const historyTab = page.locator("button", { hasText: "历史" }).first();
await historyTab.click({ timeout: TIMEOUT });
await page.waitForTimeout(500);
const historyText = await bodyText();
check(
  "⑦ 点「历史」→ 显示历史条目（首见/最近见）",
  historyText.includes("首见") && historyText.includes("最近见"),
  historyText.slice(0, 120).replace(/\s+/g, " "),
);

const sourcesTab = page.locator("button", { hasText: "源健康" }).first();
await sourcesTab.click({ timeout: TIMEOUT });
await page.waitForTimeout(500);
const sourcesText = await bodyText();
check(
  "⑧ 点「源健康」→ 显示源状态与历史",
  sourcesText.includes("源健康") && (sourcesText.includes("正常") || sourcesText.includes("不可用")),
  sourcesText.slice(0, 140).replace(/\s+/g, " "),
);

/* 展开抓取历史（details 折叠） */
const details = page.locator("details summary").first();
if ((await details.count()) > 0) {
  await details.click({ timeout: TIMEOUT });
  await page.waitForTimeout(300);
  const expanded = await page.locator("details[open]").count();
  check("⑨ 「抓取历史」折叠区可展开", expanded > 0, `open 的 details=${expanded}`);
} else {
  check("⑨ 「抓取历史」折叠区可展开", false, "未找到 details/summary");
}

/* ── ⑩ 日报页：Markdown 渲染（不是 <pre> 原文）── */
const digestTab = page.locator("button", { hasText: "日报" }).first();
await digestTab.click({ timeout: TIMEOUT });
await page.waitForTimeout(700);
const digestText = await bodyText();
const hasSections = ["今日概览", "头条", "值得一看", "源健康"].some((h) => digestText.includes(h));
check("⑩ 点「日报」→ 渲染出日报板块", hasSections, digestText.slice(0, 140).replace(/\s+/g, " "));

const renderedHeadings = await page.locator("h1, h2").count();
check("⑩b 日报用 Markdown 标题渲染（非纯文本 <pre>）", renderedHeadings > 0, `h1/h2 数=${renderedHeadings}`);

const linkCount = await page.locator("a[href^='http']").count();
check("⑩c 日报内链接可点（http/https）", linkCount > 0, `外链数=${linkCount}`);

/* ── ⑪ 无 JS 错误 ── */
check(
  "⑪ 页面无 JS 运行时错误",
  pageErrors.length === 0,
  pageErrors.length ? pageErrors.slice(0, 2).join(" | ") : "无",
);
check(
  "⑫ 无失败的网络请求",
  failedRequests.length === 0,
  failedRequests.length ? failedRequests.slice(0, 3).join(" | ") : "无",
);

await page.screenshot({ path: "docs/e2e-evidence/browser-e2e.png", fullPage: true });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n浏览器 E2E：${results.length - failed.length}/${results.length} 通过`);
if (consoleErrors.length > 0) {
  console.log(`（console.error ${consoleErrors.length} 条，仅供参考：${consoleErrors.slice(0, 2).join(" | ")}）`);
}
if (failed.length > 0) {
  console.log("失败项：" + failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}