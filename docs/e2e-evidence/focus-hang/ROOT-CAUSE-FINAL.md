# focus-hang 最终根因报告（第一性原理，2026-10-26）

> **结论：已定位、已修复、已上线验证。根因是我们自己的代码 —— `pages/layout.tsx` 返回了 `<html>/<head>/<body>`，违反 Void Pages 约定，导致 SSR 水合错位，React 每次聚焦表单控件都要走 fiber 反查兜底路径，阻塞主线程 15–31 秒。**

## 一、为什么之前查不出来（方法论错误）

之前几轮排查得出过两个错误结论，根因都是**测量手段不可靠**：

| 错误结论 | 错在哪 |
|---|---|
| 「`evaluate(()=>1+1)` 能跑通 = hang 消失」 | 1101 错误页上 `evaluate` 照样能跑，被骗过 |
| 「截图 CDP 超时 = 渲染进程卡死」 | **实测极简 `data:text/html,<h1>hello</h1>` 页面截图同样超时** → 这是 ego-browser 环境限制，与代码无关 |
| 「差异在运行时（Node shim vs workerd）」 | 用 longtask 探针一测：**本地 shim 同样 30.5s**，与运行时无关 |
| 「header 的 backdrop-blur / sticky 是元凶」 | **去掉页面全部 CSS 后仍 30.8s**，与样式无关 |

**教训**：判断「卡死」必须用**能区分故障层次**的探针：
- `evaluate` 不需帧 → 只能测主线程是否阻塞
- `requestAnimationFrame` 计数 → 测是否产帧
- `PerformanceObserver({entryTypes:["longtask"]})` → **测主线程阻塞时长（本次关键）**
- `Profiler` → 测具体哪个函数在烧 CPU

## 二、决定性实验链

| # | 实验 | 结果 | 排除 |
|---|---|---|---|
| 1 | rAF 探针 + 极简 `data:` 页 | 极简页也停帧(1fps)但主线程正常 | 排除 React/Tailwind/Void |
| 2 | longtask 探针测线上 | **30,927ms 单个长任务**，之后自行恢复 | 确认是主线程阻塞，非死锁 |
| 3 | 本地 shim 同代码 | **30,568ms** | 排除 workerd / 部署 / 运行时 |
| 4 | 移除页面**全部 CSS** | **30,765ms** | 排除所有样式（含 backdrop-blur） |
| 5 | CDP 拦截 `*.js` | **0ms** | 确认是 JS |
| 6 | CDP Profiler 采样 | `fm()` 自耗 33,560ms | 锁定函数 |
| 7 | 调用树分析 | `yh→Kf→Wt→fm` | 锁定调用链 |
| 8 | DOM 规模 | 仅 55 元素 / 85 节点 | 排除 DOM 过大 |
| 9 | 列出 body 监听器 | 142 个（React 17+ 事件委托），含 `focusin` capture | 确认走 React 事件系统 |
| 10 | 水合结构检查 | **`<meta>/<title>` 出现在 `#app` 内**，`<!--html--><!--head--><!--body-->` 注释标记 | **找到根因** |

## 三、根因机制

### 3.1 代码错误
`product1/pages/layout.tsx` 返回了完整文档外壳：

```tsx
return (
  <html lang="zh-CN">
    <head>…<title>…</title></head>
    <body>{children}</body>
  </html>
);
```

**但 Void Pages 的 layout 约定是返回 fragment**（`<>{children}</>`），文档外壳由 Void 自己管理。Void 文档 `docs/guide/pages-routing/layouts.md` 的官方示例就是：

```tsx
// pages/layout.tsx
export default function Layout({ children }) {
  return <><nav/><main>{children}</main></>;   // ← fragment，不是 <html>
}
```

### 3.2 实际产生的坏 DOM
Void 把 layout 返回值挂到自己的根容器 `<div id="app">` 内，于是：

```html
<div id="app" data-hydrated="true">
  <meta charset="utf-8">          ← 本应在 <head>
  <title>会议日报…</title>        ← 本应在 <head>
  <meta name="description" …>
  <!--$--><!--html--><!--head--><!--body-->   ← html/head/body 被压成注释
  <div class="flex min-h-screen…">
```

### 3.3 为什么这会让聚焦卡 30 秒
React 的事件委托挂在 `document`（capture）。聚焦表单控件时触发 `focusin`，React 需要从 DOM 节点反查对应的 fiber：

```js
// Wt = getClosestInstanceFromNode
function Wt(e){
  if(t=e[Pt]) return t;              // ① O(1) 缓存命中 —— 但这里没命中
  for(var n=e.parentNode; n;){        // ② 沿父链上溯
    if(t=n[It]||n[Pt]){
      if(t.alternate, t.child!==null || …)
        for(e=fm(e); e!==null;){      // ④ 兜底：遍历 previousSibling
          if(n=e[Pt]) return n;
          e=fm(e)
        }
```

因为 DOM 结构（html/head/body 被拍平进 div）与 React fiber 树**对不上**，第 ① 步缓存无法命中，落入 ④ 的 `previousSibling` 遍历兜底。该路径被**反复调用上万次**（Profiler 采样命中 `fm` 10,042 次），累计阻塞主线程 15–31 秒。

