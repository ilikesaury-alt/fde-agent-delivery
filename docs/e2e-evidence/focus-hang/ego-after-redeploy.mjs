// ego-browser: 重新部署后 live 验证 —— 过门禁后反复点 textarea，看 hang 是否消失
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const TOKEN = "REDACTED_TOKEN";
const N = 12;
const task = await taskSpace("focus-hang-after-redeploy");
const page = task.page("p1");
function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3000)),
  ]);
}
async function enter() {
  try { await page.goto(URL_, { waitUntil: "commit", timeout: 15000 }); } catch {}
  await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
  try { await page.reload({ waitUntil: "commit", timeout: 15000 }); } catch {}
  await page.waitForSelector("#textInput", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(900);
}
async function clickTA() { try { await page.click("#textInput", { timeout: 2000 }); } catch {} }

let hang = 0;
for (let i = 1; i <= N; i++) {
  await enter();
  if (!(await alive())) { hang++; console.log(`  #${i}: 进入即卡`); continue; }
  await clickTA();
  await page.waitForTimeout(600);
  const ok = await alive();
  if (!ok) hang++;
  console.log(`  #${i}: ${ok ? "正常" : "卡死"}`);
}
console.log(`\n>>> 重新部署后 live 点 textarea ${N} 轮：卡死 ${hang}/${N}`);
await task.finish({ keep: [] });
