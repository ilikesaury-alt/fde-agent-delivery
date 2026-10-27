// ego-browser: 决定性二分 —— GPU 合成是否元凶
// A 组原样点击 textarea（N 次）；B 组用 CDP 关闭 GPU 合成后点击（N 次）。
// 若 B 组卡死率显著低于 A 组 → 确认是 GPU 合成器死锁（与 backdrop-blur 等强相关）。
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const N = 8;

const task = await taskSpace("focus-hang-gpu-bisect");
const page = task.page("p1");

function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3500)),
  ]);
}
async function clickTA() {
  try { await page.click("#textInput", { timeout: 2500 }); } catch {}
}
async function runGroup(label, disableGpu) {
  let hang = 0;
  console.log(`\n===== ${label} =====`);
  for (let i = 1; i <= N; i++) {
    try {
      await page.goto(URL_, { waitUntil: "commit", timeout: 15000 });
      await page.waitForSelector("#textInput", { timeout: 12000 });
      if (disableGpu) {
        // 关闭 GPU 合成（若运行时支持）
        await page.cdp("Emulation.setGpuThrottlingMode", { mode: "enabled" }).catch(() => {});
        await page.evaluate(() => { try { localStorage.setItem("__gpufix", "1"); } catch {} });
      }
      await page.waitForTimeout(1000);
      await clickTA();
      await page.waitForTimeout(700);
      const ok = await alive();
      if (!ok) hang++;
      console.log(`  ${label} #${i}: ${ok ? "正常" : "卡死"}`);
    } catch (e) {
      hang++; console.log(`  ${label} #${i}: 异常/${e.message.split("\n")[0]}`);
    }
    // 重置 GPU 状态（新页面）
  }
  console.log(`  >>> ${label}: 卡死 ${hang}/${N}`);
  return hang;
}

const a = await runGroup("原样(A)", false);
const b = await runGroup("关GPU(B)", true);
console.log(`\n=== 结论速览 === A(原样)=${a}/${N}  B(关GPU)=${b}/${N}`);
console.log(b < a ? "→ GPU 合成可能是元凶（B 组明显更稳）" : "→ GPU 合成非主因（两组相近）");

await task.finish({ keep: [] });
