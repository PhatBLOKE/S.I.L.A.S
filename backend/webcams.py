"""
Printer cameras: find them on the printer, keep a tidy list per printer.

Each printer config can hold a "webcams" list:
    {"name", "stream_url", "snapshot_url", "mode", "service", "rotation", "flip_h", "flip_v", "source"}
mode is how the page shows it:
    "mjpeg"    - live <img> stream (crowsnest/ustreamer/mjpg-streamer, OctoPrint classic webcam)
    "snapshot" - still image refreshed about once a second (for WebRTC/HLS cams that also offer a snapshot)
    "page"     - only viewable on the printer's own page; SILAS shows an "open" link
The old single "webcam_url" field still works and is kept in sync with the first camera.

Finding cameras (POST /api/webcams/discover):
    1. Moonraker: GET /server/webcams/list (what Mainsail/Fluidd show)
    2. OctoPrint: GET /api/settings -> webcam.streamUrl / snapshotUrl
    3. Then the usual addresses on the printer are tried: /webcam/?action=stream, /webcam2/..., :8080
Only http/https URLs are ever stored.
"""
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse, urlunparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config import get_printers, is_masked

router = APIRouter()

MJPEG_SERVICES = ("mjpeg", "uv4l", "ipstream")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
PROBE_PATHS = [
    ("Webcam", "/webcam/?action=stream", "/webcam/?action=snapshot"),
    ("Webcam 2", "/webcam2/?action=stream", "/webcam2/?action=snapshot"),
    ("Webcam 3", "/webcam3/?action=stream", "/webcam3/?action=snapshot"),
    ("Camera (port 8080)", ":8080/?action=stream", ":8080/?action=snapshot"),
]


def printer_hostname(host: str) -> str:
    h = (host or "").strip()
    if "://" in h:
        h = urlparse(h).hostname or ""
    return h.split("/")[0].split(":")[0] if h.count(":") == 1 else h.split("/")[0]


def _safe_url(url: str) -> bool:
    try:
        u = urlparse(url)
        return u.scheme in ("http", "https") and bool(u.netloc)
    except Exception:
        return False


def resolve_url(url: Optional[str], hostname: str) -> str:
    """Moonraker stores camera URLs relative to the printer ("/webcam/?action=stream") or with
    localhost in them. Turn both into something this PC (and your phone) can reach."""
    url = (url or "").strip()
    if not url:
        return ""
    if url.startswith(":"):  # ":8080/?action=stream"
        url = f"http://{hostname}{url}"
    elif "://" not in url:
        url = urljoin(f"http://{hostname}/", url)
    u = urlparse(url)
    if u.hostname in LOCAL_HOSTS:
        netloc = hostname + (f":{u.port}" if u.port else "")
        url = urlunparse(u._replace(netloc=netloc))
    return url if _safe_url(url) else ""


def _mode(service: str, stream_url: str, snapshot_url: str) -> str:
    s = (service or "").lower()
    if any(k in s for k in MJPEG_SERVICES) or "action=stream" in stream_url:
        return "mjpeg"
    if snapshot_url:
        return "snapshot"
    return "page"


