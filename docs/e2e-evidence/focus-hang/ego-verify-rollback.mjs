// 验证线上 meeting-digest 已恢复为新工作台 UI（rollback 到 d204bb4e）
const task = await taskSpace("verify meeting-digest new UI restored");
const page = task.page("p1");

const results = {};

// 1. 页面加载
await page.goto("https://meeting-digest.ilikesaury.workers.dev/", { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(1500);

results.status = "loaded";
results.title = await page.evaluate(() => document.title);
results.url = page.url();

// 2. 判断是新 UI 还是旧 UI / 1101
results.checks = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  return {
    is1101: /Error 1101/i.test(document.body ? document.body.innerText : "") || html.includes("Error 1101"),
    hasTextInput: !!document.querySelector("#textInput, textarea"),
    hasTailwind: !!document.querySelector('link[href*="assets/"][href$=".css"], style[data-vite-dev-id]') ||
      /--color-canvas|--tw-|tailwind/.test(html),
    bodyPreview: (document.body ? document.body.innerText : "").slice(0, 300),
  };
});

// 3. 截图留证
await page.screenshot({ path: "H:/Work/Projects/Personal/fde-agent-delivery/docs/e2e-evidence/focus-hang/rollback-verify-new-ui.png", fullPage: false });

console.log(JSON.stringify(results, null, 2));
