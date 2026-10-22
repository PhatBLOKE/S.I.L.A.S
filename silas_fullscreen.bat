@echo off
REM SILAS full screen: no title bar, no taskbar, just SILAS. Quit with Alt+F4.
title SILAS // full screen launcher
cd /d "%~dp0"

REM 1. Is the SILAS server already running on port 8000?
netstat -ano | findstr /r /c:":8000 .*LISTENING" >nul
if %errorlevel% equ 0 goto ready

echo Starting the SILAS server in the background...
python -c "import fastapi, uvicorn, httpx, icalendar, recurring_ical_events, websockets" >nul 2>&1
if %errorlevel% neq 0 python -m pip install -r backend\requirements.txt
start "SILAS server" /min python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload

REM 2. Wait (up to ~30 s) until it answers.
for /l %%i in (1,1,30) do (
  curl -s -f -o nul http://127.0.0.1:8000/api/system && goto ready
  timeout /t 1 /nobreak >nul
)
echo SILAS didn't start. Run run_jarvis.bat to see the error.
pause
exit /b 1

:ready
REM 3. Open SILAS as a full-screen kiosk window. Its own Edge profile keeps it separate from normal browsing.
start "" msedge --kiosk "http://localhost:8000/#mission" --edge-kiosk-type=fullscreen --no-first-run --user-data-dir="%LOCALAPPDATA%\SILAS\EdgeKiosk"
exit /b 0
