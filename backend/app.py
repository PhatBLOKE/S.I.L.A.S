import socket
import datetime
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, RedirectResponse
from pydantic import BaseModel


from .config import (
    get_printers,
    update_printers,
    get_calendar_config,
    update_calendar_config,
    get_local_events,
    add_local_event,
    delete_local_event,
    get_ai_config_public,
    update_ai_config
)
from .hub import hub
from .alerts import alert_center
from .ai_usage import ai_usage
from .printers.base import close_http_client
from .security import LanGuardMiddleware, get_access_token, is_loopback
from .printers.manager import fleet_manager
from .ai_companion import get_ai_response, analyze_printer_telemetry
from .drive_commander import router as drive_router
from .todoist import router as todoist_router, close_client as close_todoist_client
from .pip_diary import router as pip_router
from .learning import router as learning_router

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def print_silas_banner():
    # Clear console for that clean terminal boot feel
    os.system('cls' if os.name == 'nt' else 'clear')
    
    # Precision-aligned symmetric ASCII lettering
    banner = r"""
   _____ ____ _       ___   ____  
  / ___/|  _/| |     / _ \ / ___/  [v2.0.0]
  \__ \ | |  | |    / /_\ \\___ \  [SYS: LOCAL_AGENTS]
 ___/ /_| |_ | |___/ ___  /___/ /  [ENC: AES-256]
/____/|____/|_____/_/   \_/____/   
                                   
  > Secure Interface for Local & Autonomous Systems
========================================================================"""
    
    for line in banner.split('\n'):
        print(line)
        time.sleep(0.03)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Fire the Silas terminal UI branding immediately on execution
    print_silas_banner()
    
    token = get_access_token()
    ip = get_local_ip()
    
    # Log connection routing data under the new system tag
    print(f"\n[SILAS] Secure LAN link: http://{ip}:8000/?token={token}#mobile")
    print("[SILAS] Opening autonomous listener frameworks...")
    
    hub.start()
    yield
    await hub.stop()
    await close_http_client()
    await close_todoist_client()


# System title updated from Jarvis to S.I.L.A.S.
app = FastAPI(title="Silas SILAS PA Fleet Console", version="2.0.0", lifespan=lifespan)

# The UI is served from this same origin, so cross-origin access is only needed for
# the Vite dev server. No wildcard: random web pages must not be able to drive printers.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Added last = runs first: nothing from the LAN gets past without the access token.
app.add_middleware(LanGuardMiddleware)

# Drive Commander (hard-drive organiser) - only from the SILAS PC itself, see drive_commander.py
app.include_router(drive_router)

# Todoist link: TODAY tab, Mission Control focus strip, Silas's plan context (see todoist.py)
app.include_router(todoist_router)

# PIP diary daily log (TODAY tab), stored in backend/data/pip_diary.json
app.include_router(pip_router)

# LEARN tab: learning by style + Pomodoro sessions, stored in backend/data/learning.json
app.include_router(learning_router)


# Request Models
class PrinterConfigModel(BaseModel):
    id: Optional[str] = None
    name: str
    type: str = "moonraker"  # 'moonraker' | 'octoprint'
    host: str
    port: int = 7125
    api_key: Optional[str] = ""
    webcam_url: Optional[str] = ""
    enabled: bool = True
    notes: Optional[str] = ""

class PrinterCommandModel(BaseModel):
    command: str  # 'pause', 'resume', 'cancel', 'emergency_stop', 'preheat', 'cooldown', 'gcode'
    params: Optional[Dict[str, Any]] = None

class CalendarConfigModel(BaseModel):
    ical_url: str
    refresh_interval_minutes: Optional[int] = 5

class LocalEventModel(BaseModel):
    title: str
    start: str
    end: str
    location: Optional[str] = ""
    description: Optional[str] = ""

# API Endpoints
@app.get("/api/system")
def get_system_info(request: Request):
    ip = get_local_ip()
    info = {
        "status": "online",
        "system": "Silas PA Operating System",
        "local_ip": ip,
        "mobile_url": f"http://{ip}:8000/#mobile",
        "server_time": datetime.datetime.now().astimezone().isoformat(),
    }
    # Only the machine SILAS runs on gets to see the token-bearing link.
    if is_loopback(request.client.host if request.client else None):
        info["mobile_url"] = f"http://{ip}:8000/?token={get_access_token()}#mobile"
        info["mobile_url_secure"] = True
    return info

# Live push channel: one snapshot (fleet + calendar + briefing) per hub tick.
@app.websocket("/ws")
async def ws_feed(ws: WebSocket):
    await hub.serve(ws)

@app.get("/api/snapshot")
async def get_snapshot():
    return await hub.get_snapshot()

# Alert Endpoints (printer errors forwarded to the HUD)
class AlertAckModel(BaseModel):
    id: Optional[str] = None  # omit to acknowledge everything


