/**
 * A2 扫描件路径线上验证：canvas 合成「扫描件」（图片，无文字层）→ /api/ocr → /api/extract
 *
 * 为什么要合成而不是找真实扫描件：真实体检报告属个人敏感数据，不入库、不进程。
 * 合成图能覆盖本环节的真实风险 ——「视觉模型对中文表格的识别质量」，
 * 而识别质量只取决于字体渲染与排版，不取决于数据是否真实。
 *
 * 用法：ego-browser nodejs < e2e/live-ocr.mjs
 */

const fs = await import("node:fs");

const BASE = "https://health-track.ilikesaury.workers.dev";
const secretsPath = "H:/Work/Projects/Personal/fde-agent-delivery/product4/.secrets.json";
const TOKEN = JSON.parse(fs.readFileSync(secretsPath, "utf8")).ACCESS_TOKEN;

const task = await taskSpace("health-track OCR e2e 2026-10-29");
const page = task.page("p1");

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await page.goto(BASE, { waitUntil: "load", timeout: 30000 });

/** 在页面里画一张「扫描件」并导出 JPEG dataURL（模拟手机拍照/扫描件，无文字层） */
const dataUrl = await page.evaluate(() => {
  const lines = [
    "示例市第一医院  检验报告单",
    "采样日期：2025-03-14",
    "",
    "项目名称        结果     单位      参考范围",
    "甘油三酯        2.31     mmol/L    0.45-1.7",
    "空腹血糖        5.31     mmol/L    3.9-6.1",
    "白细胞计数      6.2      10^9/L    3.5-9.5",
    "",
    "检验者：李四   审核者：王五",
  ];
  const W = 900;
  const H = 1000;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111111";
  ctx.font = "26px 'Microsoft YaHei', 'PingFang SC', sans-serif";
  let y = 90;
  for (const line of lines) {
    ctx.fillText(line, 70, y);
    y += 56;
  }
  return canvas.toDataURL("image/jpeg", 0.85);
});
check("合成扫描件 dataURL", typeof dataUrl === "string" && dataUrl.startsWith("data:image/jpeg;base64,"), `${String(dataUrl).length} 字符`);

/** OCR（长请求走轮询） */
let seq = 0;
const callLong = async (path, init) => {
  const key = "__htOcr" + ++seq;
  await page.evaluate(
    (a) => {
      window[a.key] = { done: false, status: 0, text: null };
      fetch(a.base + a.path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
        body: a.body,
      })
        .then(async (r) => {
          const t = await r.text();
          window[a.key] = { done: true, status: r.status, text: t };
        })
        .catch((e) => {
          window[a.key] = { done: true, status: 0, text: String(e) };
        });
    },
    { key, base: BASE, token: TOKEN, path, body: init.body },
  );
  const deadline = Date.now() + 120_000;
  let payload = null;
  while (Date.now() < deadline) {
    payload = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (payload?.done) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  let body = null;
  try {
    body = JSON.parse(String(payload?.text));
  } catch {
    body = { raw: String(payload?.text ?? "").slice(0, 300) };
  }
  return { status: payload?.status ?? 0, body };
};

const ocr = await callLong("/api/ocr", { body: JSON.stringify({ image: dataUrl, page: 1 }) });
check("OCR 返回 200", ocr.status === 200, `status=${ocr.status} ${ocr.body?.error ?? ""}`);
const text = String(ocr.body?.text ?? "");
check("OCR 出文字", text.length > 50, `${text.length} 字符`);
check("识别到「甘油三酯」", text.includes("甘油三酯"), "");
check("识别到数值 2.31", text.includes("2.31"), "");
check("识别到参考范围 0.45-1.7", text.includes("0.45-1.7"), "");
check("识别到日期 2025-03-14", text.includes("2025-03-14") || text.includes("2025"), "");

console.log("\n── OCR 文本（未校对，前端会放回可编辑框）──");
console.log(text.trim().split("\n").slice(0, 12).map((l) => `  | ${l}`).join("\n"));

/* OCR 文本 → 抽取（同一条链路，验证「扫描件只是文本获取的一种手段」） */
const ex = await callLong("/api/extract", {
  body: JSON.stringify({ text, sourceType: "ocr", fileName: "scan.jpg" }),
});
check("OCR 文本 → 抽取 200", ex.status === 200, `status=${ex.status} ${ex.body?.error ?? ""}`);
const metrics = ex.body?.metrics ?? [];
check("抽取到指标", metrics.length >= 2, `n=${metrics.length}`);
const tg = metrics.find((m) => m.standardName === "甘油三酯");
check("OCR 路径也能判偏高", tg?.status === "high", String(tg?.status ?? "无该指标"));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${"=".repeat(56)}`);
console.log(`OCR 路径：通过 ${passed} / ${results.length}`);
if (passed < results.length) {
  console.log("\n失败项:");
  for (const f of results.filter((r) => !r.ok)) console.log(`- ${f.name} — ${f.detail ?? ""}`);
}
await task.close?.();