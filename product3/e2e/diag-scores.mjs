/**
 * 检索打分诊断：把用户真实语料里的关键词当问题问，看相似度落在哪。
 * 目的：区分「索引没追上」与「阈值过高」。
 * 令牌从 .secrets.json 读入，不打印。
 */
const fs = await import("node:fs");
const BASE = "https://kb-ask.ilikesaury.workers.dev";
const TOKEN = JSON.parse(
  fs.readFileSync("H:/Work/Projects/Personal/fde-agent-delivery/product3/.secrets.json", "utf8"),
).ACCESS_TOKEN;

const questions = [
  "MoneyPrinterTurbo",
  "RSSHub",
  "autoeditor",
  "推特好帖搬运到小红书用什么工具",
  "MoneyPrinterTurbo 是什么",
  "推荐的发布组合是什么",
  "拍的视频怎么自动剪辑发布",
];

const task = await taskSpace("kb-ask retrieval scoring diag");
const page = task.page("p1");
await page.goto(BASE, { waitUntil: "load" });

const ask = async (q) => {
  const key = "__q" + Math.random().toString(36).slice(2);
  await page.evaluate(
    (a) => {
      window[a.key] = { done: false };
      fetch(a.base + "/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + a.token },
        body: JSON.stringify({ question: a.q }),
      })
        .then((r) => r.text())
        .then((t) => (window[a.key] = { done: true, text: t }))
        .catch((e) => (window[a.key] = { done: true, text: "ERR " + e }));
    },
    { key, base: BASE, token: TOKEN, q },
  );
  const deadline = Date.now() + 120_000;
  let v = null;
  while (Date.now() < deadline) {
    v = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (v?.done) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!v?.done) return { error: "timeout" };
  const events = [];
  for (const block of String(v.text).split("\n\n")) {
    let ev = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    try {
      events.push({ ev, data: JSON.parse(data.join("\n")) });
    } catch {}
  }
  return { events };
};

console.log("问题 → 结果（分数是 bge-m3 余弦相似度）\n");
for (const q of questions) {
  const r = await ask(q);
  if (r.error) {
    console.log(`✖ [${q}] ${r.error}`);
    continue;
  }
  const done = r.events.find((e) => e.ev === "done");
  const err = r.events.find((e) => e.ev === "error");
  if (err) {
    console.log(`✖ [${q}] error=${JSON.stringify(err.data).slice(0, 150)}`);
    continue;
  }
  const res = done?.data?.result ?? {};
  const cite = res.citations ?? [];
  const near = res.nearest ?? [];
  const fmt = (a) =>
    a.map((c) => `${c.score?.toFixed(3)}(${c.docTitle ?? "?"}#${c.idx ?? "?"})`).join(" ");
  console.log(
    `[${q}]\n   refused=${res.refused}  citations=${cite.length}` +
      `\n   citations: ${fmt(cite) || "-"}` +
      `\n   nearest  : ${fmt(near) || "-"}`,
  );
}