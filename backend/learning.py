"""
SILAS LEARN tab: everything Karl wants to learn, sorted by *style* of learning, studied in
Pomodoro rounds. Stored privately in backend/data/learning.json.

Field names follow the "Master Learning" spreadsheet layout planned in the handoff summary
(Topic, Category, Resource, Platform, URL, Status, Priority, Progress %, Est Hours, Next Step,
Linked Project, Notes), so a spreadsheet can be imported later without renaming anything.
Hours Done is worked out from the logged Pomodoro sessions.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .config import DATA_DIR

LEARN_FILE = DATA_DIR / "learning.json"
_lock = threading.RLock()

STYLES = ["watch", "listen", "read", "course", "build", "practise", "recall"]
STATUSES = ["Idea", "Queued", "Active", "Paused", "Done", "Dropped"]
CATEGORIES = ["3D/CAD", "Art", "Electronics", "Coding", "Klipper/Printing", "Business", "Other"]

# First-run starter list: things Karl has said he's learning. Edit or delete freely.
SEED = [
    {"topic": "Blender", "category": "3D/CAD", "resource": "Udemy Blender course", "platform": "Udemy",
     "styles": ["course", "watch", "build"], "status": "Active", "priority": 1,
     "next_step": "Open the course and play the next lesson"},
    {"topic": "Drawing", "category": "Art", "resource": "Udemy drawing course", "platform": "Udemy",
     "styles": ["course", "practise"], "status": "Active", "priority": 2,
     "next_step": "Pre-draw warm-up, then the next lesson exercise"},
    {"topic": "GIMP space art", "category": "Art", "resource": "GIMP for Space Art: 10 sessions", "platform": "Other",
     "url": "https://claude.ai/artifact/1ESBM5NVJG7QQKexyD2qfU",
     "styles": ["practise", "build"], "status": "Queued", "priority": 2,
     "next_step": "Session 1: set up the 3840 × 2400 canvas"},
]

router = APIRouter(prefix="/api/learning", tags=["learning"])


def _now() -> float:
    return time.time()


def _blank_item(**kw) -> Dict[str, Any]:
    item = {
        "id": uuid.uuid4().hex[:10], "topic": "", "category": "Other", "resource": "", "platform": "",
        "url": "", "styles": [], "status": "Queued", "priority": 2, "progress": 0, "est_hours": None,
        "next_step": "", "linked_project": "", "notes": "", "created_at": _now(),
    }
    item.update(kw)
    return item


def _load() -> Dict[str, Any]:
    with _lock:
        if not LEARN_FILE.exists():
            data = {"items": [_blank_item(**s) for s in SEED], "sessions": []}
            _save(data)
            return data
        try:
            data = json.loads(LEARN_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        data.setdefault("items", [])
        data.setdefault("sessions", [])
        return data


def _save(data: Dict[str, Any]) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = LEARN_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, LEARN_FILE)


class ItemModel(BaseModel):
    topic: str
    category: Optional[str] = "Other"
    resource: Optional[str] = ""
    platform: Optional[str] = ""
    url: Optional[str] = ""
    styles: List[str] = []
    status: Optional[str] = "Queued"
    priority: Optional[int] = Field(2, ge=1, le=3)
    progress: Optional[int] = Field(0, ge=0, le=100)
    est_hours: Optional[float] = Field(None, ge=0)
    next_step: Optional[str] = ""
    linked_project: Optional[str] = ""
    notes: Optional[str] = ""


class SessionModel(BaseModel):
    item_id: Optional[str] = None
    minutes: float = Field(..., gt=0, le=240)
    note: Optional[str] = ""
    preset: Optional[str] = ""
    style: Optional[str] = ""
    next_step: Optional[str] = None   # optionally update the item's next step in the same call
    progress: Optional[int] = Field(None, ge=0, le=100)


def _clean_item(req: ItemModel) -> Dict[str, Any]:
    topic = req.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Give it a topic name.")
    return {
        "topic": topic[:200],
        "category": req.category if req.category in CATEGORIES else "Other",
        "resource": (req.resource or "").strip()[:300],
        "platform": (req.platform or "").strip()[:60],
        "url": (req.url or "").strip()[:800],
        "styles": [s for s in dict.fromkeys(req.styles) if s in STYLES],
        "status": req.status if req.status in STATUSES else "Queued",
        "priority": req.priority or 2,
        "progress": req.progress or 0,
        "est_hours": req.est_hours,
        "next_step": (req.next_step or "").strip()[:300],
        "linked_project": (req.linked_project or "").strip()[:120],
        "notes": (req.notes or "").strip()[:4000],
    }


def _summary(data: Dict[str, Any]) -> Dict[str, Any]:
    today = dt.date.today()
    week_start = today - dt.timedelta(days=6)
    mins_by_item: Dict[str, float] = {}
    last_by_item: Dict[str, str] = {}
    days_with = set()
    today_rounds = 0
    today_min = 0.0
    week_min = 0.0
    for s in data["sessions"]:
        d = s.get("date", "")
        days_with.add(d)
        if s.get("item_id"):
            mins_by_item[s["item_id"]] = mins_by_item.get(s["item_id"], 0) + s.get("minutes", 0)
            last_by_item[s["item_id"]] = max(last_by_item.get(s["item_id"], ""), d)
        if d == today.isoformat():
            today_rounds += 1
            today_min += s.get("minutes", 0)
        if d >= week_start.isoformat():
            week_min += s.get("minutes", 0)
    streak, d = 0, today
    if today.isoformat() not in days_with:
        d -= dt.timedelta(days=1)
    while d.isoformat() in days_with:
        streak += 1
        d -= dt.timedelta(days=1)
    last = max(days_with) if days_with else None
    days_since = (today - dt.date.fromisoformat(last)).days if last else None
    items = []
    for it in data["items"]:
        items.append({**it, "hours_done": round(mins_by_item.get(it["id"], 0) / 60, 2),
                      "last_studied": last_by_item.get(it["id"])})
    order = {"Active": 0, "Queued": 1, "Idea": 2, "Paused": 3, "Done": 4, "Dropped": 5}
    items.sort(key=lambda i: (order.get(i["status"], 9), i.get("priority", 2), i["topic"].lower()))
    week = []
    for k in range(6, -1, -1):
        day = (today - dt.timedelta(days=k)).isoformat()
        week.append({"date": day, "minutes": round(sum(s.get("minutes", 0) for s in data["sessions"] if s.get("date") == day))})
    return {
        "items": items,
        "stats": {
            "today_rounds": today_rounds, "today_minutes": round(today_min),
            "week_minutes": round(week_min), "streak": streak,
            "last_session": last, "days_since": days_since, "week": week,
        },
        "recent": sorted(data["sessions"], key=lambda s: s.get("ended_at", 0), reverse=True)[:12],
        "styles": STYLES, "statuses": STATUSES, "categories": CATEGORIES,
    }


@router.get("")
def get_learning():
    return _summary(_load())


@router.post("/items")
def add_item(req: ItemModel):
    with _lock:
        data = _load()
        item = _blank_item(**_clean_item(req))
        data["items"].append(item)
        _save(data)
    return {"success": True, "item": item}


@router.put("/items/{item_id}")
def edit_item(item_id: str, req: ItemModel):
    with _lock:
        data = _load()
        for i, it in enumerate(data["items"]):
            if it["id"] == item_id:
                data["items"][i] = {**it, **_clean_item(req), "updated_at": _now()}
                _save(data)
                return {"success": True, "item": data["items"][i]}
    raise HTTPException(status_code=404, detail="Not found")


@router.delete("/items/{item_id}")
def delete_item(item_id: str):
    with _lock:
        data = _load()
        keep = [it for it in data["items"] if it["id"] != item_id]
        if len(keep) == len(data["items"]):
            raise HTTPException(status_code=404, detail="Not found")
        data["items"] = keep
        _save(data)
    return {"success": True}


@router.post("/sessions")
def log_session(req: SessionModel):
    with _lock:
        data = _load()
        item = next((it for it in data["items"] if it["id"] == req.item_id), None) if req.item_id else None
        if req.item_id and not item:
            raise HTTPException(status_code=404, detail="That learning item no longer exists.")
        session = {
            "id": uuid.uuid4().hex[:10], "item_id": req.item_id, "topic": item["topic"] if item else "",
            "date": dt.date.today().isoformat(), "ended_at": _now(), "minutes": round(req.minutes, 1),
            "preset": (req.preset or "")[:20], "style": req.style if req.style in STYLES else "",
            "note": (req.note or "").strip()[:1000],
        }
        data["sessions"].append(session)
        if item is not None:
            if req.next_step is not None and req.next_step.strip():
                item["next_step"] = req.next_step.strip()[:300]
            if req.progress is not None:
                item["progress"] = req.progress
            if item.get("status") in ("Idea", "Queued"):
                item["status"] = "Active"
        _save(data)
    return {"success": True, "session": session}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    with _lock:
        data = _load()
        keep = [s for s in data["sessions"] if s.get("id") != session_id]
        if len(keep) == len(data["sessions"]):
            raise HTTPException(status_code=404, detail="Not found")
        data["sessions"] = keep
        _save(data)
    return {"success": True}
