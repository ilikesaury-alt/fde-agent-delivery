---
name: perf-hang-triage
description: 页面/应用"卡死、卡顿、无响应"的分层诊断。当浏览器自动化（ego-browser/Playwright）操作超时、页面点击无反应、截图超时，或用户报"点一下就卡住"时使用。核心是先判定故障在哪一层（主线程阻塞 / 不产帧 / CDP 通道 / 进程崩溃），再选对应探针，禁止逐个排除假设。
license: MIT
metadata:
  author: lic-notebook
  tags: [debugging, performance, browser, triage, longtask]
  source: 2026-10-26 focus-hang 排查复盘（17 个脚本 → 真正有效 5 个）
---

# perf-hang-triage — 卡死问题分层诊断

## 何时用
- 浏览器自动化操作超时：`page.click` / `page.screenshot` / `page.goto` 抛 `CDP request timed out`
- 页面"点了没反应"、输入框聚焦后卡住
- 用户报"偶发卡死"，但代码看不出死循环

## 何时不用
- 明确的功能 bug（报错、白屏、接口 500）→ 直接看日志
- 已确定是网络/后端问题

---

## 核心原则（本 Skill 的全部价值）

**先选观测工具，再设计实验。** 不要问"可能是 CSS 吗？可能是运行时吗？"，然后为每个问题造一个脚本。
先问"我要测的量是什么"，答案通常只有一个工具组合。

**排除法的每个分支都要付固定成本。** 当单次实验耗时 2–4 分钟（含等阻塞恢复）时，
逐个排除 6 个假设 = 20 分钟；直接定位 = 5 分钟。**只有当直接定位不可行时才用排除法。**

---

## 第 1 步：分层判定（必做，一个脚本搞定）

四种故障性质完全不同，用不同探针区分。**不要混用**。

| 层 | 判据 | 探针 |
|---|---|---|
| **H1 主线程阻塞** | `setInterval` 停、`evaluate` 超时、`longtask` 有长条目 | `PerformanceObserver({entryTypes:["longtask"]})` |
| **H2 不产帧** | `rAF` 计数停，但 `evaluate` 和 `setInterval` 正常 | `requestAnimationFrame` 计数器 |
| **H3 CDP 通道** | 所有命令都超时，但浏览器进程健康 | 换新 page / 重启浏览器 |
| **H4 真死循环** | CPU 100%、`longtask` 永不结束、页面不恢复 | 进程 CPU 采样 |

### 判据脚本骨架（照抄即可）

```js
// 装双探针：rAF（需帧）+ setInterval（纯定时器，不需帧）
await page.evaluate(() => {
  window.__frames = 0; window.__ticks = 0;
  const tick = () => { window.__frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => { window.__ticks++; }, 100);
  window.__lt = [];
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
});

// 采样两次，算 fps / ticks / longtask
const a = await page.evaluate(() => ({ f: __frames, t: __ticks }));
await page.waitForTimeout(1000);
const b = await page.evaluate(() => ({ f: __frames, t: __ticks, lt: __lt }));
```

**判读**：
- `fps≈0` + `ticks>0` → **H2 不产帧**（合成器问题，非代码）
- `fps≈0` + `ticks≈0` + `lt` 有长条目 → **H1 主线程阻塞**（继续第 2 步）
- `evaluate` 直接超时但浏览器活着 → 继续观察是否自行恢复

> ⚠️ **关键陷阱：`evaluate` 能跑通不代表页面正常。**
> 错误页（如 Cloudflare 1101）上 `evaluate(()=>1+1)` 照样成功。
> 必须同时检查 `document.body.innerText` 是否含 "Error" 等错误页特征。

> ⚠️ **关键陷阱：`page.screenshot` 超时 ≠ 渲染进程卡死。**
> 实测极简 `data:text/html,<h1>hello</h1>` 页面截图同样超时（headless 窗口合成器不产帧）。
> **永远不要用截图超时作为"卡死"的证据。**

---

## 第 2 步：确认是 H1 后，直接上 Profiler（不要逐个排除）

**这是最容易走错的一步。** 不要依次试「是不是 CSS」「是不是运行时」「是不是 DOM 太大」——
**一个 Profiler 就告诉你答案**。

```js
await page.cdp("Profiler.enable");
await page.cdp("Profiler.setSamplingInterval", { interval: 200 });
await page.cdp("Profiler.start");
// …触发卡死的操作…
const { profile } = await page.cdp("Profiler.stop");
```

**分析要点**（ego-browser 的 cdp 返回结构可能不同，注意 `r.profile || r`）：

```js
// ① self time：哪个函数自己烧时间
// ② total time（沿 parent 累加）：哪个函数是总根因
// ③ 调用树：把 fm 节点的祖先链打出来，一行就看出问题
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parentOf.set(c, n.id);
// 从叶子往上走，拼成 "yh(15.2s) → Kf(14.6s) → Wt(13.2s) → fm(11.6s)"
```

**判读**：
- 单个函数 self time 巨大 + sample 命中上万次 → **该函数被反复调用**（不是单次慢）
- 这是找"循环调用"的关键信号：单次慢是数据量问题，反复调用是逻辑/结构问题

---

## 第 3 步：分治定位（仅当 Profiler 指向框架内部、看不出业务原因时）

用 3 个对照实验把问题锁到 **JS / CSS / DOM** 之一。**顺序固定，不要跳**：

