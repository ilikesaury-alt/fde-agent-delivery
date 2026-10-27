// ego-browser: 第一性原理分水岭测试
// 不在页面上做任何交互（不点击、不聚焦），只加载 + 静置 3 秒 + 探活。
// 大样本（20 轮）统计纯静置下是否偶发卡死。
// 若静置也卡 → hang 与 textarea 交互无关（是加载/运行时问题）
// 若静置全正常 → hang 确实由某交互触发，需继续隔离交互
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const ROUNDS = 20;

const task = await taskSpace("focus-hang-idle");
const page = task.page("p1");

function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3500)),
  ]);
}

let idleHang = 0;
for (let i = 1; i <= ROUNDS; i++) {
  let ok = false;
  try {
    await page.goto(URL_, { waitUntil: "commit", timeout: 15000 });
    await page.waitForSelector("#textInput", { timeout: 12000 });
    await page.waitForTimeout(3000); // 静置 3 秒，不做任何交互
    ok = await alive();
  } catch (e) {
    ok = false;
  }
  if (!ok) idleHang++;
  console.log(`  round ${i}: ${ok ? "正常" : "卡死/失败"}`);
}
console.log(`\n>>> 纯静置加载 ${ROUNDS} 轮：卡死/失败 ${idleHang}/${ROUNDS}`);

await task.finish({ keep: [] });
