@echo off
title YT Downloader - Phone & Online Access
echo ========================================================
echo   Starting YT Downloader with Mobile/Online Tunnel...
echo   Home PC: http://localhost:3000
echo ========================================================
echo.
start "" http://localhost:3000
start "" cmd /k "npx -y localtunnel --port 3000"
node server.js
pause
