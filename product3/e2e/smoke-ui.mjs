/**
 * 构建产物浏览器冒烟（dev-task-flow 第 5 步必做项）
 * 对象：vite build 产物 + Node shim（默认 http://127.0.0.1:8907）
 *
 * ⚠️ 每轮冒烟前请**重启** shim（内存库清空），否则同内容会「已跳过重复导入」，
 *    断言会因为夹具不干净而误报（踩过）。用 `node e2e/serve-for-smoke.mjs` 起栈。
 *
 * 只验单测覆盖不到的「接线」：
 *   ① 空输入时提交是否 disabled（不是报错）
 *   ② 流式/长等待是否有可见反馈（步骤 chips + 增量文本）
 *   ③ 进行中能否取消、取消后状态是否回正
 *   ④ 成功 / 拒答 是否有可见反馈（引用块、拒答文案）
 *   ⑤ 二期接线：会话侧栏 / 追问改写标注 / 索引徽标与探针 / 复制反馈且会复原
 *
 * 全部用断言式验证（DOM 属性/文本/计数），截图仅补充。
 * 注意：waitForFunction 签名是 (fn, arg, options)——options 必须是第 3 个参数。
 */

const task = await taskSpace("kb-ask smoke 2026-10-28");
const page = task.page("p1");

const BASE = "http://127.0.0.1:8913";
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * 点击辅助：一律用 evaluate 里的 DOM click。
 * 原因：ego 的 page.click 要求元素在**视口内**，而问答区/输入区在长页面下方会滚出屏幕，
 * 于是出现过 "element is not visible in the viewport" 的假失败（不是产品缺陷）。
 * 断言仍然落在点击**之后**的 DOM 状态上，所以不存在「绕过真实交互」。
 */
const clickByTestId = (id) =>
  page.evaluate(
    // eslint-disable-next-line no-new-func
    new Function(`const el = document.querySelector('[data-testid="${id}"]'); if (el) { el.scrollIntoView({ block: "center" }); el.click(); } return Boolean(el);`),
  );

const waitUntil = (fn, timeout = 30000) =>
  page.waitForFunction(fn, undefined, { timeout }).then(() => true).catch(() => false);

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForSelector('[data-testid="ask-btn"]');
// 等 React 水合完成：服务端已渲染出 DOM，但事件处理器挂上去有延迟；
// 太早点按钮/填输入会拿到「填了值但状态没更新」的假失败（实测偶发）。
await new Promise((r) => setTimeout(r, 1200));
check("页面加载", true, `title=${await page.title()}`);

// ── ① 空输入禁用提交 ─────────────────────────────────────────────────
const initial = await page.evaluate(() => {
  const ask = document.querySelector('[data-testid="ask-btn"]');
  const imp = document.querySelector('[data-testid="import-btn"]');
  return {
    askDisabled: ask ? ask.disabled : null,
    importDisabled: imp ? imp.disabled : null,
    bodyLen: document.body.innerText.length,
  };
});
check("① 空问题时「提问」按钮 disabled", initial.askDisabled === true, `disabled=${initial.askDisabled}`);
check("① 空文本时「导入并索引」按钮 disabled", initial.importDisabled === true, `disabled=${initial.importDisabled}`);
check("① 页面有实际渲染内容", initial.bodyLen > 100, `innerText=${initial.bodyLen} 字`);

// ── 导入文档（粘贴路径）───────────────────────────────────────────────
const DOC = `# 部署手册

## 部署步骤

执行构建后上传产物，然后核验静态资产、数据库、向量索引三类绑定都在。

## 回滚

回滚使用带完整版本号的命令，回滚前确认目标是最近的已知可用版本。`;

// 填文本 → 轮询按钮状态（水合窗口内偶发不生效，重填一次是测试侧兜底，不是产品问题）
let afterFill = { importDisabled: true };
for (let attempt = 0; attempt < 3 && afterFill.importDisabled !== false; attempt++) {
  await page.fill('[data-testid="paste-textarea"]', DOC);
  await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 800));
  afterFill = await page.evaluate(() => ({
    importDisabled: document.querySelector('[data-testid="import-btn"]')?.disabled ?? null,
  }));
}
check("① 有文本后「导入」按钮可用", afterFill.importDisabled === false, `disabled=${afterFill.importDisabled}`);

