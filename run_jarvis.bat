@echo off
title SILAS // Personal Assistant Command Console
echo ============================================================
echo   SILAS CONSOLE // 3D FLEET COMMAND ^& CALENDAR PA
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/2] Checking Python environment...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not found on PATH. Please install Python 3.
    pause
    exit /b 1
)

echo [1b/2] Checking Python packages...
python -c "import fastapi, uvicorn, httpx, icalendar, recurring_ical_events, websockets" >nul 2>&1
if %errorlevel% neq 0 (
    echo   Installing/updating requirements...
    python -m pip install -r backend\requirements.txt
)

echo [2/2] Launching Silas Console Desktop Server...
echo   Local Desktop Access: http://localhost:8000
echo   Starting window...
echo.

start "" msedge --app=http://localhost:8000 || start "" http://localhost:8000

python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
pause
