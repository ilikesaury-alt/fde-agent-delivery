// ego-browser: 真机探测线上是否可访问 + 当前页面状态
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const task = await taskSpace("check-live");
const page = task.page("p1");
try {
  const resp = await page.goto(URL_, { waitUntil: "commit", timeout: 20000 });
  console.log("HTTP 状态:", resp ? resp.status() : "无");
  console.log("最终 URL:", page.url());
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({
    title: document.title,
    bodyText: (document.body.innerText || "").slice(0, 200),
    hasApp: !!document.querySelector("#app"),
    hasTextInput: !!document.querySelector("#textInput"),
  }));
  console.log("页面信息:", JSON.stringify(info));
} catch (e) {
  console.log("访问失败:", e.message.split("\n")[0]);
}
// 抓网络层错误
try {
  const evs = await page.events();
  const netErr = (evs || []).filter(e => /loadingFailed|ERR_|net::/i.test(JSON.stringify(e)));
  console.log("网络错误事件数:", netErr.length);
  netErr.slice(0, 5).forEach(e => console.log("  " + JSON.stringify(e).slice(0, 200)));
} catch {}
await task.finish({ keep: [] });
