/**
 * 产品④ 真实 UI 走查（ego-browser 真点击）：验证「人工确认闸」在浏览器里真的成立
 *
 * 覆盖：令牌输入 → 粘贴报告 → 解析 → 预览勾选 → 确认入库 → 时间线 → 趋势图 → 解读
 * 以及：未确认不入库（放弃预览后数据库无变化）
 *
 * 用法：ego-browser nodejs < e2e/live-ui.mjs
 */

const fs = await import("node:fs");

const BASE = "https://health-track.ilikesaury.workers.dev";
const secretsPath = "H:/Work/Projects/Personal/fde-agent-delivery/product4/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(secretsPath, "utf8")).ACCESS_TOKEN;

const task = await taskSpace("health-track ui walkthrough 2026-10-29");
const page = task.page("p1");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sel = (id) => `[data-testid="${id}"]`;

/** 轮询等待某个 testid 出现/消失（抽取可能 >15s，不能用固定 sleep） */
const waitTestId = async (id, { timeout = 120_000, gone = false } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((s) => Boolean(document.querySelector(s)), sel(id));
    if (gone ? !found : found) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const textOf = (id) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel(id));

/**
 * 等某个 testid 的文本包含指定内容。
 * ⚠️ 不要用「元素存在」判成功：提示条常已存在（上一条提示），会立刻返回 → 假绿（本次走查踩到）。
 */
const waitText = async (id, includes, timeout = 150_000) => {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await textOf(id);
    if (last.includes(includes)) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`   （等待超时：${id} 实际="${last.slice(0, 80)}"）`);
  return false;
};
const countOf = (id) => page.evaluate((s) => document.querySelectorAll(s).length, sel(id));

await page.goto(BASE, { waitUntil: "load", timeout: 30000 });

/* 0. 前置清库：让断言从确定状态开始（上次中断的残留会让「放弃预览后未增加」误判） */
const purged = await page.evaluate(async (a) => {
  const r = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  const d = await r.json();
  for (const rep of d.reports ?? []) {
    await fetch(a.base + "/api/reports?id=" + encodeURIComponent(rep.id), {
      method: "DELETE",
      headers: { authorization: "Bearer " + a.token },
    });
  }
  const after = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  return ((await after.json()).reports ?? []).length;
}, { base: BASE, token: TOKEN });
check("前置清库完成", purged === 0, `n=${purged}`);

/* 1. 令牌 */
check("页面标题渲染", (await textOf("app-title")).includes("体检指标追踪"));
await page.fill(sel("token-input"), TOKEN);
await new Promise((r) => setTimeout(r, 1500));
const errBanner = await page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel("error-banner"));
check("令牌填入后无 401 报错", !errBanner.includes("访问令牌"), errBanner.slice(0, 60));

/* 2. 粘贴报告文本 → 解析 */
const REPORT = `示例市第一医院 检验报告
采样日期：2025-03-14

甘油三酯 2.31 mmol/L 0.45-1.7
空腹血糖 5.31 mmol/L 3.9-6.1`;

await page.fill(sel("report-text"), REPORT);
check("报告文本已填入", (await page.evaluate((s) => document.querySelector(s).value.length, sel("report-text"))) > 50);

await page.click(sel("extract-btn"));
const previewShown = await waitTestId("preview-panel", { timeout: 150_000 });
check("解析后出现预览确认面板", previewShown);

const rows = await countOf("check-row-0");
check("预览表至少 1 行", rows >= 1, `check-row-0 存在=${rows}`);

const previewText = await textOf("preview-panel");
check("预览显示「未确认前不会写入数据库」", previewText.includes("未确认前不会写入数据库"));
check("预览含身份信息（检测日期）", previewText.includes("2025-03-14"), previewText.slice(0, 80));

/* 3. 放弃一次：确认「未确认不入库」 */
const countReports = () => page.evaluate(async (a) => {
  const r = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  const d = await r.json();
  return d.reports?.length ?? -1;
}, { base: BASE, token: TOKEN });
const before = await countReports();
await page.click(sel("discard-preview"));
await waitTestId("preview-panel", { gone: true, timeout: 10_000 });
const afterDiscard = await countReports();
check("放弃预览后数据库未增加", afterDiscard === before, `${before} → ${afterDiscard}`);

/* 4. 重新解析 → 确认入库 */
await page.click(sel("extract-btn"));
await waitTestId("preview-panel", { timeout: 150_000 });
await page.click(sel("confirm-save-btn"));
const savedBanner = await waitText("notice-banner", "已入库", 60_000);
check("入库后有成功提示（已入库）", savedBanner, (await textOf("notice-banner")).slice(0, 60));

const reportCount = await page.evaluate(async (a) => {
  const r = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  const d = await r.json();
  return { n: d.reports?.length ?? -1, first: d.reports?.[0] ?? null };
}, { base: BASE, token: TOKEN });
check("库里恰好 1 份报告", reportCount.n === 1, `n=${reportCount.n}`);
check("报告指标数 = 2", reportCount.first?.metricCount === 2, String(reportCount.first?.metricCount));

