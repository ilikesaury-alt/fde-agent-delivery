# 部署网络拓扑说明（产品①）

## 核心矛盾：本地网关 vs 边缘部署

| | E2E（本地） | 线上（Cloudflare Worker） |
|---|---|---|
| 代码运行位置 | 本机 | Cloudflare 边缘节点（全球） |
| `127.0.0.1:3425` 指向 | 本机 magpie 网关 ✅ | 该边缘节点自身 ❌ |

**结论**：Cloudflare Worker 无法访问本机 magpie。E2E 能跑通是因为代码也在本机执行。

## magpie 网关的保护机制（实测）

- 监听 `127.0.0.1:3425`，`lan: false`（仅本机）
- **Host 白名单**：非 localhost 类 Host 直接 403
- **转发头检测**：带 `X-Forwarded-For` / `Cf-Connecting-IP` 的请求（即经过隧道/代理的）
  被视为「来自另一台机器」，必须同时满足：
  1. Settings → Share on local network 开启
  2. 携带 Gateway key：`Authorization: Bearer <key>` 或 `x-api-key`

403 响应原文（magpie 自己返回的）：
> this request came through a proxy or tunnel (it carries a forwarding header such as
> X-Forwarded-For or Cf-Connecting-IP), so magpie answers it as one from another machine:
> only while Settings → Share on local network is on, with an enabled gateway key
> (Gateway → Gateway keys) sent as Authorization: Bearer <key> or x-api-key

## 方案 A：Cloudflare Tunnel（已尝试，需 magpie 侧配合）

```bash
cloudflared tunnel --url http://127.0.0.1:3425 --http-host-header 127.0.0.1:3425
```

- ✅ 隧道建立成功，Host 重写验证生效（用回显服务器确认收到 `127.0.0.1:3425`）
- ❌ magpie 仍 403，因为缺少 gateway key + Share on local network
- ⚠️ 临时域名，重启即变（`https://xxx.trycloudflare.com`）

**待办**：在 magpie UI 开启 Share on local network 并生成 Gateway key，然后：
- Worker `MAGPIE_BASE_URL` = 隧道地址
- Worker `MAGPIE_API_KEY` = Gateway key
- 我方代码已支持 `Authorization: Bearer`，无需改动

## 方案 C（推荐长期）：公网模型 API

用有公网端点 + key 认证的模型服务（如 DeepSeek 官方 API `https://api.deepseek.com/v1`），
magpie 仅本地开发用。优点：稳定、可长期、不依赖本机在线。

## 已加的安全措施

Worker 新增 `ACCESS_TOKEN` 可选校验（`routes/api/digest.ts` 的 `checkAccessToken`）：
- 配置后，`/api/digest` 必须带 `Authorization: Bearer <ACCESS_TOKEN>`
- 防止隧道暴露后他人白嫖 magpie 额度
- 35 项测试覆盖（含 6 项令牌用例）