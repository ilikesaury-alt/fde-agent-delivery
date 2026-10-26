// 列出关键节点上的事件监听器（纯 CDP 路径）
const task = await taskSpace("enumerate-listeners2");
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

function findNode(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children || []) { const f = findNode(c, pred); if (f) return f; }
  if (node.contentDocument) { const f = findNode(node.contentDocument, pred); if (f) return f; }
  return null;
}

const targets = [
  ["#document", (n) => n.nodeType === 9],
  ["html", (n) => n.nodeName === "HTML"],
  ["body", (n) => n.nodeName === "BODY"],
  ["#app", (n) => (n.attributes || []).some((a) => a.name === "id" && a.value === "app")],
  ["textarea#textInput", (n) => (n.attributes || []).some((a) => a.name === "id" && a.value === "textInput")],
];

for (const [label, pred] of targets) {
  const node = findNode(root, pred);
  if (!node) { log({ label, err: "node-not-found" }); continue; }
  try {
    const { object } = await page.cdp("DOM.resolveNode", { nodeId: node.nodeId });
    const r = await page.cdp("DOMDebugger.getEventListeners", { objectId: object.objectId, depth: 2, pierce: true });
    const ls = (r && r.listeners) || [];
    log({ label, count: ls.length, listeners: ls.map((x) => ({ type: x.type, capture: x.useCapture, passive: x.passive, line: x.lineNumber, col: x.columnNumber })) });
  } catch (e) {
    log({ label, err: String(e.message).split("\n")[0] });
  }
}
console.log("done");
