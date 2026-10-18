@echo off
title SILAS // switch to v2.3 (siren)
cd /d "%~dp0"
echo ============================================================
echo   SILAS v2.3 // brings your settings across, then starts
echo ============================================================
echo.
echo Close any SILAS that's already running first - the app window AND
echo its black console window - or v2.3 can't use port 8000.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0copy_settings_from_old.ps1"
echo.
call "%~dp0run_jarvis.bat"
