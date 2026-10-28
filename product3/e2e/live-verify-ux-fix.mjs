/**
 * 线上验证本次 UX 修复（导入延迟提示 + 空标题修复）。
 *
 * 四项检查：
 *  ① 页面标题非空（补 pages/index.server.ts 后应生效）
 *  ② 导入提示说明「约 1 分钟」并显示 60 秒倒计时
 *  ③ 导入后**立刻**提问 → 拒答且带 indexingRecently 提示
 *  ④ 等 62 秒后再问 → 命中且带引用
 *
 * 用每次运行都唯一的标记词，避免命中历史文档导致假绿/假红。
 * 令牌从 .secrets.json 读入，不打印。
 */
const fs = await import("node:fs");
const BASE = "https://kb-ask.ilikesaury.workers.dev";
const TOKEN = JSON.parse(
  fs.readFileSync("H:/Work/Projects/Personal/fde-agent-delivery/product3/.secrets.json", "utf8"),
).ACCESS_TOKEN;

const MARK = "MARK" + Date.now().toString(36).toUpperCase();
const text = `# 线上复验文档 ${MARK}

## 1. 标记
本段包含本次运行唯一标记词 ${MARK}，只用于验证检索链路。

## 2. 其他
回滚要带完整版本号，并确认目标是最近的已知可用版本。`;

const out = [];
const say = (ok, name, detail) => {
  out.push(`${ok ? "✔" : "✖"} ${name} — ${detail}`);
  console.log(out[out.length - 1]);
};

const task = await taskSpace("kb-ask ux fix verify");
const page = task.page("p1");
await page.goto(BASE, { waitUntil: "load" });

// ① 标题
const title = await page.evaluate(() => document.title);
say(Boolean(title), "① 页面标题非空", title || "(空)");

// 令牌落 localStorage 后 reload，让 React 挂载时读到（比模拟 input 事件稳）
await page.evaluate((t) => localStorage.setItem("kb_token", t), TOKEN);
await page.reload({ waitUntil: "load" });
await new Promise((r) => setTimeout(r, 1200));

// 页面内发请求并轮询取回（page.evaluate 固定 15s 上限，长请求不能整段塞进去）
const inPage = async (path, method, body) => {
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
    { key, base: BASE, path, method, body, token: TOKEN },
  );
  let v = null;
  for (let i = 0; i < 150; i++) {
    v = await page.evaluate((a) => window[a.key] ?? null, { key });
    if (v?.done) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return v?.text ?? "ERR timeout";
};

const parseEvents = (raw) => {
  const evs = [];
  for (const block of String(raw).split("\n\n")) {
    let ev = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length) {
      try {
        evs.push({ ev, data: JSON.parse(data.join("\n")) });
      } catch {}
    }
  }
  return evs;
};
const ask = async (q) => {
  const evs = parseEvents(await inPage("/api/ask", "POST", { question: q }));
  return evs.find((e) => e.ev === "done")?.data?.result ?? {};
};

// ② 导入（接口路径，用于 ③④ 的确定性判定）
const imp = JSON.parse(await inPage("/api/documents", "POST", { source: "paste", text, title: `UX 复验 ${MARK}` }));
say(imp.document?.status === "ready", "② 导入成功", `status=${imp.document?.status} chunks=${imp.document?.chunkCount}`);

// ③ 立刻提问 → 必须拒答并提示索引未生效（用标记词：此处要的是拒答，不依赖命中）
const r1 = await ask(`${MARK} 是什么？`);
say(
  r1.refused === true && r1.indexingRecently === true,
  "③ 导入后立刻提问 → 拒答且带「索引异步」提示",
  `refused=${r1.refused} indexingRecently=${r1.indexingRecently}`,
);

// ② UI 文案：page.fill + page.click 触发真实事件
const uiText = `# UI 提示验证 ${MARK}U\n\n## 1. 内容\n用于验证导入提示文案的占位文本，长度足够产生片段。\n`;
await page.fill('[data-testid="paste-textarea"]', uiText);
await page.click('[data-testid="import-btn"]', { label: "导入并索引" });
await page.waitForSelector('[data-testid="import-msg"]', { timeout: 30000 });
const uiMsg = await page.evaluate(
  () => document.querySelector('[data-testid="import-msg"]')?.innerText ?? "NO_MSG",
);
const flat = String(uiMsg).replace(/\s+/g, " ");
say(/约 1 分钟|异步/.test(uiMsg), "② 导入提示说明索引延迟", flat.slice(0, 80));
say(/还需约/.test(uiMsg), "② 显示 60 秒倒计时", flat.slice(0, 90));

// ④ 等索引追上再问 → 命中且带引用（轮询，记录真实耗时）
// 固定等 60s 不够：实测线上约 50s，但受负载影响可能更久，断言会偶发失败。
const t0 = Date.now();
let r2 = await ask("回滚要注意什么？");
let elapsed = 0;
while (Date.now() - t0 < 150_000) {
  if (r2.refused === false && (r2.citations?.length ?? 0) > 0) break;
  await new Promise((r) => setTimeout(r, 10_000));
  elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`   · 等待索引追上（${elapsed}s）…`);
  r2 = await ask("回滚要注意什么？");
}
const topScore = Math.max(...[...(r2.citations ?? []), ...(r2.nearest ?? [])].map((c) => c.score ?? 0), 0);
say(
  r2.refused === false && (r2.citations?.length ?? 0) > 0,
  "④ 索引追上后命中（语义查询）",
  `等待 ${elapsed}s refused=${r2.refused} citations=${r2.citations?.length ?? 0} 最高分=${topScore.toFixed(3)}`,
);

// 清理本次两份文档（走接口删除，连带清向量）
const cleaned = await page.evaluate(
  async (a) => {
    const res = [];
    const list = await (
      await fetch(a.base + "/api/documents", { headers: { authorization: "Bearer " + a.token } })
    ).json();
    for (const d of list.documents ?? []) {
      if (String(d.title).includes(a.mark)) {
        const r = await fetch(a.base + "/api/documents?id=" + encodeURIComponent(d.id), {
          method: "DELETE",
          headers: { authorization: "Bearer " + a.token },
        });
        res.push(`${d.title}:${r.status}`);
      }
    }
    return res;
  },
  { base: BASE, token: TOKEN, mark: MARK },
);
console.log("\n清理: " + JSON.stringify(cleaned));

const pass = out.filter((l) => l.startsWith("✔")).length;
console.log(`\n结果：${pass}/${out.length} 通过（标记词 ${MARK}）`);