await clickByTestId("import-btn");
await page.waitForSelector('[data-testid="import-msg"]', { timeout: 30000 });
await page.waitForSelector('[data-testid="doc-item"]', { timeout: 30000 });

const afterImport = await page.evaluate(() => ({
  msg: document.querySelector('[data-testid="import-msg"]')?.innerText ?? "",
  items: [...document.querySelectorAll('[data-testid="doc-item"]')].map((n) => n.innerText),
  askDisabled: document.querySelector('[data-testid="ask-btn"]')?.disabled ?? null,
}));
check("② 导入成功有可见反馈", /已导入|切分为/.test(afterImport.msg), afterImport.msg.replace(/\s+/g, " ").slice(0, 70));
check(
  "② 提示索引约需 1 分钟（避免被误判成上传失败）",
  /约 1 分钟|异步/.test(afterImport.msg),
  afterImport.msg.replace(/\s+/g, " ").slice(0, 90),
);
check("② 文档出现在列表", afterImport.items.length >= 1, `items=${afterImport.items.length} ${afterImport.items[0]?.replace(/\s+/g, " ").slice(0, 40)}`);
check("① 未输入问题时「提问」仍 disabled", afterImport.askDisabled === true, `disabled=${afterImport.askDisabled}`);

// ── ② 索引状态徽标 + 可见性探针（二期 A5）──────────────────────────
const badgeText = await page.evaluate(() => document.querySelector('[data-testid="doc-status"]')?.innerText.trim() ?? "");
check("② 文档行显示索引状态徽标", /索引中|已就绪|可检索/.test(badgeText), `badge=${badgeText}`);

await page.evaluate(() => document.querySelector('[data-testid="probe-btn"]')?.click());
const probed = await waitUntil(() => /可检索|检索不到/.test(document.querySelector('[data-testid="import-msg"]')?.innerText ?? ""), 20000);
const probeBadge = await page.evaluate(() => document.querySelector('[data-testid="doc-status"]')?.innerText.trim() ?? "");
check("② 探针给出真实结论（可检索 / 暂时检索不到）", probed, `badge=${probeBadge}`);
check("② 探针命中后徽标翻转为「可检索已验证」", /可检索已验证/.test(probeBadge), `badge=${probeBadge}`);

// ── ② 流式问答：步骤进度 + 增量 + 终态引用 ───────────────────────────
let askEnabled = false;
for (let attempt = 0; attempt < 3 && !askEnabled; attempt++) {
  await page.fill('[data-testid="question-input"]', "回滚要注意什么？");
  await new Promise((r) => setTimeout(r, attempt === 0 ? 200 : 600));
  askEnabled = (await page.evaluate(() => document.querySelector('[data-testid="ask-btn"]')?.disabled ?? null)) === false;
}
check("① 有问题文本后「提问」按钮可用", askEnabled);

await clickByTestId("ask-btn");

const sawProgress = await waitUntil(() => Boolean(document.querySelector('[data-testid="steps"]')), 15000);
check("② 提问后出现步骤进度（长等待有可见反馈）", sawProgress);

const sawCancel = await waitUntil(() => Boolean(document.querySelector('[data-testid="cancel-btn"]')), 10000);
check("③ 进行中显示「取消」按钮", sawCancel);

const stepsText = await page.evaluate(() => document.querySelector('[data-testid="steps"]')?.innerText ?? "");
check("② 步骤含检索与生成", /检索|生成/.test(stepsText), stepsText.replace(/\s+/g, " ").slice(0, 60));

// 终态：出现回答或拒答，且取消按钮消失
const settled = await waitUntil(() => {
  const cancel = document.querySelector('[data-testid="cancel-btn"]');
  const ans = document.querySelector('[data-testid="answer"]');
  const refusal = document.querySelector('[data-testid="refusal"]');
  return !cancel && (Boolean(refusal) || Boolean(ans && ans.innerText.trim().length > 5));
}, 60000);
check("② 问答有终态（不是一直转圈）", settled);

