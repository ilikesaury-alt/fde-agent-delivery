/**
 * T02（文件上传）+ T06（一键复制）真浏览器 E2E。
 * 运行前提：e2e/server.mjs 已在 8899 端口运行。
 * 运行：
 *   node e2e/browser-test.mjs
 * 产物：docs/e2e-evidence/T02-T06-browser-evidence.json + 截图
 *
 * playwright-core 解析顺序：
 *   1. 环境变量 PLAYWRIGHT_CORE_PATH（显式指定 index.mjs 路径）
 *   2. 常规 node_modules 解析（npm i -D playwright-core）
 * 注意：不要硬编码某台机器上的绝对路径。
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const { chromium } = await (async () => {
  const explicit = process.env.PLAYWRIGHT_CORE_PATH;
  if (explicit) return import(`file://${explicit}`);
  try {
    return await import("playwright-core");
  } catch {
    throw new Error(
      "找不到 playwright-core。请执行 `npm i -D playwright-core`，" +
        "或设置 PLAYWRIGHT_CORE_PATH 指向其 index.mjs。",
    );
  }
})();

const root = fileURLToPath(new URL("..", import.meta.url)); // product1/
const workspace = fileURLToPath(new URL("../..", import.meta.url)); // fde-agent-delivery/
const evidenceDir = join(workspace, "docs", "e2e-evidence");
const BASE = "http://localhost:8899";
const REQUIRED_SECTIONS = [
  "## 会议主题",
  "## 时间与参会人",
  "## 核心结论",
  "## 待办事项",
  "## 遗留问题与风险",
  "## 一句话摘要",
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

/** 截图失败不阻塞断言（headless Edge 偶发 capture 协议错误） */
async function safeShot(page, name) {
  try {
    await page.screenshot({ path: join(evidenceDir, name), fullPage: true });
  } catch (e) {
    console.log(`WARN  截图失败 ${name}: ${e.message.split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
const context = await browser.newContext();
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await context.newPage();

try {
  // ── 打开页面 ──
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1");
  record("页面加载", (await page.textContent("h1")).includes("会议日报生成器"));

  // ── T02 负例：.pdf 被拒 ──
  const fakePdf = join(evidenceDir, "__fake.pdf");
  writeFileSync(fakePdf, Buffer.from("%PDF-1.4 fake"));
  await page.setInputFiles("#fileInput", fakePdf);
  await page.waitForFunction(
    () => document.querySelector(".hint")?.textContent?.includes("不支持的文件格式"),
    null,
    { timeout: 5000 },
  );
  record("T02 负例：.pdf 被拒", true, await page.textContent(".hint"));
  await safeShot(page, "T02-reject-pdf.png");

  // ── T02 负例：二进制伪装 .txt 被拒（NUL 检测）──
  const fakeTxt = join(evidenceDir, "__binary.txt");
  writeFileSync(fakeTxt, Buffer.from([0x68, 0x00, 0x69, 0x64, 0x64, 0x65, 0x6e]));
  await page.setInputFiles("#fileInput", fakeTxt);
  await page.waitForFunction(
    () => document.querySelector(".hint")?.textContent?.includes("二进制"),
    null,
    { timeout: 5000 },
  );
  record("T02 负例：二进制伪装 .txt 被拒", true, await page.textContent(".hint"));

  // ── T02 正例：上传 meeting-sample.txt → 文本进 textarea ──
  const samplePath = join(evidenceDir, "meeting-sample.txt");
  await page.setInputFiles("#fileInput", samplePath);
  await page.waitForFunction(
    () => document.querySelector(".hint")?.textContent?.includes("已载入"),
    null,
    { timeout: 5000 },
  );
  const fileContent = (await import("node:fs")).readFileSync(samplePath, "utf8");
  const taValue = await page.inputValue("#textInput");
  record("T02 正例：文件载入 textarea", taValue === fileContent, `${taValue.length} chars`);
  await safeShot(page, "T02-uploaded.png");

  // ── 生成日报（真 LLM，最长 95s）──
  await page.click(".btn-primary");
  await page.waitForFunction(
    () => document.querySelector(".hint")?.textContent?.includes("日报已生成"),
    null,
    { timeout: 95_000 },
  );
  const digest = await page.textContent(".result-body");
  const missing = REQUIRED_SECTIONS.filter((s) => !digest.includes(s));
  record("生成日报：6 板块齐全", missing.length === 0, missing.length ? `缺:${missing}` : `${digest.length} chars`);
  await safeShot(page, "T02-digest-generated.png");

  // ── T06：一键复制 → 按钮反馈 + 剪贴板内容一致 ──
  await page.click(".result .btn-ghost");
  await page.waitForFunction(
    () => document.querySelector(".result .btn-ghost")?.textContent?.includes("已复制"),
    null,
    { timeout: 5000 },
  );
  record("T06：按钮出现「已复制 ✓」反馈", true);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  // Windows 剪贴板会把 \n 归一化为 \r\n（CF_UNICODETEXT 惯例），比对前归一化
  const norm = (s) => s.replace(/\r\n/g, "\n");
  record("T06：剪贴板内容与日报一致", norm(clip) === norm(digest), `${clip.length} chars (CRLF) vs ${digest.length} chars`);
  await safeShot(page, "T06-copied.png");
} catch (e) {
  record("未预期异常", false, e.message);
  await page.screenshot({ path: join(evidenceDir, "T02-T06-error.png"), fullPage: true }).catch(() => {});
} finally {
  const passed = results.filter((r) => r.ok).length;
  writeFileSync(
    join(evidenceDir, "T02-T06-browser-evidence.json"),
    JSON.stringify(
      { ranAt: new Date().toISOString(), baseUrl: BASE, browser: "msedge-headless", passed, total: results.length, results },
      null,
      2,
    ),
  );
  console.log(`\n结果: pass=${passed}/${results.length}`);
  await browser.close();
  process.exit(passed === results.length ? 0 : 1);
}
