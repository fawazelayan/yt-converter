@echo off
title YouTube Downloader
echo ========================================================
echo   Starting YouTube Downloader...
echo   Opening in your browser: http://localhost:3000
echo ========================================================
echo.
start "" http://localhost:3000
node server.js
pause
