// ego-browser: 真机确认线上可访问性（修正版）
const URL_ = "https://meeting-digest.ilikesaury.workers.dev/";
const task = await taskSpace("check-live2");
const page = task.page("p1");
// 用 fetch 在页面上下文里打，能拿到真实 HTTP 状态
try {
  await page.goto("about:blank");
  const r = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { method: "GET", cache: "no-store" });
      const text = await res.text();
      return { ok: res.ok, status: res.status, len: text.length, head: text.slice(0, 160) };
    } catch (e) { return { error: String(e) }; }
  }, URL_);
  console.log("线上 HTTP:", JSON.stringify(r));
} catch (e) { console.log("evaluate err:", e.message.split("\n")[0]); }
// 再用真实导航看页面 DOM
try {
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(2000);
  const dom = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    hasApp: !!document.querySelector("#app"),
    hasTextInput: !!document.querySelector("#textInput"),
    body: (document.body.innerText || "").slice(0, 160),
  }));
  console.log("页面 DOM:", JSON.stringify(dom));
} catch (e) { console.log("导航失败:", e.message.split("\n")[0]); }
await task.finish({ keep: [] });
