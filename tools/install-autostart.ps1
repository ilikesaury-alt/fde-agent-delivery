<#
  注册「登录时自动启动隧道」（方案 A 的开机自启）
  ---------------------------------------------------------------------------
  两种方式，本脚本优先用不需要管理员权限的那种：

    ① 启动文件夹快捷方式（推荐，无需管理员）
       写入 %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\EgoTunnel.lnk
       登录后 Windows 自动执行 → 调 start-tunnel.ps1

    ② 任务计划程序（更可控，但创建 ONLOGON 任务常需管理员）
       失败时自动回退到 ①

  用法：
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Method task
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -RunNow
#>
[CmdletBinding()]
param(
  [ValidateSet("startup", "task")]
  [string]$Method = "startup",
  [switch]$Uninstall,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $root "start-tunnel.ps1"
$taskName = "EgoContentStudioTunnel"
$startupDir = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startupDir "EgoTunnel.lnk"

if (-not (Test-Path $startScript)) {
  Write-Host "[x] 找不到 $startScript" -ForegroundColor Red
  exit 1
}

function Remove-All {
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Host "[+] 已移除启动项 $lnkPath" -ForegroundColor Green }
  $q = schtasks /Query /TN $taskName 2>$null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "[+] 已移除计划任务 $taskName" -ForegroundColor Green }
  }
}

if ($Uninstall) {
  Remove-All
  exit 0
}

function Install-Startup {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
  $lnk.WorkingDirectory = $root
  $lnk.WindowStyle = 7   # 最小化
  $lnk.Description = "启动 content-studio 上游隧道并同步 Worker secret"
  $lnk.Save()
  Write-Host "[+] 已写入启动项：$lnkPath" -ForegroundColor Green
  Write-Host "    登录 Windows 后自动运行 start-tunnel.ps1。"
}

function Install-Task {
  $action = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
  schtasks /Create /TN $taskName /SC ONLOGON /RL LIMITED /F /TR $action /DELAY 0000:30 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] 创建计划任务失败（通常需管理员权限），回退到启动文件夹方式" -ForegroundColor Yellow
    Install-Startup
    return
  }
  Write-Host "[+] 已注册计划任务：$taskName（登录后 30 秒执行）" -ForegroundColor Green
}

if ($Method -eq "task") { Install-Task } else { Install-Startup }

Write-Host ""
Write-Host "[*] 手动试跑一次："
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$startScript`""
Write-Host "[*] 卸载：powershell -File `"$($MyInvocation.MyCommand.Path)`" -Uninstall"
Write-Host "[*] 查看当前域名：tools\tunnel-url.txt"

if ($RunNow) {
  Write-Host ""
  Write-Host "[*] 立即启动一次..." -ForegroundColor Cyan
  & powershell -NoProfile -ExecutionPolicy Bypass -File $startScript
}
