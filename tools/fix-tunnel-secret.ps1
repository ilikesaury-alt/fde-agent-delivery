<#
  隧道域名变了？一条命令修好（方案 A 配套）
  ---------------------------------------------------------------------------
  场景：电脑重启 / 断网重连后 quick tunnel 换了域名，线上生成功能 503。
        本脚本把新域名同步进 Worker secret（无需重新部署代码）。

  用法：
    powershell -ExecutionPolicy Bypass -File fix-tunnel-secret.ps1
        从 tools\tunnel-url.txt 读取域名
    powershell -ExecutionPolicy Bypass -File fix-tunnel-secret.ps1 -Url https://new-xxx.trycloudflare.com
        直接用给定域名
    powershell -ExecutionPolicy Bypass -File fix-tunnel-secret.ps1 -Worker other-worker
        指定 Worker 名（默认 content-studio）
#>
[CmdletBinding()]
param(
  [string]$Url,
  [string]$Worker = "content-studio"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$urlFile = Join-Path $root "tunnel-url.txt"
$distDir = Join-Path $root "..\product2\dist\ssr"

if (-not $Url) {
  if (-not (Test-Path $urlFile)) {
    Write-Host "[x] 没传 -Url，且 $urlFile 不存在。" -ForegroundColor Red
    Write-Host "    请先跑 start-tunnel.ps1，或手动传入域名。" -ForegroundColor Red
    exit 1
  }
  $Url = (Get-Content $urlFile -Raw).Trim()
}

# 归一化：去掉 /v1 与尾斜杠
$Url = $Url -replace '/v1/?$', ''
$Url = $Url.TrimEnd('/')

if (-not $Url) {
  Write-Host "[x] 域名为空" -ForegroundColor Red
  exit 1
}

$base = "$Url/v1"
Write-Host "[*] Worker : $Worker"
Write-Host "[*] 新上游: $base"

# 先探测域名是否真通（带 key 探测更准，但 key 不在脚本里；至少确认能连上）
try {
  $r = Invoke-WebRequest -Uri "$base/models" -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  Write-Host "[+] 域名可达，HTTP $($r.StatusCode)" -ForegroundColor Green
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -eq 401) {
    Write-Host "[+] 域名可达（401 = 缺鉴权，说明隧道与网关都正常）" -ForegroundColor Green
  } else {
    Write-Host "[!] 探测未通过: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "    仍继续写入 secret（可能是网络策略导致本地探测失败）" -ForegroundColor Yellow
  }
}

if (-not (Test-Path $distDir)) {
  Write-Host "[x] 找不到 $distDir，请先构建：" -ForegroundColor Red
  Write-Host "    cd product2; node node_modules/vite/bin/vite.js build" -ForegroundColor Red
  exit 1
}

Push-Location $distDir
try {
  $base | npx wrangler secret put MAGPIE_BASE_URL --name $Worker 2>&1 |
    Select-Object -Last 4 | ForEach-Object { Write-Host "    $_" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "[+] secret 已更新（立即生效，无需重新部署代码）" -ForegroundColor Green
Write-Host "    注意：secret 生效有几秒窗口期，立刻访问可能仍拿到旧域名的失败结果，等 10~20 秒再试。"
Write-Host "    自测：https://$Worker.ilikesaury.workers.dev"