@app.get("/api/alerts")
def list_alerts(limit: int = 50):
    return alert_center.list(limit=max(1, min(limit, 200)))


@app.post("/api/alerts/ack")
async def ack_alerts(req: AlertAckModel):
    n = alert_center.acknowledge(req.id)
    await hub.push_alerts()
    return {"success": True, "acknowledged": n}


@app.post("/api/alerts/test")
async def test_alert(printer_id: Optional[str] = None):
    """Fire a fake Snapmaker U1 'filament tangled' error to check the alert pipeline end to end."""
    fleet = hub.latest_fleet() or []
    target = next((p for p in fleet if p.get("id") == printer_id), None) or \
        next((p for p in fleet if "u1" in (p.get("name") or "").lower()), None) or \
        (fleet[0] if fleet else {"id": "test", "name": "Test Printer"})
    alert_center.snapmaker_exception(target["id"], target["name"], {
        "id": 523, "index": 1, "code": 38, "level": 2,
        "message": "detect filament tangled! (SILAS test alert - nothing is actually wrong)"})
    return {"success": True}


# AI usage tab: SILAS's own metered LLM calls + limit tracker for every AI app
class AIServiceModel(BaseModel):
    id: Optional[str] = None
    name: str
    url: Optional[str] = ""
    icon: Optional[str] = "🤖"
    notes: Optional[str] = ""


class AILimitModel(BaseModel):
    reset_in_minutes: Optional[float] = None   # e.g. 300 for "5 hours"
    reset_at: Optional[str] = None             # ISO time, e.g. "2026-10-10T21:00"
    note: Optional[str] = ""


@app.get("/api/ai-usage")
def get_ai_usage():
    return ai_usage.summary()


@app.post("/api/ai-usage/services")
def save_ai_service(svc: AIServiceModel):
    return {"success": True, "service": ai_usage.upsert_service(svc.id, svc.name, svc.url or "", svc.icon or "🤖", svc.notes or "")}


@app.delete("/api/ai-usage/services/{sid}")
def delete_ai_service(sid: str):
    if not ai_usage.delete_service(sid):
        raise HTTPException(status_code=404, detail="Not found")
    return {"success": True}


@app.post("/api/ai-usage/services/{sid}/limited")
def ai_service_limited(sid: str, req: AILimitModel):
    import time as _t
    reset_ts = None
    if req.reset_in_minutes is not None and req.reset_in_minutes > 0:
        reset_ts = _t.time() + float(req.reset_in_minutes) * 60
    elif req.reset_at:
        try:
            dt = datetime.datetime.fromisoformat(req.reset_at)
            if dt.tzinfo is None:
                dt = dt.astimezone()  # treat as local time
            reset_ts = dt.timestamp()
        except ValueError:
            raise HTTPException(status_code=400, detail="reset_at must look like 2026-10-10T21:00")
    svc = ai_usage.mark_limited(sid, reset_ts, req.note or "")
    if not svc:
        raise HTTPException(status_code=404, detail="Not found")
    return {"success": True, "service": svc}


@app.post("/api/ai-usage/services/{sid}/ready")
def ai_service_ready(sid: str):
    svc = ai_usage.mark_ready(sid)
    if not svc:
        raise HTTPException(status_code=404, detail="Not found")
    return {"success": True, "service": svc}


# Fleet Endpoints
@app.get("/api/fleet")
async def get_fleet_telemetry():
    return (await hub.get_snapshot())["fleet"]

@app.get("/api/printers")
def list_printers():
    return fleet_manager.public_configs()

@app.post("/api/printers")
def create_printer(printer: PrinterConfigModel):
    created = fleet_manager.add_printer(printer.model_dump())
    hub.poke()
    created = {**created, "api_key": "\u2022\u2022\u2022\u2022" if created.get("api_key") else ""}
    return {"success": True, "printer": created}

@app.put("/api/printers/{printer_id}")
def edit_printer(printer_id: str, printer: PrinterConfigModel):
    ok = fleet_manager.update_printer(printer_id, printer.model_dump())
    if not ok:
        raise HTTPException(status_code=404, detail="Printer not found")
    hub.poke()
    return {"success": True}

