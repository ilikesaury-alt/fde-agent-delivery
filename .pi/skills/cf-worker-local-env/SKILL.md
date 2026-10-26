---
name: cf-worker-local-env
description: Cloudflare Workers 本地开发与部署的环境约束与踩坑清单。当在受限沙箱（无法 spawn 子进程）、Windows 环境、或使用 Void/Vite + wrangler 部署 Worker 时使用，避免重复踩已知的环境坑。
license: MIT
metadata:
  author: lic-notebook
  tags: [cloudflare, workers, wrangler, void, deployment, windows]
  source: 2026-10-23 首次上线 + 2026-10-26 1101 事故复盘
---

# cf-worker-local-env — Cloudflare Workers 环境约束

## 何时用
- 在 Cloudflare Workers 上开发/部署，尤其是 Void / Vite + wrangler 组合
- 本地起不来 dev server（`vite dev` / `wrangler dev` 失败）
- 部署后线上报 **Error 1101**（Worker threw exception）
- 需要更新 secrets 但不想重新部署代码

## 何时不用
- 纯前端项目（无 Worker）
- 使用 Cloudflare Pages 静态托管（无 Worker 运行时）

---

## 第 0 步：环境能力自检（必做，先跑再决定路线）

**不要假设沙箱限制。** 先实测三件事：

```bash
# ① 能否 spawn 子进程（决定 node --test / vite dev 是否可用）
node -e "require('child_process').spawn(process.execPath,['-e','1']).on('exit',c=>console.log('spawn ok',c))"

# ② workerd 能否启动（决定 wrangler dev 是否可用）
npx wrangler dev --port 8787   # 看是否 ERR_RUNTIME_FAILURE / CreateDirectory 拒绝访问

# ③ 出站网络（决定能否直连线上验证）
curl -sI https://api.cloudflare.com --max-time 10
```

**实测结论（2026-10-26 本机）**：
- `spawn` 在 `danger-full-access` 下**可用**（此前误以为必然 EPERM，绕了远路）
- `vite dev` **失败**：miniflare 需 spawn `workerd`，且 `miniflare-email-store` 目录 `CreateDirectory #5 拒绝访问`
- `fetch('https://xxx.workers.dev')` **直连失败**（出站受限）
- **但 wrangler 的 API 调用全部可用**（deployments / versions / secret / rollback 走 `api.cloudflare.com`）

> 这一条很重要：**线上验证不能直连 workers.dev，但完全可以用 wrangler 管理命令 + ego-browser 浏览器通道。**

---

## 本地开发（workerd 起不来时的替代方案）

用纯 Node 跑 Vite 构建的 SSR bundle，绕开 workerd：

```bash
# ① 构建
npx vite build

# ② 用 Node HTTP 直接跑 dist/ssr/index.js（SSR + 静态资源）
node --import ./e2e/bootstrap.mjs e2e/server.mjs 8899
```

**坑（全部踩过）**：

1. **`.env` 带 BOM** → `source .env` 时变量名变成 `\ufeffMAGPIE_BASE_URL`，注入失败，
   Worker 启动即报 `Env validation failed: MAGPIE_BASE_URL is required but missing`，页面无内容。
   检查：`grep -c $'\xef\xbb\xbf' .env`；修法：`sed -i '1s/^\xEF\xBB\xBF//' .env` 或用 node 读时 `.replace(/^\uFEFF/,"")`。
2. **端口 8899 常被旧 shim 进程占用**，且 Git Bash 无 `pkill`：
   ```bash
   netstat -ano | findstr ":8899"      # 拿 PID
   node -e "process.kill(<PID>,'SIGKILL')"
   ```
3. **`dist` 可能被别的项目构建产物污染** → 重新构建前 `rm -rf dist`。

---

## 部署（关键，1101 事故教训）

### 事故复盘：Error 1101 的真实原因

**2026-10-26 部署后线上 1101 打不开。** 排查结论（比对 `~/.wrangler/logs` 两次部署）：

| 维度 | 好版本 | 坏版本 |
|---|---|---|
| Worker 模块 | 上传 | 同名同 hash，**字节完全一致** |
| secrets / handlers / bindings | 齐全 | 齐全，完全一致 |
| **静态资产上传** | **8 文件 / 289KB** | **0 文件（跳过）** |
| assets upload API | 3 次 `POST /workers/assets/upload` | **完全没有** |

**根因**：该次部署跳过了静态资产上传。Worker 配置是 `run_worker_first: ["/**"]`
（所有请求先过 Worker，Worker 再从 `env.ASSETS` 取资产），资产没绑对 → 每次请求读 ASSETS 抛异常 → 1101。

> 这也解释了为什么探活 `evaluate(()=>1+1)` 在 1101 错误页上还能跑通 —— 骗过了排查。

### 部署铁律（写死）

1. **部署后必须验证资产绑定**：
   ```bash
   wrangler versions view <version-id> --name <worker>
   # 必须看到：Binding env.ASSETS  Assets
   ```
2. **检查部署日志里的资产上传行**：
   ```bash
   grep -E "assetUploadFileCount|Total Upload" ~/.wrangler/logs/wrangler-<时间>.log
   # assetUploadFileCount 为 0 时警惕（除非确认资产无变化）
   ```
3. **首次部署必须带 `--secrets-file`**（Worker 不存在时无法预先 `secret put`）
4. **不要在没有 assets 上传成功的日志下认定部署成功**

---

## 更新 secrets 而不重新部署

`wrangler secret put` 会要求先部署，报错提示用 `versions secret put`：

```bash
# ① 创建新版本（含新 secret，但不部署）
wrangler versions secret put MAGPIE_BASE_URL --name <worker> --message "切换隧道" < /tmp/value.txt

# ② 确认新版本资产绑定正确
wrangler versions view <new-version-id> --name <worker>

# ③ 一次性部署代码 + 资产 + secrets
wrangler deploy --config dist/ssr/wrangler.json --secrets-file .secrets.json --name <worker>
```

**参数坑**：
- `versions secret put` **没有 `-m` 短参数**，必须写 `--message`
- 值从 **stdin** 读，用 `< file` 重定向；`printf '%s' "值" | wrangler ...` 也可
- `--secrets-file` 支持 JSON 或 .env 格式；**omitted secrets 不会被删除**（additive）

---

## 回滚

```bash
wrangler deployments list --name <worker>     # 找目标版本 ID
wrangler rollback <version-id> --name <worker> --message "原因" -y
```

**坑**：`rollback` 必须给**完整 version ID**（短 ID 会报 `could not be found`，code 100146）。
`versions view` 同样要求完整 ID。

**教训**：回滚前先确认目标版本是**你要的那个**。本次曾回滚到当天第一个版本（旧 UI），
而不是最近的好版本（新 UI），导致「UI 变回旧版」。

---

## 验收标准（写死）

1. `wrangler versions view <新版本>` 显示 `env.ASSETS  Assets` 绑定
2. 部署日志有 `assetUploadFileCount > 0`（或确认资产确实无变化）
3. 线上 `/api/health` 返回 200
4. 页面 `document.body.innerText` **不含** "Error 1101"
5. secrets 数量与预期一致（`wrangler secret list`）

---

## 边界（明确不做什么）

- **不在沙箱内直连 `*.workers.dev` 做验证**——出站受限，用 wrangler 命令 + ego-browser
- **不假设 `spawn` 一定不可用**——先跑第 0 步自检
- **不在 assets 上传异常时硬认定部署成功**
- **不用 `evaluate(()=>1+1)` 判断线上是否正常**——错误页也能跑通
