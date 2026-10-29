// ego-browser repro for "点击 textarea 主线程卡死" (focus-hang)
// Run: ego-browser nodejs < this file
const EVIDENCE = "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang";
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";

const task = await taskSpace("focus-hang-repro");
const page = task.page("p1");

async function alive(label) {
  const r = await Promise.race([
    page.evaluate(() => 1 + 1).then(() => ({ ok: true })).catch((e) => ({ ok: false, e: e.message })),
    new Promise((res) => setTimeout(() => res({ ok: false, e: "TIMEOUT(主线程无响应/卡死)" }), 4000)),
  ]);
  console.log(`  [alive:${label}] ${r.ok ? "响应正常" : "卡死 → " + r.e}`);
  return r.ok;
}

async function safeShot(name) {
  try {
    const p = await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
    console.log(`  [shot] ${name}.png -> ${p}`);
  } catch (e) {
    console.log(`  [shot:FAIL] ${name}: ${e.message.split("\n")[0]}`);
  }
}

console.log("=== 加载（先存 token 再 reload 过门禁）===");
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.evaluate((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForSelector("#textInput", { timeout: 20_000 });
await page.waitForTimeout(1500);

console.log("=== 基线 ===");
const gate = await page.evaluate(() => ({
  token: window.localStorage.getItem("md_token") ? "set" : "missing",
  hasApp: !!document.querySelector("#textInput"),
  reactKeys: Object.keys(document.querySelector("#textInput")?.parentElement || {}).filter((k) => k.startsWith("__reactFiber")),
}));
console.log("  门禁/水合:", JSON.stringify(gate));
await alive("baseline");
await safeShot("ego-01-loaded");

console.log("=== 点击 textarea（关键判定）===");
try { await page.click("#textInput", { label: "点击 textarea 输入框" }); }
catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
await page.waitForTimeout(800);
await alive("after-textarea-click");
await safeShot("ego-02-after-click");

console.log("=== 对照：点击页面标题（非交互）===");
try { await page.click("text=会议日报", { label: "点击页面标题" }); }
catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
await page.waitForTimeout(500);
await alive("after-title-click");

console.log("=== 在 textarea 里输入文字，看 onChange 是否卡 ===");
try {
  await page.fill("#textInput", "测试输入一行文字");
  console.log("  fill 完成");
} catch (e) { console.log("  fill err:", e.message.split("\n")[0]); }
await page.waitForTimeout(500);
await alive("after-fill");

console.log("=== 页面事件缓冲 ===");
try {
  const evs = await page.events();
  if (!evs || evs.length === 0) console.log("（无事件）");
  else for (const e of evs) {
    const kind = e.type || e.name || "event";
    const txt = e.text || e.message || JSON.stringify(e).slice(0, 300);
    console.log(`  [${kind}] ${String(txt).slice(0, 300)}`);
  }
} catch (e) { console.log("  events err:", e.message.split("\n")[0]); }

await task.finish({ keep: [] });
