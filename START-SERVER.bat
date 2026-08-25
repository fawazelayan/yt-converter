@echo off
title YT Downloader - Server (keep this window open)
cd /d "%~dp0"

echo ==========================================================
echo   YT Downloader - starting server
echo   Keep this window OPEN and the laptop AWAKE.
echo   Closing this window takes the website offline.
echo ==========================================================
echo.

set "TAILSCALE_EXE=tailscale"
where tailscale >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\Tailscale\tailscale.exe" (
        set "TAILSCALE_EXE=C:\Program Files\Tailscale\tailscale.exe"
    ) else if exist "%LocalAppData%\Tailscale\tailscale.exe" (
        set "TAILSCALE_EXE=%LocalAppData%\Tailscale\tailscale.exe"
    ) else (
        echo [!] Tailscale is not installed or not found.
        echo     Install it from https://tailscale.com/download then run this again.
        echo.
        pause
        exit /b 1
    )
)

echo [1/3] Starting the download server on port 3000...
start "YT Downloader server" /min cmd /c "node server.js"

REM Give Node a moment to bind the port before the tunnel points at it.
timeout /t 3 /nobreak >nul

echo [2/3] Publishing it to the internet via Tailscale Funnel...
"%TAILSCALE_EXE%" funnel --bg 3000 >nul 2>nul

timeout /t 2 /nobreak >nul

echo [3/3] Your public internet address:
echo.
"%TAILSCALE_EXE%" funnel status
echo.
echo ==========================================================
echo   Your website is LIVE on the public internet!
echo   Anyone with your GitHub Pages link can use it.
echo ==========================================================
echo.
echo Press any key to STOP the server and take the site offline.
pause >nul

echo Stopping...
"%TAILSCALE_EXE%" funnel --https=443 off >nul 2>nul
taskkill /F /IM node.exe >nul 2>nul
echo Done.
timeout /t 2 /nobreak >nul
