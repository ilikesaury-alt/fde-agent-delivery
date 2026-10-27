# 隧道方案 A（quick tunnel 手动启动）

> **解决的问题**：线上 Worker 的 `MAGPIE_BASE_URL` 指向 cloudflared **临时隧道**，
> 而临时隧道每次启动都换域名 → 域名一变，线上生成功能就 503。
> 本目录脚本把「启动隧道 + 解析新域名 + 同步进各产品 Worker secret」合成一次双击。

## 两个入口

| 双击这个 | 作用 |
|---|---|
| **`启动隧道.bat`** | 建立隧道 + 同步两个产品的 secret |
| **`查状态.bat`** | 只看状态，不启动任何东西 |

## 怎么用（启动）

**双击 `启动隧道.bat`**。它会：

1. 探活本机 magpie（`127.0.0.1:3425`）
2. 已有 cloudflared 在跑 → **复用**（不重复开隧道）；否则新开一条
3. 从日志解析出 `https://xxx.trycloudflare.com`
4. 写入 `tunnel-url.txt`
5. 把 `<域名>/v1` 同步进**两个** Worker 的 `MAGPIE_BASE_URL` secret
6. 显示当前域名与同步结果

### 会有两个窗口

| 窗口 | 能否关闭 |
|---|---|
| **cloudflared 窗口**（实时打印隧道日志） | ❌ **不能关，关掉隧道就断** |
| 启动脚本窗口（显示同步结果） | ✅ 可关 |

cloudflared 那个窗口就是「隧道存活」最直接的证据——它在，隧道就在。

## 怎么查看隧道是否存活

**双击 `查状态.bat`**，一次显示六项：

```
隧道状态  2026-10-27 11:50:12
──────────────────────────────────────────────────────────
[OK]  cloudflared 进程         运行中 (PID 19444)
[OK]  当前隧道域名             https://xxx.trycloudflare.com （写入于 10-27 11:26）
[OK]  本机 magpie (3425)       正常 (HTTP 200)
[OK]  隧道出网可达             通 (401=缺鉴权，说明隧道+网关都活着)
[OK]  产品2 内容工作台          在线 (HTTP 200)
[OK]  产品1 会议日报            在线 (HTTP 200)
──────────────────────────────────────────────────────────
结论：隧道与两个产品均正常
```

判读表：

| 显示 | 含义 | 怎么办 |
|---|---|---|
| `cloudflared 进程 = 未运行` | 隧道没起 | 双击 `启动隧道.bat` |
| `隧道出网可达 = 不通` | 进程在但已断连 | 关掉 cloudflared 窗口后重新启动 |
| `本机 magpie = 无响应` | 网关没起，隧道通也没用 | 先启动你的 magpie |
| 只有产品项异常、其他全 OK | secret 指向旧域名 | 跑 `fix-tunnel-secret.ps1` |

持续盯着看（每 5 秒刷新）：
```powershell
powershell -File tools/status-tunnel.ps1 -Watch
```

## 共用同一条隧道

两个产品都指向同一个本机 magpie，所以共用一条隧道：

| 产品 | Worker | 构建目录（secret 命令在这跑） |
|---|---|---|
| 产品② 内容工作台 | `content-studio` | `product2/dist/ssr` |
| 产品① 会议日报 | `meeting-digest` | `product1/dist/ssr` |

新增产品：在 `start-tunnel.ps1` 里往 `$targets` 加一行（名字 → 构建目录），
并把名字加进 `$Workers` 默认值即可。

## 其他用法

| 场景 | 命令 |
|---|---|
| 只启动、不动 secret | `powershell -File tools/start-tunnel.ps1 -NoSync` |
| 只同步指定产品 | `powershell -File tools/start-tunnel.ps1 -Workers content-studio` |
| 单独修某一个产品的 secret | `powershell -File tools/fix-tunnel-secret.ps1 -Worker meeting-digest` |
| 指定域名修 secret | `powershell -File tools/fix-tunnel-secret.ps1 -Url https://new-xxx.trycloudflare.com` |
| 当前域名 | 文件 `tools/tunnel-url.txt` |

## 前置条件（缺一不可）

1. **本机 magpie 网关在跑**：`http://127.0.0.1:3425/v1/models` 返回 200 或 401。
   隧道只负责把本机端口暴露出去，网关没起来隧道通了也没用。
2. **两个产品的 `dist/ssr` 存在**（同步 secret 要在这两个目录跑 wrangler）：
   `cd product1; node node_modules/vite/bin/vite.js build`
   `cd product2; node node_modules/vite/bin/vite.js build`
3. **wrangler 已 OAuth 登录**：`npx wrangler whoami` 能看到账号。

## 四个必须知道的坑（都实测过）

1. **secret 生效有 10~20 秒窗口期**：`secret put` 成功后立刻访问，Worker 可能仍用旧域名 → 拿到一次失败。
   实测：切换后立即生成失败，等约 20 秒再试成功。**切换后不要马上判死。**
2. **Windows PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8**：脚本含中文时必须存成 **UTF-8 BOM**，
   否则报「字符串缺少终止符」。本目录 `.ps1` 均已带 BOM。
3. **`.bat` 里写中文路径容易被当转义**：`tools\tunnel-url.txt` 的 `\t` 会变制表符。
   所以 `.bat` 用纯 ASCII 提示，中文只放在 `.ps1` 里。
4. **PowerShell 函数必须定义在调用之前**——它是顺序解析的，放文件末尾会报
   「无法将 xxx 识别为 cmdlet」。（本项目踩过一次。）

## 局限（这就是为什么叫方案 A）

| 局限 | 说明 |
|---|---|
| 电脑关机/休眠 → **两个产品同时** 503 | 整条链路依赖你本机 |
| 重启后域名会变 | 双击启动脚本会自动同步；同步完成前的访问会失败一次 |
| cloudflared 窗口被误关 → 隧道断 | 这是有意的可见性设计；重开即可 |
| 多开隧道风险 | 手动又启动一次可能产生两条隧道、两个域名；脚本已做「复用已有进程」检测 |

**长期方案**：换公网模型 API（如 `https://api.deepseek.com/v1`），
一条 `wrangler secret put MAGPIE_BASE_URL --name <worker>` 即可切换，
之后隧道、magpie、本机全部退出链路，两个产品各自独立。
