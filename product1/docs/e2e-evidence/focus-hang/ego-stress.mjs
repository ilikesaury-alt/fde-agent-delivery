// ego-browser: 量化 hang 的稳定性 —— 原版 / 修复版 各多次点击 textarea，统计卡死次数
// 关键：之前单次"不卡"可能是偶发，必须多次采样。
const TOKEN = (process.env.ACCESS_TOKEN || process.env.MEETING_DIGEST_TOKEN || "").trim();
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const ROUNDS = 5;

const task = await taskSpace("focus-hang-stress");
const page = task.page("p1");

function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3500)),
  ]);
}

async function clickTA() {
  try { await page.click("#textInput", { timeout: 2500 }); }
  catch { /* 超时也算异常 */ }
}

async function run(label, fix) {
  console.log(`\n===== ${label} =====`);
  await page.goto(URL_, { waitUntil: "commit", timeout: 45_000 });
  await page.evaluate((t) => { window.localStorage.setItem("md_token", t); }, TOKEN);
  try { await page.reload({ waitUntil: "commit", timeout: 30_000 }); } catch {}
  await page.waitForSelector("#textInput", { timeout: 30_000 });
  await page.waitForTimeout(1000);
  if (fix) {
    await page.evaluate(() => {
      const s = document.createElement("style");
      s.textContent = `header{position:static!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;z-index:auto!important}`;
      document.head.appendChild(s);
    });
    await page.waitForTimeout(400);
  }
  let hang = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    // 先确认活着（否则已卡）
    if (!(await alive())) { hang++; console.log(`  round ${i}: 进入时已卡(累计${hang})`); break; }
    await clickTA();
    await page.waitForTimeout(600);
    const ok = await alive();
    console.log(`  round ${i}: ${ok ? "正常" : "卡死"}`);
    if (!ok) { hang++; break; }
  }
  console.log(`  >>> ${label}: 卡死 ${hang}/${ROUNDS}`);
}

await run("原版(未修复)", false);
await run("修复版(static header + 无 blur)", true);

await task.finish({ keep: [] });
