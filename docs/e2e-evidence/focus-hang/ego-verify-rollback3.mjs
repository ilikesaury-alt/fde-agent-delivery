// 最终轻量复验：新标签页、domcontentloaded、不点击 textarea（规避已知 focus-hang）
const task = await taskSpace("final verify new UI no interaction");
const page = await task.newPage();

await page.goto("https://meeting-digest.ilikesaury.workers.dev/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);

const r = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  return {
    title: document.title,
    is1101: document.documentElement.outerHTML.includes("Error 1101"),
    isNewUI: !!ta && /30,000|生成日报|工作台|就绪/.test(document.body.innerText),
    hasCounter: /0 \/ 30,000/.test(document.body.innerText),
    hasShortcut: /Ctrl/.test(document.body.innerText),
    hasDarkBadge: /就绪/.test(document.body.innerText),
  };
});
console.log(JSON.stringify(r, null, 2));

try {
  await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/rollback-verify-new-ui.png", fullPage: false });
  console.log("screenshot: ok");
} catch (e) {
  console.log("screenshot: skipped (" + e.message.split("\n")[0] + ")");
}