const doneState = await page.evaluate(() => {
  const ans = document.querySelector('[data-testid="answer"]');
  const refusal = document.querySelector('[data-testid="refusal"]');
  const citations = document.querySelector('[data-testid="citations"]');
  return {
    answerLen: ans ? ans.innerText.trim().length : 0,
    refused: Boolean(refusal),
    refusalText: refusal ? refusal.innerText.trim().slice(0, 60) : "",
    citationCount: citations ? citations.querySelectorAll("div").length : 0,
    citationText: citations ? citations.innerText.replace(/\s+/g, " ").slice(0, 100) : "",
    askLabel: document.querySelector('[data-testid="ask-btn"]')?.innerText.trim() ?? "",
  };
});
check(
  "④ 回答 + 引用块可见（引用带文档名与片段）",
  doneState.answerLen > 5 && doneState.citationCount > 0,
  `answerLen=${doneState.answerLen} citations=${doneState.citationCount} ${doneState.citationText}`,
);

// ── ② 会话侧栏与多轮（二期 A1/A2）────────────────────────────────
await waitUntil(() => document.querySelectorAll('[data-testid="conversation-item"]').length >= 1, 15000);
const convState = await page.evaluate(() => ({
  items: [...document.querySelectorAll('[data-testid="conversation-item"]')].map((n) => n.innerText.replace(/\s+/g, " ").trim()),
  active: document.querySelectorAll('[data-testid="conversation-item"][data-active="1"]').length,
  messages: document.querySelectorAll('[data-testid="message-item"]').length,
  newBtn: Boolean(document.querySelector('[data-testid="new-conversation-btn"]')),
}));
check("② 首问后会话出现在侧栏", convState.items.length >= 1, `items=${convState.items.length} ${convState.items[0] ?? ""}`);
check("② 当前会话被高亮（1 个 active）", convState.active === 1, `active=${convState.active}`);
check("② 侧栏有「新会话」入口", convState.newBtn);
check("② 消息流显示 1 轮", convState.messages === 1, `messages=${convState.messages}`);

// ── ④ 拒答态 ─────────────────────────────────────────────────────────
await page.fill('[data-testid="question-input"]', "请说明量子色动力学中的渐近自由现象");
await clickByTestId("ask-btn");
const refusalShown = await waitUntil(() => Boolean(document.querySelector('[data-testid="refusal"]')), 60000);
const refusalInfo = await page.evaluate(() => ({
  text: document.querySelector('[data-testid="refusal"]')?.innerText.trim().slice(0, 80) ?? "",
  nearestCount: document.querySelectorAll('[data-testid="refusal"] ~ div, [data-testid="refusal"] + div').length,
}));
check("④ 无依据时展示拒答态且文案明确", refusalShown && /未找到/.test(refusalInfo.text), refusalInfo.text);

// ── ③ 取消（放在最后，避免中断影响后续用例）──────────────────────────
await page.fill('[data-testid="question-input"]', "请详细解释部署与回滚的完整流程和注意事项");
await clickByTestId("ask-btn");
const sawCancel2 = await waitUntil(() => Boolean(document.querySelector('[data-testid="cancel-btn"]')), 15000);
check("③ 再次提问时出现「取消」", sawCancel2);
if (sawCancel2) {
  await clickByTestId("cancel-btn");
  const backToIdle = await waitUntil(() => {
    const cancel = document.querySelector('[data-testid="cancel-btn"]');
    const ask = document.querySelector('[data-testid="ask-btn"]');
    return !cancel && Boolean(ask) && !ask.disabled;
  }, 20000);
  check("③ 取消后状态回正（取消按钮消失、提问按钮恢复可用）", backToIdle);
}

// ── ② 追问省略式问题：应显示「已按上下文改写」（二次验证 A1）──────
await page.fill('[data-testid="question-input"]', "它呢？");
await clickByTestId("ask-btn");
const followDone = await waitUntil(() => {
  const items = document.querySelectorAll('[data-testid="message-item"]');
  const ask = document.querySelector('[data-testid="ask-btn"]');
  // 等到「新的一轮已落地」且「流式已结束」再断言（否则会读到 回答中… 的中间态）
  return items.length >= 3 && Boolean(ask) && !/回答中/.test(ask.innerText);
}, 60000);
const followState = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[data-testid="message-item"]')];
  const last = items[items.length - 1];
  return {
    count: items.length,
    lastText: last ? last.innerText.replace(/\s+/g, " ").slice(0, 160) : "",
    askLabel: document.querySelector('[data-testid="ask-btn"]')?.innerText.trim() ?? "",
  };
});
check("② 追问追加为新一轮（同一会话）", followDone && followState.count >= 3, `count=${followState.count}`);
check("② 追问标注「已按上下文改写」", /已按上下文改写/.test(followState.lastText), followState.lastText);
check("② 会话内追问时按钮文案变为「继续追问」", /继续追问/.test(followState.askLabel), followState.askLabel);

