<#
  隧道常驻启动器（方案 A）
  ---------------------------------------------------------------------------
  作用：拉起 cloudflared quick tunnel 指向本机 magpie，解析出域名，
        写入 tunnel-url.txt，并把新域名同步进各产品的 Worker secret。

  多个产品共用一条隧道（都指向同一个本机 magpie 3425）：
        content-studio  ← 产品② 内容工作台
        meeting-digest  ← 产品① 会议日报
  新增产品时只需往 -Workers 里加一个名字，并在下文 $targets 里给出它的构建目录。

  用法：
    .\start-tunnel.ps1                     启动并同步所有产品 secret
    .\start-tunnel.ps1 -NoSync             启动但不动 secret
    .\start-tunnel.ps1 -Workers content-studio   只同步指定产品（逗号分隔可多个）
    .\start-tunnel.ps1 -Port 3425          指定本机端口

  前置：本机 magpie 网关在跑；wrangler 已登录；各产品 dist/ssr 已构建。
#>
[CmdletBinding()]
param(
  [int]$Port = 3425,
  [string[]]$Workers = @("content-studio", "meeting-digest"),
  [switch]$NoSync
)

$ErrorActionPreference = "Stop"

# --- 每个产品跑 wrangler 的目录（secret 命令要在其 dist/ssr 下执行）---
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$targets = @{
  "content-studio" = Join-Path $root "..\product2\dist\ssr"
  "meeting-digest" = Join-Path $root "..\product1\dist\ssr"
}

# --- 同步 secret（定义提前：PowerShell 需先定义后调用）---
function Sync-Secret {
  param([string]$Url, [string[]]$WorkerNames)

  $base = "$Url/v1"
  $ok = 0
  $failed = @()

  foreach ($w in $WorkerNames) {
    $distDir = $targets[$w]
    $resolved = if ($distDir) { Resolve-Path $distDir -ErrorAction SilentlyContinue } else { $null }

    if (-not $resolved) {
      Write-Host "[!] $w ：找不到构建目录（$distDir），跳过" -ForegroundColor Yellow
      $failed += $w
      continue
    }

    Write-Host "[*] $w ：MAGPIE_BASE_URL = $base"
    Push-Location $resolved
    try {
      $out = $base | npx wrangler secret put MAGPIE_BASE_URL --name $w 2>&1
      $tail = ($out | Select-Object -Last 3) -join ' '
      if ($out -match "Success") {
        Write-Host "    [+] 成功" -ForegroundColor Green
        $ok++
      } else {
        Write-Host "    [x] 失败：$tail" -ForegroundColor Red
        $failed += $w
      }
    } catch {
      Write-Host "    [x] 异常：$($_.Exception.Message)" -ForegroundColor Red
      $failed += $w
    } finally {
      Pop-Location
    }
  }

  Write-Host ""
  if ($failed.Count -eq 0) {
    Write-Host "[+] 全部 $ok 个 Worker secret 已更新（约 10~20 秒生效）" -ForegroundColor Green
  } else {
    Write-Host "[!] 成功 $ok 个，失败 $($failed.Count) 个：$($failed -join ', ')" -ForegroundColor Yellow
    Write-Host "    单独重试：.\fix-tunnel-secret.ps1 -Worker <名字>" -ForegroundColor Yellow
  }
}

$cloudflared = Join-Path $root "cloudflared\cloudflared.exe"
$urlFile = Join-Path $root "tunnel-url.txt"
$logFile = Join-Path $root "tunnel.log"

if (-not (Test-Path $cloudflared)) {
  Write-Host "[x] 找不到 cloudflared.exe: $cloudflared" -ForegroundColor Red
  exit 1
}

# --- 前置：本机网关是否在跑（隧道通了但对端没服务，照样 503）---
try {
  $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  Write-Host "[+] 本机网关正常（HTTP $($probe.StatusCode)）" -ForegroundColor Green
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -eq 401) {
    Write-Host "[+] 本机网关正常（401 = 缺鉴权，服务在线）" -ForegroundColor Green
  } else {
    Write-Host "[!] 警告：http://127.0.0.1:$Port 无响应，隧道连上后调用仍会失败" -ForegroundColor Yellow
    Write-Host "    请先启动 magpie 网关。" -ForegroundColor Yellow
  }
}

Write-Host "[*] 待同步产品：$($Workers -join ', ')"

# --- 已在跑就复用，避免开出两条隧道（两条隧道=两个域名，只有一条生效）---
$existing = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[!] 已有 cloudflared 进程（PID: $($existing.Id -join ', ')）" -ForegroundColor Yellow
  if (Test-Path $urlFile) {
    $old = (Get-Content $urlFile -Raw).Trim()
    if ($old) {
      Write-Host "[i] 复用现有域名: $old"
      if (-not $NoSync) { Sync-Secret -Url $old -WorkerNames $Workers }
      exit 0
    }
  }
  Write-Host "[!] 找不到已知域名，将再启动一条（可能产生两条隧道）" -ForegroundColor Yellow
}

# --- 启动隧道 ---
Write-Host "[*] 启动 quick tunnel -> http://127.0.0.1:$Port"
if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }

$cfArgs = @(
  "tunnel", "--url", "http://127.0.0.1:$Port",
  "--http-host-header", "127.0.0.1:$Port",
  "--no-autoupdate", "--logfile", $logFile, "--loglevel", "info"
)
$proc = Start-Process -FilePath $cloudflared -ArgumentList $cfArgs -PassThru -WindowStyle Hidden
Write-Host "[+] cloudflared PID = $($proc.Id)"

# --- 等待域名出现（最多 45s）---
$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $logFile) {
    $m = Select-String -Path $logFile -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
  if ($proc.HasExited) {
    Write-Host "[x] cloudflared 已退出（exit $($proc.ExitCode)），请看 $logFile" -ForegroundColor Red
    exit 1
  }
}

if (-not $url) {
  Write-Host "[x] 45s 内未解析出域名，请看 $logFile" -ForegroundColor Red
  exit 1
}

Set-Content -Path $urlFile -Value $url -Encoding ascii
Write-Host "[+] 隧道域名: $url" -ForegroundColor Green

if (-not $NoSync) {
  Sync-Secret -Url $url -WorkerNames $Workers
}

Write-Host ""
Write-Host "[+] 完成。隧道独立运行，关闭本窗口不影响。" -ForegroundColor Green
Write-Host "    日志: $logFile"
Write-Host "    域名: $urlFile"
Write-Host "    产品: $($Workers -join ' / ')"