| 实验 | 做法 | 若长任务消失说明 |
|---|---|---|
| **A. 拦截 JS** | `Network.setBlockedURLs({urls:["*.js"]})` | 问题在 JS |
| **B. 移除全部 CSS** | 删 `link[rel=stylesheet]` + 所有 `style` | 问题在样式 |
| **C. 极简对照页** | `data:text/html,<textarea>` | 与本项目代码无关（环境问题） |

> **A 必须排在第一个**。本次排查中「移除全部 CSS 后仍 30.8s」直接排除了所有样式假设，
> 而如果先做 C（极简页），会因极简页也有轻微停帧而误判为"环境问题"。

---

## 第 4 步：框架内部函数 → 查约定（本次真正根因所在）

Profiler 指向 React 内部函数（`fm`/`Wt`/`Kf` 这类混淆名）时，**不要在源码里找 bug**，
而是问：**这个框架在这个项目里是否被正确使用？**

### 本次真实案例（必读，同类问题通用）

**现象**：聚焦 textarea 后主线程阻塞 15–31 秒，Profiler 指向 `fm()` 自耗 11.6s、命中 10,042 次。
**调用链**：`yh`(事件派发) → `Kf`(props 分发) → `Wt`(DOM反查fiber) → `fm`(遍历 previousSibling)

**根因**：`pages/layout.tsx` 返回了 `<html><head><body>`，而 **Void Pages 约定 layout 必须返回 fragment**
（文档外壳由框架管理）。框架把 layout 输出挂进 `<div id="app">`，导致：
- `<meta>/<title>` 出现在 `#app` 里
- `html/head/body` 被压平成注释 `<!--html--><!--head--><!--body-->`
- **SSR 水合错位** → React 反查 fiber 时缓存永不命中 → 落入兜底遍历 → 反复调用上万次

**修复**：layout 返回 `<>{children}</>`，head 移到 `void.config.ts` + `defineHead()`。

### 这类问题的通用特征（记住这个模式）

- 不报错、不崩溃、不影响加载 → **只在特定交互下以性能问题形式暴露**
- 只影响**表单控件聚焦**（只有它们走 `focusin` 委托路径）
- 会自行恢复（遍历最终能结束，不是死锁）
- 与 CSS、与运行时（Node vs workerd）**都无关**

### 诊断脚本（关键，一个脚本定位根因）

```js
// 对比 SSR 原始 HTML 与水合后的 DOM，检查结构是否错位
// 判据：① #app 内是否出现 <meta>/<title>
//       ② 是否有 <!--html--><!--head--><!--body--> 注释标记
//       ③ 元素上的 __reactFiber$ 覆盖率
const ssr = await page.evaluate(() => document.body.innerHTML);  // 先禁用 JS 取 SSR
const hydrated = await page.evaluate(() => ({
  appContainsMeta: !!document.querySelector("#app meta"),
  htmlHeadBodyComments: (document.documentElement.outerHTML.match(/<!--html-->|<!--head-->|<!--body-->/g) || []).length,
}));
```

---

## 输入输出

**输入**：一个能复现卡死的 URL/页面 + 触发动作（点击什么、聚焦什么）
**输出**：故障层（H1–H4）+ 具体函数/结构 + 根因 + 修复验证数据

---

## 边界（明确不做什么）

- **不做无 Profiler 的逐个假设排除**——那是本次耗时过长的主因
- **不用截图超时当作卡死证据**——极简页也超时
- **不用 `evaluate` 能跑通当作页面正常**——错误页也能跑通
- **不在框架内部函数上找源码 bug**——先查框架使用约定是否被违反
- **不在偶发问题上下"改了就好"的结论**——偶发问题单次"正常"可能只是幸运，必须多次量化（建议 ≥20 轮）

---

## 验收标准（写死，不达标不算完成）

1. **定位到具体层**：明确说是 H1/H2/H3/H4 哪一层，不接受"可能是渲染问题"这种模糊结论
2. **H1 必须有 Profiler 证据**：给出函数名 + self/total time + 调用链
3. **修复前后有量化对比**：同一脚本、同一操作，给出 before/after 的具体毫秒数
4. **复测 ≥20 轮**：偶发问题单轮通过不算修复
5. **根因解释全部观测现象**：如果某个历史观测无法用该根因解释，说明根因未找全

---

## 踩过的坑（本次实录，务必看）

1. **17 个实验脚本，真正有效只有 5 个**。浪费在：hook `previousSibling` 时 `evaluate` 自己超时（数据全废）、验证一个自己提出的错误假设（窗口焦点）、用了不存在的 API 导致脚本作废重写。
2. **第 8 个实验才用 Profiler**，而它第一次跑就给出了函数名和调用链。**应该第 2 个就用。**
3. **用户提示"时间太长"后反而提了新假设**。正确反应是**立刻跳到信息量最高的实验**，而不是继续加假设。
4. **继承了前人报告里的错误结论**（"截图超时 = 渲染进程卡死"），花了很多时间才回到"截图超时不能证明任何事"。**接手排查时，先质疑前人结论的推理链。**
5. **本地 shim 的 `.env` 带 BOM** 导致环境变量注入失败、Worker 启动即报错、页面无 textarea。Windows 环境先 `grep -c $'\xef\xbb\xbf' .env` 检查。
