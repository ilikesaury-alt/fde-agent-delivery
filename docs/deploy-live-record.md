# 线上部署记录（产品① · 真实可用）

**状态：已上线且真实可用** ✅（2026-10-23）

## 访问信息

| 项 | 值 |
|----|-----|
| **线上地址** | https://meeting-digest.ilikesaury.workers.dev |
| **访问令牌** | `REDACTED_TOKEN` |
| Worker | `meeting-digest` |
| Version ID | `9ff7d341-ff29-4ffb-b660-ee4986c21f8c` |
| 上游网关 | https://tahoe-mainland-selection-cigarette.trycloudflare.com/v1 |
| 模型 | `auto/deepseek-v4.1-flash` |

## 网页使用

1. 打开线上地址
2. 首次会显示「访问令牌」输入框 → 粘贴上面的令牌 → 保存（存在本浏览器 localStorage）
3. 粘贴会议文本 → 生成日报 → 一键复制

## API 调用

```bash
curl -X POST https://meeting-digest.ilikesaury.workers.dev/api/digest \
  -H "Authorization: Bearer REDACTED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"你的会议记录..."}'
```

## 线上验证矩阵（全部 PASS）

| 用例 | 期望 | 实际 | 结果 |
|------|------|------|------|
| GET /api/health | 200 | 200 | ✅ |
| GET / 页面 | 200 | 200 | ✅ |
| 无令牌 POST | 401 | 401 | ✅ |
| 错误令牌 POST | 401 | 401 | ✅ |
| 带令牌 + 空输入 | 400 | 400 | ✅ |
| 带令牌 + 超长 | 413 | 413 | ✅ |
| **带令牌 + 真实会议** | 200 + 6 板块 | **200 / 4.4s / 6 板块齐全** | ✅ |

## 真实生成输出（线上实测）

```markdown
## 会议主题
项目复盘会，围绕 v2.0 延期、支付流程 P0 bug 修复及设计稿定稿安排展开。

## 时间与参会人
- 时间：2026年10月22日
- 参会人：陈明（PM）、刘芳（设计）、周杰（开发）

## 核心结论
- v2.0 延期到11月中旬。
- 优先修复支付流程的3个 P0 bug。
- 设计稿本周五前定稿。

## 待办事项

| 事项 | 负责人 | 截止 |
|---|---|---|
| 修复支付 bug | 周杰 | 10月25日 |
| 出设计稿定稿 | 刘芳 | 10月24日 |
| 同步客户延期 | 陈明 | 10月23日 |

## 遗留问题与风险
- 测试资源不足，可能影响回归覆盖。

## 一句话摘要
会议确认 v2.0 延期至11月中旬，并明确了支付 P0 bug 修复、设计稿定稿与客户延期同步的责任人和截止时间，同时提示测试资源不足的风险。
```

## 架构链路

```
浏览器（含 localStorage 令牌）
  → Cloudflare Worker
     ├─ 校验 ACCESS_TOKEN（401 拦截）
     ├─ 校验输入（空 400 / 超长 413）
     ├─ 调 MAGPIE_BASE_URL
     └─ 校验 6 板块（缺失则重试一次，仍缺 502）
        ↓ HTTPS
  → Cloudflare Tunnel（tahoe-mainland-selection-cigarette.trycloudflare.com）
        ↓
  → 本机 magpie 网关 127.0.0.1:3425
     ├─ 校验 Gateway key（Bearer）
     └─ 路由 auto/deepseek-v4.1-flash
```

## ⚠️ 临时方案，会失效

| 依赖 | 失效条件 |
|------|----------|
| 隧道临时域名 | cloudflared 重启/断网 → **域名变** |
| 本机 magpie | 电脑关机/休眠 → **调不通** |
| Gateway key | 在 magpie 删除/轮换 |

### 域名变了怎么修

1. 重启隧道：
   ``bash
   tools\cloudflared\cloudflared.exe tunnel --url http://127.0.0.1:3425 --http-host-header 127.0.0.1:3425
   ``
2. 记下新域名，更新 Worker secret：
   ``bash
   cd product1/dist/ssr
   wrangler secret put MAGPIE_BASE_URL
   ``
3. **无需改代码、无需重新部署**（secret 立即生效）

### ⚠️ 部署时务必带 --secrets-file

```bash
cd product1
npx vite build
cd dist/ssr
wrangler deploy --secrets-file <path-to-secrets.env>
```

**否则 secrets 会被清空**（本次踩过：不带 --secrets-file 部署后只剩 env.ASSETS，所有 env 丢失）。

## 长期方案（建议）

改用公网模型 API（如 DeepSeek 官方 `https://api.deepseek.com/v1`），
magpie 仅本地开发用。Worker 不再依赖本机在线和临时隧道。

## 安全措施

| 层 | 措施 |
|----|------|
| Worker | `ACCESS_TOKEN` 校验，无令牌/错令牌 401 |
| magpie | Gateway key 校验（Bearer） |
| magpie | 「允许的地址」留空（隧道源 IP 不固定，填了会挡掉隧道） |