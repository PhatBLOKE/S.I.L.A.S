"""
SILAS PIP diary log: a quick daily record of sleep, pain, meds and which PIP activities
were a struggle, kept privately on this PC in backend/data/pip_diary.json.

The full diary ("Karl's PIP Diary") lives on claude.ai. This log is the fast,
low-effort capture; "Copy for diary" turns entries into text to paste there or give to Claude.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
import datetime as dt
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .config import DATA_DIR

DIARY_FILE = DATA_DIR / "pip_diary.json"
_lock = threading.RLock()

# The 12 PIP activities (10 daily living, 2 mobility), in DWP order.
ACTIVITIES = [
    ("food", "Preparing food"),
    ("eating", "Eating and drinking"),
    ("treatment", "Managing treatments / meds"),
    ("washing", "Washing and bathing"),
    ("toilet", "Managing toilet needs"),
    ("dressing", "Dressing and undressing"),
    ("communicating", "Talking, listening, understanding"),
    ("reading", "Reading and understanding"),
    ("people", "Mixing with other people"),
    ("money", "Making decisions about money"),
    ("journeys", "Planning and following journeys"),
    ("moving", "Moving around"),
]
ACTIVITY_KEYS = {k for k, _ in ACTIVITIES}
MOODS = ["very low", "low", "ok", "good", "great"]

router = APIRouter(prefix="/api/pip", tags=["pip"])


def _load() -> List[Dict[str, Any]]:
    with _lock:
        if not DIARY_FILE.exists():
            return []
        try:
            data = json.loads(DIARY_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []


def _save(entries: List[Dict[str, Any]]) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = DIARY_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, DIARY_FILE)


class EntryModel(BaseModel):
    date: Optional[str] = None                     # YYYY-MM-DD, defaults to today
    sleep_hours: Optional[float] = Field(None, ge=0, le=24)
    back_pain: Optional[int] = Field(None, ge=0, le=10)
    leg_pain: Optional[int] = Field(None, ge=0, le=10)
    mood: Optional[str] = None
    meds_morning: Optional[bool] = None
    meds_evening: Optional[bool] = None
    booster: Optional[bool] = None
    struggles: List[str] = []
    note: Optional[str] = ""


def _clean(req: EntryModel) -> Dict[str, Any]:
    day = req.date or dt.date.today().isoformat()
    try:
        dt.date.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must look like 2026-10-18.")
    mood = req.mood if req.mood in MOODS else None
    return {
        "date": day,
        "sleep_hours": req.sleep_hours,
        "back_pain": req.back_pain,
        "leg_pain": req.leg_pain,
        "mood": mood,
        "meds_morning": req.meds_morning,
        "meds_evening": req.meds_evening,
        "booster": req.booster,
        "struggles": [s for s in dict.fromkeys(req.struggles) if s in ACTIVITY_KEYS],
        "note": (req.note or "").strip()[:4000],
    }


@router.get("/meta")
def meta():
    return {"activities": [{"key": k, "label": v} for k, v in ACTIVITIES], "moods": MOODS}


@router.get("/entries")
def list_entries(days: int = 60):
    cutoff = (dt.date.today() - dt.timedelta(days=max(1, min(days, 400)))).isoformat()
    items = [e for e in _load() if e.get("date", "") >= cutoff]
    items.sort(key=lambda e: (e.get("date", ""), e.get("saved_at", 0)), reverse=True)
    today = dt.date.today().isoformat()
    # Streak: consecutive days up to today (or yesterday) with at least one entry.
    dates = {e["date"] for e in _load()}
    streak, d = 0, dt.date.today()
    if today not in dates:
        d -= dt.timedelta(days=1)
    while d.isoformat() in dates:
        streak += 1
        d -= dt.timedelta(days=1)
    return {"entries": items, "logged_today": today in dates, "streak": streak}


@router.post("/entries")
def add_entry(req: EntryModel):
    entry = {"id": uuid.uuid4().hex[:10], "saved_at": time.time(), **_clean(req)}
    with _lock:
        items = _load()
        items.append(entry)
        _save(items)
    return {"success": True, "entry": entry}


@router.put("/entries/{entry_id}")
def edit_entry(entry_id: str, req: EntryModel):
    with _lock:
        items = _load()
        for i, e in enumerate(items):
            if e.get("id") == entry_id:
                items[i] = {**e, **_clean(req), "edited_at": time.time()}
                _save(items)
                return {"success": True, "entry": items[i]}
    raise HTTPException(status_code=404, detail="Entry not found")


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str):
    with _lock:
        items = _load()
        keep = [e for e in items if e.get("id") != entry_id]
        if len(keep) == len(items):
            raise HTTPException(status_code=404, detail="Entry not found")
        _save(keep)
    return {"success": True}


def _fmt(e: Dict[str, Any]) -> str:
    labels = dict(ACTIVITIES)
    day = dt.date.fromisoformat(e["date"]).strftime("%a %d %b %Y")
    bits = []
    if e.get("sleep_hours") is not None:
        bits.append(f"Sleep {e['sleep_hours']:g}h")
    if e.get("back_pain") is not None:
        bits.append(f"back pain {e['back_pain']}/10")
    if e.get("leg_pain") is not None:
        bits.append(f"leg pain {e['leg_pain']}/10")
    if e.get("mood"):
        bits.append(f"mood {e['mood']}")
    meds = []
    for key, name in (("meds_morning", "morning meds"), ("meds_evening", "evening meds"), ("booster", "afternoon booster")):
        if e.get(key) is True:
            meds.append(f"{name} taken")
        elif e.get(key) is False:
            meds.append(f"{name} missed")
    line = f"**{day}**: " + (", ".join(bits) if bits else "no scores")
    if meds:
        line += ". " + "; ".join(meds).capitalize()
    out = [line + "."]
    if e.get("struggles"):
        out.append("Struggled with: " + ", ".join(labels[s] for s in e["struggles"] if s in labels) + ".")
    if e.get("note"):
        out.append(e["note"])
    return "\n".join(out)


@router.get("/export")
def export(days: int = 7):
    cutoff = (dt.date.today() - dt.timedelta(days=max(1, min(days, 400)))).isoformat()
    items = sorted((e for e in _load() if e.get("date", "") >= cutoff), key=lambda e: (e["date"], e.get("saved_at", 0)))
    text = "\n\n".join(_fmt(e) for e in items) or "No diary entries in that period."
    return {"text": "PIP diary log from SILAS\n\n" + text}
