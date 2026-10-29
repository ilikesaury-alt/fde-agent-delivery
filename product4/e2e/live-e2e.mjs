/**
 * 产品④ 线上接口级 E2E（经 ego-browser 的真实浏览器进程发起请求）
 *
 * 为什么用浏览器而不是 Node/curl：本沙箱 Node 出网被限制（实测连 workers.dev 超时），
 * 而 ego-browser 是独立 Chromium 进程，网络栈不受同一限制。
 *
 * 覆盖验收标准 A1/A3/A4/A5/A6/A7（A2 OCR 需真实扫描件图片，另跑 —— 见 CONTEXT 证据段）。
 *
 * 令牌从 .secrets.json 读入，只在内存使用，不打印、不写入任何入库文件。
 * 用法：ego-browser nodejs < e2e/live-e2e.mjs
 */

const fs = await import("node:fs");

const BASE = "https://health-track.ilikesaury.workers.dev";
// ⚠️ ego-browser 以 stdin 执行脚本：process.cwd() 不是仓库目录，相对路径不可用
const secretsPath = "H:/Work/Projects/Personal/fde-agent-delivery/product4/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(secretsPath, "utf8")).ACCESS_TOKEN;

const task = await taskSpace("health-track live e2e 2026-10-29");
const page = task.page("p1");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(BASE, { waitUntil: "load", timeout: 30000 });

const call = (path, init = {}) =>
  page.evaluate(
    async (args) => {
      const res = await fetch(args.base + args.path, {
        ...args.init,
        headers: {
          "content-type": "application/json",
          ...(args.token ? { authorization: "Bearer " + args.token } : {}),
        },
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 300) };
      }
      return { status: res.status, body };
    },
    { base: BASE, path, init, token: TOKEN },
  );

/**
 * 长请求（抽取可能 >15s）：page.evaluate 固定 15s 上限，
 * 做法同③：页面内发起 fetch 挂到 window，再用短 evaluate 轮询取回。
 */
let seq = 0;
const callLong = async (path, init = {}) => {
  const key = "__htLong" + ++seq;
  await page.evaluate(
    (a) => {
      window[a.key] = { done: false, status: 0, text: null, error: null };
      fetch(a.base + a.path, {
        ...a.init,
        headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
      })
        .then(async (r) => {
          const t = await r.text();
          window[a.key] = { done: true, status: r.status, text: t, error: null };
        })
        .catch((e) => {
          window[a.key] = { done: true, status: 0, text: null, error: String(e) };
        });
    },
    { key, base: BASE, token: TOKEN, path, init },
  );

  const deadline = Date.now() + 150_000;
  let payload = null;
  while (Date.now() < deadline) {
    payload = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (payload?.done) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!payload?.done) return { status: 0, body: { error: "超时（150s）" } };
  let body = null;
  try {
    body = JSON.parse(String(payload.text));
  } catch {
    body = { raw: String(payload.text).slice(0, 300) };
  }
  return { status: payload.status, body };
};

/* ─────────────────── A7 健康 + 令牌契约 ─────────────────── */

const health = await call("/api/health");
check("A7 /api/health 存活", health.status === 200 && health.body?.service === "health-track", `status=${health.status}`);

const noAuth = await page.evaluate(async (base) => {
  const r = await fetch(base + "/api/reports");
  return r.status;
}, BASE);
check("A7 未带令牌 → 401", noAuth === 401, `status=${noAuth}`);

const pageHtml = await page.evaluate(() => document.documentElement.outerHTML.length);
check("A8 首页渲染（SSR 资产在）", pageHtml > 800, `html=${pageHtml}`);

/* ─────────────────── A1 抽取（真网关）─────────────────── */

const REPORT_2025_03 = `示例市第一医院 检验报告
采样日期：2025-03-14

项目名称          结果      单位        参考范围
甘油三酯          2.31 ↑    mmol/L      0.45-1.7
空腹血糖          5.31      mmol/L      3.9-6.1
白细胞计数        6.2       10^9/L      3.5-9.5`;

