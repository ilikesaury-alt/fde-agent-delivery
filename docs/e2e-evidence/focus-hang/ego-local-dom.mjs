// ego-browser: 检查本地页面 hydration 后 DOM 状态 + 抓 console/pageerror
const URL_ = "http://127.0.0.1:8899/";
const task = await taskSpace("focus-hang-local-dom");
const page = task.page("p1");

const logs = [];
// ego 没有 page.on，用 events() 收集；但先做一次交互后再取。
// 这里用 evaluate 直接检查 DOM 与 React 状态。

await page.goto(URL_, { waitUntil: "commit", timeout: 12000 });
await page.waitForTimeout(2500); // 给 hydration 时间

const dom = await page.evaluate(() => {
  const ta = document.querySelector("#textInput");
  const app = document.querySelector("#app");
  return {
    hasTextInput: !!ta,
    textInputTag: ta ? ta.tagName : null,
    appChildCount: app ? app.children.length : -1,
    bodyTextSample: (document.body.innerText || "").slice(0, 120),
    hasReactRoot: !!document.querySelector("[data-reactroot]") || !!app,
    scripts: [...document.querySelectorAll("script[type=module]")].map(s => s.src || "(inline)"),
  };
});
console.log("DOM 状态:", JSON.stringify(dom, null, 2));

// 尝试聚焦/点击（用坐标或 evaluate 直接 focus）
try {
  const ok = await page.evaluate(() => {
    const ta = document.querySelector("#textInput");
    if (!ta) return "no-textarea";
    ta.focus();
    return "focused:" + (document.activeElement === ta);
  });
  console.log("直接 focus 结果:", ok);
} catch (e) { console.log("focus err:", e.message.split("\n")[0]); }

await page.waitForTimeout(800);
// 探活
const alive = await Promise.race([
  page.evaluate(() => 1 + 1).then(() => true).catch(() => false),
  new Promise((r) => setTimeout(() => r(false), 3000)),
]);
console.log("探活:", alive ? "正常" : "卡死");

// 抓事件（console/pageerror）
try {
  const evs = await page.events();
  const interesting = (evs || []).filter(e => /pageerror|exception|console|error|warning/i.test(JSON.stringify(e)));
  console.log(`\n=== 事件 ${interesting.length} ===`);
  interesting.slice(0, 20).forEach(e => console.log("  " + JSON.stringify(e).slice(0, 300)));
} catch (e) { console.log("events err:", e.message.split("\n")[0]); }

await task.finish({ keep: [] });
