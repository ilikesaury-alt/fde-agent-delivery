/**
 * 构建产物浏览器冒烟（dev-task-flow 第 5 步必做项）
 * 对象：vite build 产物 + Node shim（默认 http://127.0.0.1:8907）
 *
 * 只验单测覆盖不到的「接线」：
 *   ① 空输入时提交是否 disabled（不是报错）
 *   ② 流式/长等待是否有可见反馈（步骤 chips + 增量文本）
 *   ③ 进行中能否取消、取消后状态是否回正
 *   ④ 成功 / 拒答 是否有可见反馈（引用块、拒答文案）
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

const waitUntil = (fn, timeout = 30000) =>
  page.waitForFunction(fn, undefined, { timeout }).then(() => true).catch(() => false);

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector('[data-testid="ask-btn"]');
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

await page.fill('[data-testid="paste-textarea"]', DOC);
const afterFill = await page.evaluate(() => ({
  importDisabled: document.querySelector('[data-testid="import-btn"]')?.disabled ?? null,
}));
check("① 有文本后「导入」按钮可用", afterFill.importDisabled === false, `disabled=${afterFill.importDisabled}`);

await page.click('[data-testid="import-btn"]', { label: "导入并索引" });
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

// ── ② 流式问答：步骤进度 + 增量 + 终态引用 ───────────────────────────
await page.fill('[data-testid="question-input"]', "回滚要注意什么？");
check(
  "① 有问题文本后「提问」按钮可用",
  (await page.evaluate(() => document.querySelector('[data-testid="ask-btn"]')?.disabled ?? null)) === false,
);

await page.click('[data-testid="ask-btn"]', { label: "提问" });

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

// ── ④ 拒答态 ─────────────────────────────────────────────────────────
await page.fill('[data-testid="question-input"]', "请说明量子色动力学中的渐近自由现象");
await page.click('[data-testid="ask-btn"]', { label: "问无关问题" });
const refusalShown = await waitUntil(() => Boolean(document.querySelector('[data-testid="refusal"]')), 60000);
const refusalInfo = await page.evaluate(() => ({
  text: document.querySelector('[data-testid="refusal"]')?.innerText.trim().slice(0, 80) ?? "",
  nearestCount: document.querySelectorAll('[data-testid="refusal"] ~ div, [data-testid="refusal"] + div').length,
}));
check("④ 无依据时展示拒答态且文案明确", refusalShown && /未找到/.test(refusalInfo.text), refusalInfo.text);

// ── ③ 取消（放在最后，避免中断影响后续用例）──────────────────────────
await page.fill('[data-testid="question-input"]', "请详细解释部署与回滚的完整流程和注意事项");
await page.click('[data-testid="ask-btn"]', { label: "第三次提问" });
const sawCancel2 = await waitUntil(() => Boolean(document.querySelector('[data-testid="cancel-btn"]')), 15000);
check("③ 再次提问时出现「取消」", sawCancel2);
if (sawCancel2) {
  await page.click('[data-testid="cancel-btn"]', { label: "取消提问" });
  const backToIdle = await waitUntil(() => {
    const cancel = document.querySelector('[data-testid="cancel-btn"]');
    const ask = document.querySelector('[data-testid="ask-btn"]');
    return !cancel && Boolean(ask) && !ask.disabled;
  }, 20000);
  check("③ 取消后状态回正（取消按钮消失、提问按钮恢复可用）", backToIdle);
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