// ── ③ 复制按钮有成功反馈且会复原 ─────────────────────────────────
const copyState = await page.evaluate(() => {
  const btn = document.querySelector('[data-testid="copy-answer-btn"]');
  if (!btn) return { clicked: false, label: "" };
  btn.click();
  return { clicked: true, label: btn.innerText.trim() };
});
const copyFeedback = await waitUntil(
  () => /已复制/.test(document.querySelector('[data-testid="copy-answer-btn"]')?.innerText ?? ""),
  8000,
);
check("③ 复制按钮点击后反馈「已复制」", copyState.clicked && copyFeedback, `label=${copyState.label}`);
const copyRestored = await waitUntil(
  () => /复制回答/.test(document.querySelector('[data-testid="copy-answer-btn"]')?.innerText ?? ""),
  8000,
);
check("③ 复制反馈 2 秒后复原", copyRestored);

// ── ② 新建会话清空当前上下文 ──────────────────────────────────────
await clickByTestId("new-conversation-btn");
const cleared = await waitUntil(
  () => document.querySelectorAll('[data-testid="message-item"]').length === 0,
  10000,
);
check("② 「新会话」清空消息流（会话仍留在侧栏）", cleared);

// ── ② 删除会话（A2 最后一环：接口 + 入口都要有）────────────────────
await waitUntil(() => document.querySelectorAll('[data-testid="conversation-item"]').length >= 1, 15000);
const beforeConv = await page.evaluate(() => document.querySelectorAll('[data-testid="conversation-item"]').length);
const delBtnReady = await waitUntil(
  () => Boolean(document.querySelector('[data-testid="conversation-delete"]')),
  10000,
);
if (beforeConv > 0 && delBtnReady) {
  // 删除按钮是 hover 才显形的绝对定位小按钮：用直接 DOM click，且**允许重试** ——
  // 侧栏在 onDone 后还会 refreshConversations，重渲染窗口内点到的可能是即将被替换的节点
  // （真实用户点的是当下可见节点，不存在这个问题；自动化要补这个时序）。
  let convDeleted = false;
  for (let attempt = 0; attempt < 3 && !convDeleted; attempt++) {
    await page.evaluate(() => document.querySelector('[data-testid="conversation-delete"]')?.click());
    // 注意：waitUntil 的谓词会被序列化到页面里执行，**取不到 Node 侧的闭包变量**
    // （这里踩过：`length < beforeConv` 在页面里永远 false，因为 beforeConv 是 undefined）。
    // 所以把目标值内联进函数体。
    const targetCount = beforeConv - 1;
    convDeleted = await waitUntil(
      new Function(`return document.querySelectorAll('[data-testid="conversation-item"]').length <= ${targetCount};`),
      8000,
    );
    if (!convDeleted) await new Promise((r) => setTimeout(r, 500));
  }
  const afterConv = await page.evaluate(() => document.querySelectorAll('[data-testid="conversation-item"]').length);
  check("② 删除会话后侧栏条目减少", convDeleted, `before=${beforeConv} after=${afterConv}`);
} else {
  check("② 删除会话后侧栏条目减少", false, "前置不成立：侧栏没有会话");
}

// ── 删除连带清理的可见反馈 ───────────────────────────────────────────
const beforeDelete = await page.evaluate(() => document.querySelectorAll('[data-testid="doc-item"]').length);
if (beforeDelete > 0) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-testid="doc-item"] button')].find((b) => b.innerText.includes("删除"));
    btn?.click();
  });
  const deleted = await waitUntil(() => {
    const msg = document.querySelector('[data-testid="import-msg"]')?.innerText ?? "";
    return /已删除/.test(msg);
  }, 20000);
  check("④ 删除文档有可见反馈", deleted);
}

await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/product3/docs/e2e-evidence/ui-final.png" }).catch((e) => {
  console.log(`（截图失败，不影响断言：${e instanceof Error ? e.message : e}）`);
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  throw new Error(`冒烟失败 ${failed.length} 项`);
}
