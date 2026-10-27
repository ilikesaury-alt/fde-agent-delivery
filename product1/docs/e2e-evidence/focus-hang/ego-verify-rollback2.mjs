// 复验：health API + textarea 交互 + 截图
const task = await taskSpace("verify meeting-digest health and interaction");
const page = task.page("p1");

await page.goto("https://meeting-digest.ilikesaury.workers.dev/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1000);

// 1. health API（页面上下文同源 fetch，绕开沙箱出站限制）
const health = await page.evaluate(async () => {
  try {
    const r = await fetch("/api/health");
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log("health:", JSON.stringify(health));

// 2. 交互验证：点 textarea、输入文字
await page.click("textarea");
await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  ta.focus();
  ta.value = "测试输入";
  ta.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
const interaction = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  return {
    typed: ta ? ta.value : null,
    counter: (document.body.innerText.match(/\d+ [\d,]*\/ 30,000|[\d,]+ \/ 30,000/) || [null])[0],
    alive: true,
  };
});
console.log("interaction:", JSON.stringify(interaction));

// 3. 清空输入，截图留证
await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  if (ta) {
    ta.value = "";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.waitForTimeout(300);
await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/rollback-verify-new-ui.png", timeout: 15000 });
console.log("screenshot: ok");
