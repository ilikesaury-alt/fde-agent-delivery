#Requires -Version 5.1
<#
  隧道状态检查（随时可跑，不启动任何东西）
  ---------------------------------------------------------------------------
  输出四件事：cloudflared 进程 / 当前域名 / 本机网关 / 线上两个产品是否可用。

  用法：
    double-click  查状态.bat
    powershell -File tools/status-tunnel.ps1
    powershell -File tools/status-tunnel.ps1 -Watch     每 5 秒刷新（Ctrl+C 退出）
#>
[CmdletBinding()]
param([switch]$Watch)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$urlFile = Join-Path $root "tunnel-url.txt"
$workers = @(
  @{ Name = "content-studio"; Label = "产品2 内容工作台" },
  @{ Name = "meeting-digest"; Label = "产品1 会议日报" }
)

function Get-Status {
  $lines = @()
  $ok = $true

  # 1) cloudflared 进程
  $procs = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
  if ($procs) {
    foreach ($p in $procs) {
      $lines += @{ Label = "cloudflared 进程"; Value = "运行中 (PID $($p.Id))"; Ok = $true }
    }
  } else {
    $lines += @{ Label = "cloudflared 进程"; Value = "未运行"; Ok = $false }
    $ok = $false
  }

  # 2) 当前域名
  $url = $null
  if (Test-Path $urlFile) {
    $url = (Get-Content $urlFile -Raw).Trim()
  }
  if ($url) {
    $age = ""
    $mtime = (Get-Item $urlFile).LastWriteTime
    $age = "（写入于 $($mtime.ToString('MM-dd HH:mm'))）"
    $lines += @{ Label = "当前隧道域名"; Value = "$url $age"; Ok = $true }
  } else {
    $lines += @{ Label = "当前隧道域名"; Value = "缺失（tunnel-url.txt 不存在）"; Ok = $false }
    $ok = $false
  }

  # 3) 本机网关
  $gwOk = $false
  $gwText = "无响应"
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:3425/v1/models" -TimeoutSec 4 -UseBasicParsing -ErrorAction Stop
    $gwOk = $true; $gwText = "正常 (HTTP $($r.StatusCode))"
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 401) { $gwOk = $true; $gwText = "正常 (401=缺鉴权，服务在线)" }
  }
  $lines += @{ Label = "本机 magpie (3425)"; Value = $gwText; Ok = $gwOk }
  if (-not $gwOk) { $ok = $false }

  # 4) 隧道能否穿到本机（用 /v1/models 看是否 401 = 隧道通、网关在）
  if ($url) {
    $tunOk = $false; $tunText = "不可达"
    try {
      $r = Invoke-WebRequest -Uri "$url/v1/models" -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
      $tunOk = $true; $tunText = "通 (HTTP $($r.StatusCode))"
    } catch {
      $code = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -eq 401) { $tunOk = $true; $tunText = "通 (401=缺鉴权，说明隧道+网关都活着)" }
      else { $tunText = "不通：$($_.Exception.Message)" }
    }
    $lines += @{ Label = "隧道出网可达"; Value = $tunText; Ok = $tunOk }
    if (-not $tunOk) { $ok = $false }
  }

  # 5) 线上产品
  foreach ($w in $workers) {
    $healthUrl = "https://$($w.Name).ilikesaury.workers.dev/api/health"
    $wOk = $false; $wText = "不可达"
    try {
      $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
      $wOk = $true; $wText = "在线 (HTTP $($r.StatusCode))"
    } catch {
      $wText = "异常：$($_.Exception.Message)"
    }
    $lines += @{ Label = $w.Label; Value = $wText; Ok = $wOk }
  }

  return @{ Lines = $lines; AllOk = $ok }
}

function Show-Status {
  Clear-Host
  Write-Host ""
  Write-Host "  隧道状态  $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))" -ForegroundColor Cyan
  Write-Host "  $('─' * 58)"
  $s = Get-Status
  foreach ($l in $s.Lines) {
    $mark = if ($l.Ok) { "[OK]  " } else { "[!!]  " }
    $color = if ($l.Ok) { "Green" } else { "Red" }
    Write-Host ("  {0}{1,-22} {2}" -f $mark, $l.Label, $l.Value) -ForegroundColor $color
  }
  Write-Host "  $('─' * 58)"
  if ($s.AllOk) {
    Write-Host "  结论：隧道与两个产品均正常" -ForegroundColor Green
  } else {
    Write-Host "  结论：有异常项（看红字）。修复：跑 tools\启动隧道.bat 重新建立隧道" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "  提示：CLOUDFLARED 窗口存在 = 隧道进程活着；关掉它隧道就断。" -ForegroundColor DarkGray
  Write-Host ""
}

if ($Watch) {
  while ($true) { Show-Status; Start-Sleep -Seconds 5 }
} else {
  Show-Status
  Write-Host "  （窗口可关闭）" -ForegroundColor DarkGray
}
