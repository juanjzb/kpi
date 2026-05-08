@echo off
setlocal enabledelayedexpansion

set "FOUND=0"

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do (
    echo Deteniendo PID %%a en puerto 8000...
    taskkill /F /PID %%a >nul 2>&1
    set "FOUND=1"
)

tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if not errorlevel 1 (
    echo Deteniendo cloudflared...
    taskkill /F /IM cloudflared.exe >nul 2>&1
    set "FOUND=1"
)

if "!FOUND!"=="0" (
    echo No hay procesos BACCITA corriendo.
) else (
    echo Servicios BACCITA detenidos.
)

pause