const ex1 = await callLong("/api/extract", {
  method: "POST",
  body: JSON.stringify({ text: REPORT_2025_03, sourceType: "pdf", fileName: "2025-03.pdf" }),
});
check("A1 抽取返回 200", ex1.status === 200, `status=${ex1.status} ${ex1.body?.error ?? ""}`);
check("A1 检测日期识别", ex1.body?.checkDate === "2025-03-14", String(ex1.body?.checkDate));
check("A1 指标数 = 3", Array.isArray(ex1.body?.metrics) && ex1.body.metrics.length === 3, `n=${ex1.body?.metrics?.length}`);

const tg = (ex1.body?.metrics ?? []).find((m) => m.rawName === "甘油三酯");
check("A1 服务端算数值（2.31）", tg?.valueNum === 2.31, String(tg?.valueNum));
check("A5 偏高判定（>1.7 → high）", tg?.status === "high", String(tg?.status));
check("A1 原文片段可复核", Boolean(tg?.sourceQuote), String(tg?.sourceQuote));
const wbc = (ex1.body?.metrics ?? []).find((m) => m.rawName === "白细胞计数");
check("A1 标准名归一", wbc?.standardName === "白细胞计数", String(wbc?.standardName));

/* ─────────────────── 确认入库 ─────────────────── */

const save1 = await call("/api/reports", {
  method: "POST",
  body: JSON.stringify({
    checkDate: ex1.body.checkDate,
    hospital: ex1.body.hospital,
    rawText: REPORT_2025_03,
    sourceType: "pdf",
    fileName: "2025-03.pdf",
    metrics: (ex1.body.metrics ?? []).map((m) => ({
      rawName: m.rawName,
      valueText: m.valueText,
      unit: m.unit,
      refText: m.refText,
      sourceQuote: m.sourceQuote,
    })),
  }),
});
check("入库 201", save1.status === 201, `status=${save1.status} ${save1.body?.error ?? ""}`);
const reportId1 = save1.body?.report?.id;

/* ─────────────────── 第二份报告（趋势）─────────────────── */

const REPORT_2025_09 = `示例市第一医院 检验报告
采样日期：2025-09-20

甘油三酯 1.42 mmol/L 0.45-1.7
空腹血糖 5.6 mmol/L 3.9-6.1`;

const ex2 = await callLong("/api/extract", {
  method: "POST",
  body: JSON.stringify({ text: REPORT_2025_09, sourceType: "pdf" }),
});
check("第二份抽取", ex2.status === 200 && ex2.body?.metrics?.length === 2, `n=${ex2.body?.metrics?.length}`);

const save2 = await call("/api/reports", {
  method: "POST",
  body: JSON.stringify({
    checkDate: ex2.body.checkDate,
    hospital: ex2.body.hospital,
    rawText: REPORT_2025_09,
    sourceType: "pdf",
    metrics: (ex2.body.metrics ?? []).map((m) => ({
      rawName: m.rawName,
      valueText: m.valueText,
      unit: m.unit,
      refText: m.refText,
      sourceQuote: m.sourceQuote,
    })),
  }),
});
check("第二份入库", save2.status === 201, `status=${save2.status}`);
const reportId2 = save2.body?.report?.id;

/* ─────────────────── A3 手工补录 ─────────────────── */

const manual = await call("/api/metrics", {
  method: "POST",
  body: JSON.stringify({
    checkDate: "2025-12-01",
    metrics: [{ rawName: "尿酸", valueText: "430", unit: "μmol/L", refText: "208-428" }],
  }),
});
check("A3 手工补录 201", manual.status === 201, `status=${manual.status} ${manual.body?.error ?? ""}`);
check("A3 手工指标判偏高", manual.body?.metrics?.[0]?.status === "high", String(manual.body?.metrics?.[0]?.status));
const manualReportId = manual.body?.report?.id;

/* ─────────────────── A4 趋势 ─────────────────── */

const trends = await call("/api/trends");
check("A4 趋势接口 200", trends.status === 200, `status=${trends.status}`);
const tgSeries = (trends.body?.series ?? []).find((s) => s.standardName === "甘油三酯");
check("A4 甘油三酯成序列", Boolean(tgSeries), tgSeries?.standardName ?? "无");
check("A4 两个时间点（≥2 次可画线）", tgSeries?.points?.length === 2, `n=${tgSeries?.points?.length}`);
check(
  "A4 点按日期升序",
  tgSeries?.points?.[0]?.checkDate === "2025-03-14" && tgSeries?.points?.[1]?.checkDate === "2025-09-20",
  JSON.stringify(tgSeries?.points?.map((p) => p.checkDate)),
);