def clean_camera(cam: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Validate a camera from the UI or discovery before it is stored."""
    stream = (cam.get("stream_url") or "").strip()
    snap = (cam.get("snapshot_url") or "").strip()
    if stream and not _safe_url(stream):
        stream = ""
    if snap and not _safe_url(snap):
        snap = ""
    if not stream and not snap:
        return None
    mode = cam.get("mode") if cam.get("mode") in ("mjpeg", "snapshot", "page") else _mode(cam.get("service", ""), stream, snap)
    if mode == "snapshot" and not snap:
        mode = "mjpeg" if stream else "page"
    try:
        rotation = int(cam.get("rotation") or 0) % 360
    except (TypeError, ValueError):
        rotation = 0
    return {
        "name": (str(cam.get("name") or "Camera")).strip()[:40] or "Camera",
        "stream_url": stream,
        "snapshot_url": snap,
        "mode": mode,
        "service": str(cam.get("service") or "")[:40],
        "rotation": rotation if rotation in (0, 90, 180, 270) else 0,
        "flip_h": bool(cam.get("flip_h")),
        "flip_v": bool(cam.get("flip_v")),
        "source": str(cam.get("source") or "manual")[:20],
    }


def cameras_for(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The camera list for a printer config, including the old single webcam_url."""
    cams = [c for c in (clean_camera(x) for x in (config.get("webcams") or []) if isinstance(x, dict)) if c]
    legacy = (config.get("webcam_url") or "").strip()
    if not cams and legacy and _safe_url(legacy):
        cams = [clean_camera({"name": "Camera", "stream_url": legacy, "source": "manual"})]
    return [c for c in cams if c]


async def _moonraker_cams(client: httpx.AsyncClient, base: str, headers: Dict[str, str], hostname: str) -> List[Dict[str, Any]]:
    try:
        r = await client.get(f"{base}/server/webcams/list", headers=headers)
        if r.status_code != 200:
            return []
        cams = (r.json().get("result") or {}).get("webcams") or []
    except Exception:
        return []
    out = []
    for c in cams:
        if c.get("enabled") is False:
            continue
        stream = resolve_url(c.get("stream_url"), hostname)
        snap = resolve_url(c.get("snapshot_url"), hostname)
        cam = clean_camera({
            "name": c.get("name"), "stream_url": stream, "snapshot_url": snap, "service": c.get("service", ""),
            "rotation": c.get("rotation", 0), "flip_h": c.get("flip_horizontal"), "flip_v": c.get("flip_vertical"),
            "source": "moonraker",
        })
        if cam:
            out.append(cam)
    return out


async def _octoprint_cams(client: httpx.AsyncClient, base: str, headers: Dict[str, str], hostname: str) -> List[Dict[str, Any]]:
    try:
        r = await client.get(f"{base}/api/settings", headers=headers)
        if r.status_code != 200:
            return []
        w = r.json().get("webcam") or {}
    except Exception:
        return []
    stream = resolve_url(w.get("streamUrl"), hostname)
    snap = resolve_url(w.get("snapshotUrl"), hostname)
    cam = clean_camera({
        "name": "OctoPrint camera", "stream_url": stream, "snapshot_url": snap, "service": "mjpeg",
        "rotation": 90 if w.get("rotate90") else 0, "flip_h": w.get("flipH"), "flip_v": w.get("flipV"),
        "source": "octoprint",
    })
    return [cam] if cam else []


async def _answers_with_image(client: httpx.AsyncClient, url: str) -> bool:
    try:
        async with client.stream("GET", url, timeout=httpx.Timeout(2.5, connect=1.5)) as r:
            ctype = r.headers.get("content-type", "").lower()
            return r.status_code == 200 and ("image/" in ctype or "multipart/x-mixed-replace" in ctype)
    except Exception:
        return False


async def _probe_cams(client: httpx.AsyncClient, hostname: str, known: List[str]) -> List[Dict[str, Any]]:
    out = []
    for name, stream_path, snap_path in PROBE_PATHS:
        stream = resolve_url(stream_path, hostname)
        if stream in known:
            continue
        if await _answers_with_image(client, stream):
            snap = resolve_url(snap_path, hostname)
            out.append(clean_camera({"name": name, "stream_url": stream, "snapshot_url": snap,
                                     "service": "mjpegstreamer", "source": "found"}))
    return [c for c in out if c]


async def discover(host: str, port: int, kind: str, api_key: str = "", transport: Optional[httpx.AsyncBaseTransport] = None) -> Dict[str, Any]:
    hostname = printer_hostname(host)
    if not hostname:
        raise ValueError("No printer address")
    scheme = "https" if (host or "").strip().startswith("https://") else "http"
    base = f"{scheme}://{hostname}:{port}"
    headers = {"X-Api-Key": api_key} if api_key else {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(4.0, connect=2.0), follow_redirects=True, transport=transport) as client:
        if (kind or "moonraker").lower() == "octoprint":
            listed = await _octoprint_cams(client, base, headers, hostname)
        else:
            listed = await _moonraker_cams(client, base, headers, hostname)
        found = await _probe_cams(client, hostname, [c["stream_url"] for c in listed])
    cams, seen = [], set()
    for c in listed + found:
        key = c["stream_url"] or c["snapshot_url"]
        if key not in seen:
            seen.add(key)
            cams.append(c)
    return {"host": hostname, "cameras": cams}


class DiscoverRequest(BaseModel):
    printer_id: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    type: Optional[str] = None
    api_key: Optional[str] = ""


@router.post("/api/webcams/discover")
async def discover_cameras(req: DiscoverRequest):
    cfg: Dict[str, Any] = {}
    if req.printer_id:
        cfg = next((p for p in get_printers() if p.get("id") == req.printer_id), {})
        if not cfg:
            raise HTTPException(status_code=404, detail="Printer not found")
    host = req.host or cfg.get("host", "")
    port = req.port or cfg.get("port") or 7125
    kind = req.type or cfg.get("type", "moonraker")
    key = req.api_key or ""
    if not key or is_masked(key):
        key = cfg.get("api_key", "") or ""
    try:
        return await discover(host, int(port), kind, key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
