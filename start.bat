@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo Opening the store inventory in your browser...
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080"
node server.js
pause
