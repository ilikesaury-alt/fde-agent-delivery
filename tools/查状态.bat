@echo off
REM Check tunnel status: cloudflared process / domain / local gateway / live products.
REM Nothing is started by this script.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0status-tunnel.ps1"
