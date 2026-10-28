/**
 * 实测「导入 → 可检索」的延迟，回答「为什么刚上传就搜不到」。
 * 用一个人造唯一词（ZEBRAQUARTZ）确保只能来自本文档。
 */
const fs = await import("node:fs");
const BASE = "https://kb-ask.ilikesaury.workers.dev";
const TOKEN = JSON.parse(
  fs.readFileSync("H:/Work/Projects/Personal/fde-agent-delivery/product3/.secrets.json", "utf8"),
).ACCESS_TOKEN;

const MARK = "ZEBRAQUARTZ";
const text = `索引延迟实测文档

## 1. 标记词
本文档包含唯一标记词 ${MARK}，它只出现在这里，用于验证检索延迟。

## 2. 其他内容
这是一段用于增加长度的普通文本，确保切分产生多个片段。部署流程包括构建、上传与探针。
回滚需要带完整版本号，并确认目标是最近的已知可用版本。`;

const task = await taskSpace("kb-ask index lag measurement");
const page = task.page("p1");
await page.goto(BASE, { waitUntil: "load" });

const call = async (path, init) => {
  const key = "__c" + Math.random().toString(36).slice(2);
  await page.evaluate(
    (a) => {
      window[a.key] = { done: false };
      fetch(a.base + a.path, {
        method: a.method,
        headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
        body: a.body ? JSON.stringify(a.body) : undefined,
      })
        .then((r) => r.text())
        .then((t) => (window[a.key] = { done: true, text: t }))
        .catch((e) => (window[a.key] = { done: true, text: "ERR " + e }));
    },
    { key, base: BASE, path, method: init.method, body: init.body, token: TOKEN },
  );
  const deadline = Date.now() + 150_000;
  let v = null;
  while (Date.now() < deadline) {
    v = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (v?.done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return v?.text ?? "ERR timeout";
};

const parseEvents = (raw) => {
  const out = [];
  for (const block of String(raw).split("\n\n")) {
    let ev = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    try {
      out.push({ ev, data: JSON.parse(data.join("\n")) });
    } catch {}
  }
  return out;
};

const t0 = Date.now();
const imp = await call("/api/documents", { method: "POST", body: { source: "paste", text, title: "索引延迟实测" } });
const impJson = JSON.parse(imp);
const docId = impJson.document?.id ?? impJson.id;
console.log(`导入完成 t=${((Date.now() - t0) / 1000).toFixed(1)}s  status=${impJson.document?.status ?? "?"} chunks=${impJson.document?.chunkCount ?? "?"} id=${docId}`);

const askOnce = async () => {
  const raw = await call("/api/ask", { method: "POST", body: { question: `${MARK} 是什么？` } });
  const ev = parseEvents(raw);
  const done = ev.find((e) => e.ev === "done");
  const res = done?.data?.result ?? {};
  const top = Math.max(...[...(res.citations ?? []), ...(res.nearest ?? [])].map((c) => c.score ?? 0), 0);
  return { refused: res.refused, top };
};

console.log("\n秒数  结果        最高分");
for (let i = 0; i <= 24; i++) {
  const r = await askOnce();
  console.log(String(i * 10).padStart(4) + "  " + (r.refused ? "拒答" : "命中") + "  " + r.top.toFixed(3));
  if (!r.refused) break;
  await new Promise((res) => setTimeout(res, 10_000));
}

// 清理（走接口删除，会连带删向量）
const del = await call("/api/documents?id=" + encodeURIComponent(docId), { method: "DELETE" });
console.log("\n清理: " + String(del).slice(0, 100));