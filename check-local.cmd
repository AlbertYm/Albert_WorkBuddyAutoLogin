@echo off
cd /d "%~dp0"
node main.js --local --check
set "WB_EXIT=%errorlevel%"
pause
exit /b %WB_EXIT%
