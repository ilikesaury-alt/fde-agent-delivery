// ego-browser: 第一性原理隔离 —— 只测"页面加载/重载"本身是否偶发卡死（完全不点击任何元素）
// 目的：判定 hang 是否发生在加载阶段（=Worker/页面加载问题），而非 textarea 交互。
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const ROUNDS = 6;

const task = await taskSpace("focus-hang-loadonly");
const page = task.page("p1");

function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3500)),
  ]);
}

function loadHang() {
  return Promise.race([
    page.goto(URL_, { waitUntil: "commit", timeout: 15000 }).then(() => false).catch(() => true),
    new Promise((res) => setTimeout(() => res(true), 16000)),
  ]);
}

let loadFail = 0, aliveFail = 0;
for (let i = 1; i <= ROUNDS; i++) {
  const lh = await loadHang();
  if (lh) { loadFail++; console.log(`  round ${i}: 加载即失败/超时`); continue; }
  await page.waitForSelector("#textInput", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  const ok = await alive();
  console.log(`  round ${i}: 加载完成, 探活 ${ok ? "正常" : "卡死"}`);
  if (!ok) aliveFail++;
  // 立即 reload，测重载路径
  try { await page.reload({ waitUntil: "commit", timeout: 12000 }); } catch {}
}
console.log(`\n>>> 加载失败: ${loadFail}/${ROUNDS}, 加载后探活卡死: ${aliveFail}/${ROUNDS}`);

await task.finish({ keep: [] });
