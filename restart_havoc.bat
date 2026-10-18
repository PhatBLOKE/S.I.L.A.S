@echo off
REM Stops any old SILAS server still holding port 8000 (even from another copy), then starts this one.
cd /d "%~dp0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8000 .*LISTENING"') do (
  echo Stopping old SILAS server, process %%p
  taskkill /PID %%p /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
call "%~dp0run_jarvis.bat"