/* ─────────────────── 报告列表/详情 ─────────────────── */

const list = await call("/api/reports");
check("列表含 3 份报告", (list.body?.reports ?? []).length >= 3, `n=${list.body?.reports?.length}`);
check("列表不含原文全文", list.body?.reports?.[0] && !("rawText" in list.body.reports[0]));

const detail = await call("/api/reports?id=" + encodeURIComponent(reportId1));
check("详情含原文", typeof detail.body?.report?.rawText === "string" && detail.body.report.rawText.includes("甘油三酯"), "rawText ok");
check("详情含 3 项指标", (detail.body?.metrics ?? []).length === 3, `n=${detail.body?.metrics?.length}`);

/* ─────────────────── A6 解读（红线 + 引用）─────────────────── */

const interp = await callLong("/api/interpret", {
  method: "POST",
  body: JSON.stringify({ standardName: "甘油三酯" }),
});
check("A6 解读 200", interp.status === 200, `status=${interp.status} ${interp.body?.error ?? ""}`);
check("A6 未拒答（有数据）", interp.body?.refused === false, String(interp.body?.refused));
check("A6 趋势模式（2 次数据）", interp.body?.mode === "trend", String(interp.body?.mode));
check("A6 引用可核验（2 条历史）", interp.body?.citations?.length === 2, `n=${interp.body?.citations?.length}`);
check(
  "A6 引用值与入库一致",
  interp.body?.citations?.[0]?.valueText === "2.31" && interp.body?.citations?.[1]?.valueText === "1.42",
  JSON.stringify(interp.body?.citations?.map((c) => c.valueText)),
);
check("A6 免责声明在", typeof interp.body?.disclaimer === "string" && interp.body.disclaimer.includes("不构成医疗诊断"), "");
check("A6 解读文本非空", String(interp.body?.text ?? "").length > 20, `${String(interp.body?.text ?? "").length} 字`);

const noData = await call("/api/interpret", { method: "POST", body: JSON.stringify({ standardName: "不存在的指标" }) });
check("A6 无数据 → 拒答", noData.body?.refused === true && noData.body?.refusalReason === "no_data", String(noData.body?.refusalReason));

const redline = await call("/api/interpret", {
  method: "POST",
  body: JSON.stringify({ standardName: "甘油三酯", question: "我该吃什么药" }),
});
check("A6 红线提问 → 拒答", redline.body?.refused === true && redline.body?.refusalReason === "question_guard", String(redline.body?.refusalReason));

/* ─────────────────── 错误路径 ─────────────────── */

const badDate = await call("/api/reports", {
  method: "POST",
  body: JSON.stringify({ checkDate: "2025-13-99", rawText: "x", metrics: [{ rawName: "a", valueText: "1" }] }),
});
check("非法日期 → 400", badDate.status === 400, `status=${badDate.status}`);

const emptyMetrics = await call("/api/reports", {
  method: "POST",
  body: JSON.stringify({ checkDate: "2025-01-01", rawText: "x", metrics: [] }),
});
check("无指标 → 400", emptyMetrics.status === 400, `status=${emptyMetrics.status}`);

const ocrBad = await call("/api/ocr", { method: "POST", body: JSON.stringify({ image: "not-a-data-url" }) });
check("OCR 非 dataURL → 400", ocrBad.status === 400, `status=${ocrBad.status}`);

/* ─────────────────── 清理（精确 id，不按标题猜）─────────────────── */

for (const id of [reportId1, reportId2, manualReportId]) {
  if (!id) continue;
  const del = await call("/api/reports?id=" + encodeURIComponent(id), { method: "DELETE" });
  check(`清理报告 ${id.slice(0, 12)}…`, del.status === 200, `status=${del.status}`);
}

const after = await call("/api/reports");
check("清理后报告数回到 0", (after.body?.reports ?? []).length === 0, `n=${after.body?.reports?.length}`);

/* ─────────────────── 汇总 ─────────────────── */

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`线上 E2E：通过 ${passed} / ${results.length}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("\n失败项:");
  for (const f of failed) console.log(`- ${f.name} — ${f.detail ?? ""}`);
}
await task.close?.();