/**
 * 线上健康探针（用 ego-browser 的真实浏览器进程，绕开 Node/curl 的出网限制）
 * 目标：https://kb-ask.ilikesaury.workers.dev
 */

const task = await taskSpace("kb-ask live probe 2026-10-28");
const page = task.page("p1");

const BASE = "https://kb-ask.ilikesaury.workers.dev";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ── ① /api/health ────────────────────────────────────────────────────
try {
  await page.goto(`${BASE}/api/health`, { waitUntil: "load", timeout: 30000 });
  const body = await page.evaluate(() => document.body.innerText);
  check("线上 /api/health 可达", true, `响应: ${String(body).slice(0, 120)}`);
  check("health 返回 kb-ask 服务名", /kb-ask/.test(String(body)), `body=${String(body).slice(0, 80)}`);
} catch (e) {
  check("线上 /api/health 可达", false, `失败: ${e instanceof Error ? e.message : String(e)}`);
}

// ── ② 首页 ──────────────────────────────────────────────────────────
try {
  await page.goto(BASE, { waitUntil: "load", timeout: 30000 });
  const info = await page.evaluate(() => ({
    title: document.title,
    bodyLen: document.body.innerText.length,
    head: document.body.innerText.slice(0, 200),
    hasError1101: /Error 1101|Worker threw exception|1101/.test(document.body.innerText),
    hasApp: Boolean(
      document.querySelector('[data-testid="ask-btn"]') || document.querySelector('[data-testid="import-btn"]'),
    ),
  }));
  check("线上首页可达", true, `title=${info.title}`);
  check("首页不是 1101 错误页", !info.hasError1101, info.hasError1101 ? `正文含错误特征: ${info.head.slice(0, 80)}` : "无错误特征");
  check("首页渲染了应用（testid 存在）", info.hasApp, `bodyLen=${info.bodyLen}`);
} catch (e) {
  check("线上首页可达", false, `失败: ${e instanceof Error ? e.message : String(e)}`);
}

// ── ③ 令牌保护（无令牌应 401）────────────────────────────────────────
try {
  const r = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/documents`, { headers: { "content-type": "application/json" } });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 160) };
  }, BASE);
  check("线上 /api/documents 无令牌 → 401", r.status === 401, `status=${r.status} ${r.text.slice(0, 80)}`);
} catch (e) {
  check("线上 /api/documents 无令牌 → 401", false, `失败: ${e instanceof Error ? e.message : String(e)}`);
}

// ── ④ 页面实际截图留证 ──────────────────────────────────────────────
try {
  await page.goto(BASE, { waitUntil: "load", timeout: 30000 });
  await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/product3/docs/e2e-evidence/live-home.png" });
  check("线上首页截图", true);
} catch (e) {
  check("线上首页截图", false, `截图失败（不影响可达性结论）: ${e instanceof Error ? e.message : String(e)}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
