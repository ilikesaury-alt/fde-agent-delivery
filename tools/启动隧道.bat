@echo off
REM Double-click launcher for the tunnel (Plan A).
REM Actual work is done by start-tunnel.ps1: start cloudflared, parse domain, sync Worker secret.
REM Closing this window does NOT stop the tunnel (cloudflared runs as its own process).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tunnel.ps1"
echo.
echo ============================================================
echo  Tunnel started. Current domain: see tools/tunnel-url.txt
echo  Worker secret synced (takes about 10 seconds to take effect).
echo ============================================================
pause
