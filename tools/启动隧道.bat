@echo off
REM Double-click launcher for the tunnel (Plan A).
REM Actual work is done by start-tunnel.ps1:
REM   check magpie -> reuse or start cloudflared -> parse domain -> sync Worker secrets.
REM cloudflared runs in its OWN visible window (title: CLOUDFLARED) so you can watch it.
REM Closing the cloudflared window disconnects the tunnel.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tunnel.ps1"
echo.
echo ============================================================
echo  Done. A separate window titled "CLOUDFLARED" shows live tunnel logs.
echo  Keep that window open. Close it to disconnect.
echo.
echo  Check status anytime: double-click  tools\查状态.bat
echo  Current domain file:  tools\tunnel-url.txt
echo ============================================================
pause