/* 5. 时间线可点开 */
await new Promise((r) => setTimeout(r, 800));
const timeline = await textOf("timeline-panel");
check("时间线显示检测日期", timeline.includes("2025-03-14"), timeline.slice(0, 60));
await page.click(`[data-testid="report-item-${reportCount.first.id}"]`);
const detailShown = await waitTestId("report-detail", { timeout: 15_000 });
check("点击报告打开明细", detailShown);
check("明细含异常状态标记", (await textOf("report-detail")).includes("偏高"));

/* 6. 趋势图（需要第二次数据）→ 先补一份手工数据 */
await page.click(sel("tab-manual"));
await waitTestId("manual-panel", { timeout: 10_000 });
/**
 * `<input type="date">` 不能用 page.fill：赋 DOM 值不会触发 React onChange，
 * 下一次 re-render 会把值打回 state（默认今天）—— 实测踩到。
 * 用 React 兼容写法：原生 value setter + 派发 input 事件。
 */
await page.evaluate((a) => {
  const el = document.querySelector(a.s);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, a.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, { s: sel("manual-date"), value: "2025-09-20" });
const dateState = await page.evaluate((s) => document.querySelector(s).value, sel("manual-date"));
check("日期已写入状态（2025-09-20）", dateState === "2025-09-20", dateState);
await page.fill(sel("manual-name-0"), "甘油三酯");
await page.fill(sel("manual-value-0"), "1.42");
await page.fill(sel("manual-unit-0"), "mmol/L");
await page.fill(sel("manual-ref-0"), "0.45-1.7");
await page.click(sel("manual-save-btn"));
const manualOk = await waitText("notice-banner", "已补录", 60_000);
check("手工补录成功（已补录）", manualOk, (await textOf("notice-banner")).slice(0, 60));
check("补录落在指定日期（2025-09-20）", (await textOf("notice-banner")).includes("2025-09-20"));

/* 7. 趋势 */
await page.click(sel("tab-trend"));
await waitTestId("trend-panel", { timeout: 20_000 });
await new Promise((r) => setTimeout(r, 2500));
const chart = await countOf("trend-chart");
check("趋势图渲染（SVG）", chart >= 1, `trend-chart=${chart}`);
const points = await page.evaluate(() => document.querySelectorAll('[data-testid="trend-chart"] circle').length);
check("趋势图有 2 个数据点", points === 2, `circles=${points}`);
const band = await countOf("trend-ref-band");
check("参考范围带渲染", band >= 1, `band=${band}`);

/* 8. 解读 */
await page.click(sel("tab-interpret"));
await waitTestId("interpret-panel", { timeout: 20_000 });
await new Promise((r) => setTimeout(r, 2500));
const interpretEnabled = await page.evaluate((s) => {
  const b = document.querySelector(s);
  return b ? !b.disabled : false;
}, sel("interpret-btn"));
check("解读按钮默认可用（已默认选中首个指标）", interpretEnabled);
await page.click(sel("interpret-btn"));
const interpretShown = await waitTestId("interpret-result", { timeout: 150_000 });
check("解读结果渲染", interpretShown);
if (interpretShown) {
  const t = await textOf("interpret-result");
  check("解读带免责声明", t.includes("不构成医疗诊断"));
  check("解读带可核验引用", t.includes("依据的数据"), t.slice(0, 60));
}

/* 9. 截图：本环境不支持（诚实标注，不算通过）
 *   实测 `Page.captureScreenshot` 对 example.com 也超时 → 是 ego-lite 窗口不产帧的**环境限制**，
 *   不是本产品的问题（perf-hang-triage 的分层判据：先排除被观测对象）。
 *   因此 UI 验证以 DOM 级断言为准，不提供截图证据。 */
console.log("   （跳过截图：本环境 Page.captureScreenshot 对外站也超时，属环境限制）");

/* 10. 清理（按 id 精确删除，不用标题匹配） */
const cleanup = await page.evaluate(async (a) => {
  const r = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  const d = await r.json();
  for (const rep of d.reports ?? []) {
    await fetch(a.base + "/api/reports?id=" + encodeURIComponent(rep.id), {
      method: "DELETE",
      headers: { authorization: "Bearer " + a.token },
    });
  }
  const after = await fetch(a.base + "/api/reports", { headers: { authorization: "Bearer " + a.token } });
  const ad = await after.json();
  return (ad.reports ?? []).length;
}, { base: BASE, token: TOKEN });
check("清理后报告数为 0", cleanup === 0, `n=${cleanup}`);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`UI 走查：通过 ${passed} / ${results.length}`);
if (passed < results.length) {
  console.log("\n失败项:");
  for (const f of results.filter((r) => !r.ok)) console.log(`- ${f.name} — ${f.detail ?? ""}`);
}
await task.close?.();