这也解释了全部观测现象：
- 只有**表单控件**触发（只有它们走 `focusin` 的 `Wt` 反查路径）
- 与 CSS 无关（是 DOM 树结构问题，不是样式）
- 与运行时无关（是客户端水合问题）
- 极简页不会中招（无 React）
- 会自行恢复（遍历最终能结束，不是死锁）

## 四、修复

### 4.1 `pages/layout.tsx` → 返回 fragment
```tsx
export default function RootLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;   // 只保留引入 styles.css
}
```

### 4.2 head 元数据迁移到正确位置
- `void.config.ts` 增加站点级 `head`（titleTemplate / htmlAttrs.lang / meta）
- 新增 `pages/index.server.ts` 用 `defineHead()` 设置页面标题

## 五、修复验证

### 5.1 结构层面
| 指标 | 修复前 | 修复后 |
|---|---|---|
| `<!--html-->/<!--head-->/<!--body-->` 注释标记 | 3 个 | **0 个** |
| `#app` 内残留 `<meta>` | 是 | **否** |
| body 上 React key | 有（错位） | 无（正常） |
| `#app` 上 `__reactContainer$` | 有 | 有（正常挂载点） |

### 5.2 性能层面（本地 shim，同一批脚本）
| 场景 | 修复前 | 修复后 |
|---|---|---|
| 聚焦 React textarea | 15,651ms | **0ms** |
| 聚焦运行时插入的普通 textarea | 15,495ms | **0ms** |
| 聚焦普通 input | 15,309ms | **0ms** |
| 聚焦 React button | 0ms | 0ms |
| **20 轮连续点击 textarea** | 偶发卡死 | **0/20 卡死，最大长任务 0ms** |

### 5.3 线上端到端（真机 ego-browser）
版本 `a62f2e7f-e93b-4d96-a50f-1a81eb2cd867`：

| 检查 | 结果 |
|---|---|
| Error 1101 | ❌ 无 |
| 页面标题 | 会议日报 — 原始记录转结构化纪要 |
| `#app` 内 meta | ❌ 无 |
| `GET /api/health` | 200 `{"ok":true,"service":"meeting-digest","maxInputChars":30000}` |
| 点击 textarea | 221ms，最大长任务 **0ms** |
| 真实 LLM 生成 | **6 板块 + 1 表格，517 字符，17.5 秒** |
| 日报内容 | 主题/时间参会人/核心结论/待办表格全部正确，忠于原文 |
| 全程长任务 | 仅 1 个 115ms（LLM 结果渲染，正常） |

## 六、遗留的环境限制（与代码无关）

以下三条是 **ego-browser / 沙箱环境**的独立限制，不是产品缺陷，已实测确认：

1. **`page.screenshot` 恒超时**：连 `data:text/html,<h1>hello</h1>` 也超时 → headless 窗口合成器不产帧。**不要再把截图超时当作卡死证据。**
2. **`vite dev` 起不来**：miniflare 需 spawn workerd，沙箱禁止。
3. **沙箱内直连 workers.dev 失败**：`fetch` 出站受限；但 **wrangler 的 API（deployments/versions/secret/rollback）可正常走通**。

## 七、可复用的方法论沉淀

1. **判断"卡死"先分层**：主线程阻塞 / 不产帧 / CDP 通道 / 进程崩溃，四者用不同探针区分，不要混用。
2. **`Page.captureScreenshot` 超时 ≠ 渲染进程卡死**，可能只是窗口不产帧。
3. **对照实验必须做到底层**：极简 `data:` 页 + 移除全部 CSS + 拦截 JS，三步就能把问题锁到 JS/DOM/CSS 之一。
4. **`longtask` + `Profiler` 组合**是定位「主线程被谁占用」的最快路径。
5. **SSR 框架要严格遵守 layout 约定**：返回完整 `<html>` 到「挂到 div 内」的框架里，必然水合错位。这类 bug 不报错、不崩，只在特定交互下以性能问题形式暴露，极难排查。

## 八、脚本索引（本目录）

| 脚本 | 用途 |
|---|---|
| `hypothesis-split.mjs` | rAF + timer 探针，区分死循环/不产帧 |
| `control-minimal.mjs` | 极简 `data:` 页对照，排除项目代码 |
| `control-trigger-matrix.mjs` | 触发条件矩阵（CDP点击/DOM focus/非表单元素） |
| `app-block-duration.mjs` | 量化 longtask 时长（线上） |
| `local-shim-longtask.mjs` | 本地 shim 对照 |
| `bisect-css-vs-js.mjs` | 移除全部 CSS 对照 |
| `bisect-js-disabled.mjs` | 拦截 `*.js` 对照 |
| `profile-long-task.mjs` / `profile-calltree.mjs` | CDP Profiler 定位到具体函数与调用链 |
| `bisect-focus-target.mjs` | 焦点目标矩阵（React/非React、表单/非表单） |
| `enumerate-listeners2.mjs` | 列出 body 上 142 个 React 事件监听器 |
| `hydration-check.mjs` | **水合结构对比（定位根因的关键脚本）** |
| `verify-fix-quant.mjs` | 修复后 20 轮量化复测 |
| `live-final-verify.mjs` | 线上端到端最终验证 |
