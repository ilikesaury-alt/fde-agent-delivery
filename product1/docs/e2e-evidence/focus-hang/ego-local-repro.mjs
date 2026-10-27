// ego-browser: 本地 shim server 复现 textarea hang（不依赖 live/代理，可确定性调试）
const URL_ = "http://127.0.0.1:8899/";
const ROUNDS = 5;

const task = await taskSpace("focus-hang-local");
const page = task.page("p1");

// ego 没有 page.on；用 page.events() 在最后收集。但 hang 时 events 也取不到，
// 所以这里用 CDP 直接挂 Runtime.exceptionThrown + consoleAPICalled。
const client = await task.cdp ? null : null;

function alive(label) {
  return Promise.race([
    page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
    new Promise((res) => setTimeout(() => res(false), 3500)),
  ]).then((ok) => { console.log(`  [alive:${label}] ${ok ? "正常" : "卡死→TIMEOUT"}`); return ok; });
}

async function clickTA() {
  try { await page.click("#textInput", { label: "点击 textarea（本地）" }); }
  catch (e) { console.log("  click err:", e.message.split("\n")[0]); }
}

for (let i = 1; i <= ROUNDS; i++) {
  console.log(`\n===== 本地 round ${i} =====`);
  await page.goto(URL_, { waitUntil: "commit", timeout: 20000 });
  await page.waitForSelector("#textInput", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  if (!(await alive("baseline"))) { console.log("  进入即卡，跳过"); continue; }
  await clickTA();
  await page.waitForTimeout(700);
  await alive("after-textarea-click");
  // 若还活着，尝试输入
  if (await alive("pre-fill")) {
    try { await page.fill("#textInput", "本地测试一行输入"); } catch (e) { console.log("  fill err:", e.message.split("\n")[0]); }
    await page.waitForTimeout(400);
    await alive("after-fill");
  }
}

// 收集页面事件（pageerror / console）
try {
  const evs = await page.events();
  const interesting = (evs || []).filter((e) => {
    const t = JSON.stringify(e);
    return /pageerror|exception|console|error/i.test(t);
  });
  console.log(`\n=== 页面事件（error 类 ${interesting.length}）===`);
  interesting.slice(0, 20).forEach((e) => console.log("  " + JSON.stringify(e).slice(0, 300)));
} catch (e) { console.log("  events err:", e.message.split("\n")[0]); }

await task.finish({ keep: [] });
