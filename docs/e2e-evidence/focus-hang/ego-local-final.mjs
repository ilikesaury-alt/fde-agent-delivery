// ego-browser: 本地 127.0.0.1:8899 复现 textarea hang（开发环境，可确定性调试）
const URL_ = "http://127.0.0.1:8899/";
const N = 6;
const task = await taskSpace("focus-hang-local-final");
const page = task.page("p1");
function alive(label) {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3000)),
  ]).then((ok) => { console.log(`  [alive:${label}] ${ok ? "正常" : "卡死→TIMEOUT"}`); return ok; });
}
async function clickTA() { try { await page.click("#textInput", { timeout: 2000 }); } catch (e) { console.log("  click err:", e.message.split("\n")[0]); } }

for (let i = 1; i <= N; i++) {
  console.log(`\n===== 本地 round ${i} =====`);
  try {
    await page.goto(URL_, { waitUntil: "commit", timeout: 12000 });
    await page.waitForSelector("#textInput", { timeout: 10000 });
    await page.waitForTimeout(1000);
  } catch (e) { console.log("  加载失败:", e.message.split("\n")[0]); continue; }
  if (!(await alive("baseline"))) { console.log("  进入即卡"); continue; }
  await clickTA();
  await page.waitForTimeout(700);
  await alive("after-textarea-click");
  if (await alive("pre-fill")) {
    try { await page.fill("#textInput", "本地测试输入一行文字用于验证"); } catch (e) { console.log("  fill err:", e.message.split("\n")[0]); }
    await page.waitForTimeout(400);
    await alive("after-fill");
  }
}
// 收集 error 类事件
try {
  const evs = await page.events();
  const errs = (evs || []).filter((e) => /pageerror|exception|console|error/i.test(JSON.stringify(e)));
  console.log(`\n=== error 类事件 ${errs.length} ===`);
  errs.slice(0, 15).forEach((e) => console.log("  " + JSON.stringify(e).slice(0, 260)));
} catch (e) { console.log("  events err:", e.message.split("\n")[0]); }
await task.finish({ keep: [] });
