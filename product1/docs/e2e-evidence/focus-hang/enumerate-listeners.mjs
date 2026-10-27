// 直接向浏览器要真相：列出 document / window / body / #app 上挂的所有事件监听器
const task = await taskSpace("enumerate-listeners");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

await page.cdp("DOM.enable");
await page.cdp("DOMDebugger.enable").catch(() => {});
const { root } = await page.cdp("DOM.getDocument", { depth: -1 });

async function listenersOf(nodeId, label) {
  try {
    const r = await page.cdp("DOMDebugger.getEventListeners", { objectId: (await page.cdp("DOM.resolveNode", { nodeId })).object.objectId });
    return r;
  } catch (e) { return { err: String(e.message).split("\n")[0] }; }
}

// 更简单：在页面里用 getEventListeners 拿不到（那是 devtools 专有），
// 改用 CDP 对每个节点取 objectId 再查监听器
const targets = [
  ["document", () => document],
  ["window", () => window],
  ["body", () => document.body],
  ["#app", () => document.querySelector("#app")],
  ["html", () => document.documentElement],
];

for (const [label, getter] of targets) {
  try {
    const objId = await page.evaluateHandle(getter);
    // evaluateHandle 返回 RemoteObject
    const oid = objId && (objId.objectId || (objId.result && objId.result.objectId) || objId);
    if (!oid) { log({ label, err: "no objectId", raw: typeof objId }); continue; }
    const r = await page.cdp("DOMDebugger.getEventListeners", { objectId: oid, depth: 1, pierce: true });
    const ls = (r && r.listeners) || [];
    log({
      label,
      count: ls.length,
      listeners: ls.map((x) => ({
        type: x.type,
        useCapture: x.useCapture,
        passive: x.passive,
        once: x.once,
        script: x.scriptId,
        line: x.lineNumber,
        col: x.columnNumber,
      })),
    });
  } catch (e) {
    log({ label, err: String(e.message).split("\n")[0] });
  }
}
console.log("done");
