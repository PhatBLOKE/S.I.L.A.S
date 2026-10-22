@echo off
rem SILAS server only (no browser window) - for wallpaper mode / Windows startup.
rem Put a shortcut to this file in shell:startup to start SILAS with Windows.
cd /d "%~dp0"
netstat -ano | findstr /R /C:":8000 .*LISTENING" >nul && exit /b 0
start "SILAS server" /min python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000
