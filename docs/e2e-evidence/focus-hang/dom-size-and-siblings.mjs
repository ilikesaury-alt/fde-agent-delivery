// 量化 DOM 规模 + textarea 祖先链的 previousSibling 数量
// 验证 React fm() 为何要遍历 33 秒
const task = await taskSpace("dom-size-and-siblings");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

await page.goto(BASE, { waitUntil: "commit", timeout: 25000 }).catch(() => {});
await page.evaluate((t) => { try { localStorage.setItem("md_token", t); } catch {} }, TOKEN);
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

const r = await page.evaluate(() => {
  const ta = document.querySelector("#textInput");
  const all = document.querySelectorAll("*").length;

  // 全文档节点数（含文本/注释）
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ALL);
  let total = 0, comments = 0, texts = 0;
  const commentSamples = {};
  while (walker.nextNode()) {
    total++;
    const n = walker.currentNode;
    if (n.nodeType === 8) { comments++; const d = n.data; commentSamples[d] = (commentSamples[d] || 0) + 1; }
    else if (n.nodeType === 3) texts++;
  }

  // textarea 祖先链：每层数 previousSibling 个数
  const chain = [];
  let cur = ta;
  let level = 0;
  while (cur && level < 12) {
    let sibs = 0;
    let s = cur.previousSibling;
    while (s) { sibs++; s = s.previousSibling; }
    chain.push({
      level,
      tag: cur.nodeType === 1 ? cur.tagName.toLowerCase() + (cur.id ? "#" + cur.id : "") + (cur.className && typeof cur.className === "string" ? "." + cur.className.split(" ").slice(0, 2).join(".") : "") : "node" + cur.nodeType,
      prevSiblings: sibs,
      childNodes: cur.childNodes ? cur.childNodes.length : 0,
      parent: cur.parentNode ? (cur.parentNode.nodeType === 1 ? cur.parentNode.tagName.toLowerCase() : "node" + cur.parentNode.nodeType) : null,
    });
    cur = cur.parentNode;
    level++;
  }

  // 所有元素中 childNodes 最多的
  const heaviest = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.childNodes.length > 50) {
      heaviest.push({ tag: el.tagName.toLowerCase(), id: el.id, cls: (typeof el.className === "string" ? el.className : "").slice(0, 40), kids: el.childNodes.length });
    }
  }
  heaviest.sort((a, b) => b.kids - a.kids);

  return {
    elements: all, totalNodes: total, textNodes: texts, commentNodes: comments,
    topComments: Object.entries(commentSamples).sort((a, b) => b[1] - a[1]).slice(0, 8),
    ancestorChain: chain,
    heaviestContainers: heaviest.slice(0, 8),
    bodyHTMLlen: document.body.innerHTML.length,
  };
});

log(r);
console.log("done");
