# 线上部署记录 — 内容工作台（产品②）

> 日期：2026-10-27
> 环境：Cloudflare Workers（OAuth 登录，非 API Token）
> 部署方式：**wrangler 直连**（`void deploy` 需要 `CLOUDFLARE_API_TOKEN`，本机只有 OAuth）

## 部署目标

| 项 | 值 |
|---|---|
| Worker 名 | `content-studio` |
| URL | https://content-studio.ilikesaury.workers.dev |
| Version ID | `2ea32819-7bdd-459e-a374-8f79c8976ad1` |
| D1 数据库 | `content-studio-db` / `b3955476-b504-4b67-8fe8-b1e9cf35cc75`（region WNAM） |
| 上游 | cloudflared 临时隧道 → 本机 magpie `127.0.0.1:3425` |

## 部署链路（本次实际执行顺序）

```bash
# 1) 建库（全新 Worker，D1 列表原为空）
npx wrangler d1 create content-studio-db
#    → b3955476-b504-4b67-8fe8-b1e9cf35cc75

# 2) 应用 migration
npx wrangler d1 execute content-studio-db --remote --file=db/migrations/0001_init.sql

# 3) 构建（D1 绑定来自 void.config.ts 的 cloudflare 段）
node node_modules/vite/bin/vite.js build

# 4) 部署（必须带 --secrets-file，否则 secrets 会被清空）
cd dist/ssr
npx wrangler deploy --secrets-file ../../.secrets.json --name content-studio
```

## 部署核验（写死，缺一步不算成功）

| 核验项 | 结果 |
|---|---|
| `versions view` 含 `env.ASSETS` | ✅ |
| `versions view` 含 `env.DB` | ✅ |
| 资产上传数 > 0 | ✅ **8 files / 2.41 sec**（这正是产品① 1101 的根因所在，故必查） |
| `/api/health` | ✅ `{"ok":true,"service":"content-studio"}` |
| 页面非错误页 | ✅ 无 `Error 1101` / `Worker threw exception`；SSR 外壳正常 |
| 无令牌 `/api/jobs` | ✅ 401 `{"error":"访问令牌缺失或错误。"}` |
| 带令牌 `/api/jobs` | ✅ 200 `{"jobs":[]}`（首次为空，证明真 D1 已连通） |

## 线上端到端（真 D1 + 真上游流式）

| 项 | 结果 |
|---|---|
| 首 token 到达 | **8.4 s**（步骤进度覆盖等待期） |
| 整体完成 | **16.2 s** |
| 产出结构 | 3 标题 / 432 字正文 / 6 标签 |
| 标题 | 「内容工作台上线后，首次真实生成验证记录」 |
| 结构标记泄漏 | ✅ 无 |
| **真 D1 落库** | ✅ `jobs` 1 条，标题与页面一致 |
| 列表不带原文 | ✅ `sourceText` 不在列表项（SQL 层只取指定列生效） |

## 部署中踩到的坑（3 个都值得记）

1. **`void deploy --backend` 参数不存在**：v1.2.1 的选项是 `--platform <cloudflare|void>`。
   模板里 `"deploy": "void deploy --backend cloudflare --provision"` 是过期写法，已改。
2. **`void deploy` 需要 `CLOUDFLARE_API_TOKEN`**：只有 wrangler OAuth 时它会直接报
   「Cloudflare authentication is required」。→ 走 wrangler 直连（与产品① 一致）。
3. **`.void-wrangler.jsonc` 是生成物，手改无效**：它是 `void.config.ts` 的 `cloudflare` 段经
   `void migrate/deploy` 物化的产物。手改后 `vite build` 仍输出 `database_id: "local"` →
   部署会指向不存在的库。**权威源只能是 `void.config.ts`**。

## ⚠️ 本方案的失效条件（与产品①同）

| 依赖 | 失效条件 |
|---|---|
| 隧道域名 `quantities-bulk-characters-tales.trycloudflare.com` | cloudflared 重启/断网 → 域名变 |
| 本机 magpie（3425） | 电脑关机/休眠 → 生成功能 503 |
| Gateway key | 在 magpie 轮换 |

**域名变了怎么修**（无需改代码、无需重新部署）：
```bash
tools\cloudflared\cloudflared.exe tunnel --url http://127.0.0.1:3425 --http-host-header 127.0.0.1:3425
cd product2/dist/ssr
npx wrangler secret put MAGPIE_BASE_URL --name content-studio   # 粘新域名 + /v1
```

**长期方案**：换公网模型 API（如 DeepSeek 官方 `https://api.deepseek.com/v1`），
只更新 secret，Engine 不再依赖本机在线。

## 访问令牌

`ACCESS_TOKEN` 已设置（43 字符，`cs-` 前缀）。明文在 `product2/.secrets.json`（已 gitignore）。
页面右上角「访问令牌」输入框填写后记入 localStorage。
