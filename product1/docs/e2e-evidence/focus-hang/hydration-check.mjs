// 验证水合是否正常：对比 SSR HTML 与客户端渲染后的 DOM，检查 fiber key 覆盖率
const task = await taskSpace("hydration-check");
const page = task.page("p1");
const log = (o) => console.log(JSON.stringify(o));

const BASE = "http://127.0.0.1:8899/";
const TOKEN = "test-token-local";

// 1. 先拿 SSR 原始 HTML（禁用 JS）
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", { urls: ["*.js"] });
await page.goto(BASE, { waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1200);
const ssr = await page.evaluate(() => {
  const ta = document.querySelector("#textInput");
  return {
    bodyLen: document.body.innerHTML.length,
    html: document.body.innerHTML.slice(0, 4000),
    hasTA: !!ta,
    elements: document.querySelectorAll("*").length,
    commentNodes: (() => { let c = 0; const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT); while (w.nextNode()) c++; return c; })(),
    commentData: (() => { const out = []; const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT); let n; while ((n = w.nextNode())) out.push(n.data); return out; })(),
  };
});
log({ step: "SSR_HTML", hasTA: ssr.hasTA, elements: ssr.elements, commentNodes: ssr.commentNodes, commentData: ssr.commentData });

// 2. 恢复 JS，重新加载，检查 fiber key 覆盖率
await page.cdp("Network.setBlockedURLs", { urls: [] });
await page.reload({ waitUntil: "load", timeout: 25000 }).catch(() => {});
await page.waitForSelector("#textInput", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);

const hyd = await page.evaluate(() => {
  const all = [...document.querySelectorAll("*")];
  const keysFound = {};
  let withFiber = 0;
  let withProps = 0;
  for (const el of all) {
    let f = false, p = false;
    for (const k of Object.keys(el)) {
      if (k.startsWith("__reactFiber$")) { f = true; keysFound[k] = (keysFound[k] || 0) + 1; }
      if (k.startsWith("__reactProps$")) p = true;
    }
    if (f) withFiber++;
    if (p) withProps++;
  }
  const ta = document.querySelector("#textInput");
  const taKeys = ta ? Object.keys(ta).filter((k) => k.startsWith("__react")) : [];
  // 检查 body 上的 react container key
  const bodyKeys = Object.keys(document.body).filter((k) => k.startsWith("__react"));
  const appKeys = document.querySelector("#app") ? Object.keys(document.querySelector("#app")).filter((k) => k.startsWith("__react")) : [];
  return {
    totalElements: all.length,
    elementsWithFiberKey: withFiber,
    elementsWithPropsKey: withProps,
    fiberKeyNames: Object.keys(keysFound),
    textareaReactKeys: taKeys,
    bodyReactKeys: bodyKeys,
    appReactKeys: appKeys,
    bodyChildren: [...document.body.childNodes].map((n) => n.nodeType + ":" + (n.nodeName || "")),
    bodyHTML: document.body.innerHTML.slice(0, 1200),
  };
});
log({ step: "HYDRATED", ...hyd });

console.log("done");
