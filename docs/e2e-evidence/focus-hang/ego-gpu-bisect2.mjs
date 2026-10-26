// ego-browser: 缩短版 GPU 二分（每组 4 轮，短超时，快速取信号）
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const N = 4;
const task = await taskSpace("focus-hang-gpu-bisect2");
const page = task.page("p1");
function alive() {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 2500)),
  ]);
}
async function clickTA() { try { await page.click("#textInput", { timeout: 2000 }); } catch {} }
async function group(label, disableGpu) {
  let hang = 0;
  for (let i = 1; i <= N; i++) {
    try {
      await page.goto(URL_, { waitUntil: "commit", timeout: 12000 });
      await page.waitForSelector("#textInput", { timeout: 10000 });
      if (disableGpu) await page.cdp("Emulation.setGpuThrottlingMode", { mode: "enabled" }).catch(() => {});
      await page.waitForTimeout(800);
      await clickTA();
      await page.waitForTimeout(500);
      const ok = await alive();
      if (!ok) hang++;
      console.log(`  ${label} #${i}: ${ok ? "正常" : "卡死"}`);
    } catch (e) { hang++; console.log(`  ${label} #${i}: 异常`); }
  }
  console.log(`  >>> ${label}: ${hang}/${N}`);
  return hang;
}
const a = await group("原样(A)", false);
const b = await group("关GPU(B)", true);
console.log(`\nA=${a}/${N} B=${b}/${N}  ${b < a ? "GPU合成疑似元凶" : "GPU合成非主因"}`);
await task.finish({ keep: [] });