@app.delete("/api/printers/{printer_id}")
def remove_printer(printer_id: str):
    ok = fleet_manager.delete_printer(printer_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Printer not found")
    hub.poke()
    return {"success": True}

@app.post("/api/printers/{printer_id}/command")
async def send_printer_command(printer_id: str, req: PrinterCommandModel):
    hub.note_command(printer_id, req.command)
    result = await fleet_manager.execute_command(printer_id, req.command, req.params)
    hub.poke()
    return result

# Calendar Endpoints
@app.get("/api/calendar/events")
async def get_events():
    return (await hub.get_snapshot())["events"]

@app.get("/api/calendar/config")
def get_cal_settings(request: Request):
    cfg = dict(get_calendar_config())
    # The secret iCal address is a credential: only show it on the host machine.
    if cfg.get("ical_url") and not is_loopback(request.client.host if request.client else None):
        cfg["ical_url"] = "(configured - view on the host machine)"
    return cfg

@app.post("/api/calendar/config")
def set_cal_settings(cfg: CalendarConfigModel):
    update_calendar_config(cfg.model_dump())
    hub.poke(calendar=True)
    return {"success": True}

@app.post("/api/calendar/events")
def add_event(event: LocalEventModel):
    import uuid
    ev_dict = event.model_dump()
    ev_dict["id"] = f"loc-{uuid.uuid4().hex[:6]}"
    add_local_event(ev_dict)
    hub.poke()
    return {"success": True, "event": ev_dict}

@app.delete("/api/calendar/events/{event_id}")
def remove_event(event_id: str):
    ok = delete_local_event(event_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Event not found")
    hub.poke()
    return {"success": True}

@app.get("/api/pa/briefing")
async def get_executive_briefing():
    return (await hub.get_snapshot())["briefing"]

# AI 3D Printing Companion Endpoints
class AIChatRequest(BaseModel):
    message: str
    printer_id: Optional[str] = None
    humor_level: Optional[int] = 100

class SelectToolRequest(BaseModel):
    tool: str  # e.g., 'T0', 'T1'

@app.post("/api/printers/{printer_id}/tool")
async def set_active_tool(printer_id: str, req: SelectToolRequest):
    # A tool change mid-print would park the active tool and grab another one mid-layer.
    current = next((p for p in (hub.latest_fleet() or []) if p.get("id") == printer_id), None)
    if current and current.get("state") in ("printing", "paused"):
        raise HTTPException(status_code=409, detail="Tool changes are locked while a job is running")
    result = await fleet_manager.execute_command(printer_id, "select_tool", {"tool": req.tool})
    hub.poke()
    return result

@app.get("/api/printers/{printer_id}/thumbnail")
async def get_printer_thumbnail(printer_id: str, filename: Optional[str] = None):
    driver = fleet_manager.get_driver(printer_id)
    if not driver:
        raise HTTPException(status_code=404, detail="Printer not found")
    if hasattr(driver, "get_thumbnail_bytes"):
        thumb_bytes = await driver.get_thumbnail_bytes(filename)
        if thumb_bytes:
            return Response(content=thumb_bytes, media_type="image/png", headers={
                "Cache-Control": "public, max-age=3600"
            })
    raise HTTPException(status_code=404, detail="Thumbnail not available")


class AIConfigModel(BaseModel):
    provider: Optional[str] = "gemini"
    api_key: Optional[str] = ""
    model: Optional[str] = "gemini-2.5-flash"
    custom_url: Optional[str] = "https://skippy.ai.studio"
    provider_keys: Optional[Dict[str, str]] = None

    model_config = {"extra": "ignore"}


@app.get("/api/ai/config")
def get_ai_settings():
    # Keys are masked; the full value never leaves the server.
    return get_ai_config_public()

@app.post("/api/ai/config")
def set_ai_settings(cfg: AIConfigModel):
    # exclude_unset: a partial update must not reset provider/model to the model defaults
    update_ai_config(cfg.model_dump(exclude_unset=True))
    return {"success": True}

@app.post("/api/ai/chat")
async def ai_chat(req: AIChatRequest):
    try:
        printer_ctx = None
        if req.printer_id:
            printer_ctx = await fleet_manager.get_single_status(req.printer_id)
        response = await get_ai_response(req.message, printer_ctx, humor_level=req.humor_level or 100)
        return response
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "source": "havoc_error_handler",
            "reply": f"🤖 **[SILAS // TARS HUMOR: {req.humor_level or 100}%]**\n\nI hit an internal processing hitch while polling that telemetry: `{type(e).__name__}`.\n\nRelax, Karl. The firmware didn't burn down. Check your machine link or ask again."
        }

@app.post("/api/ai/diagnose/{printer_id}")
async def ai_diagnose(printer_id: str):
    printer_ctx = await fleet_manager.get_single_status(printer_id)
    if not printer_ctx:
        raise HTTPException(status_code=404, detail="Printer not found")
    diagnosis = analyze_printer_telemetry(printer_ctx)
    return {
        "printer_id": printer_id,
        "name": printer_ctx.get("name"),
        "diagnosis": diagnosis
    }

# Serve frontend build if dist folder exists
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    DIST_ROOT = FRONTEND_DIST.resolve()

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    def serve_frontend(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Resolve and confine to dist/: blocks ../ and %2e%2e traversal to config.json & friends.
        try:
            target_file = (DIST_ROOT / full_path).resolve()
            inside = target_file.is_relative_to(DIST_ROOT)
        except (OSError, ValueError):
            inside = False
        if full_path and inside and target_file.is_file():
            return FileResponse(str(target_file))
        return FileResponse(
            str(FRONTEND_DIST / "index.html"),
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
