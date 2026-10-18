"""
SILAS <-> Todoist link: the TODAY tab, the Mission Control focus strip and Silas's
"what is Karl meant to be doing" context.

Todoist stays the master copy. SILAS reads and writes it live through the official
API (https://api.todoist.com/api/v1), using the personal API token saved in
backend/data/config.json under "todoist" -> "api_token". The token never leaves
this machine: the browser only ever sees it masked.

Conventions the UI relies on (set up in Todoist on 18 Oct 2026):
  * "Daily Routine" project: the time blocks of the day (recurring tasks with times).
  * "Projects" project: sections Now / Next / Money / Admin / Parked / Idea inbox.
    Only ONE task should live in Now at a time.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import time
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config import (
    CLEAR_KEY,
    _lock,
    is_masked,
    load_config,
    mask_secret,
    save_config,
)

API_URL = "https://api.todoist.com/api/v1"
ROUTINE_PROJECT = "daily routine"
PROJECTS_PROJECT = "projects"
SECTION_ORDER = ["now", "next", "money", "admin", "parked", "idea inbox"]

router = APIRouter(prefix="/api/todoist", tags=["todoist"])

_client: Optional[httpx.AsyncClient] = None


# --------------------------------------------------------------------------- config
def get_token() -> str:
    cfg = load_config()
    return ((cfg.get("todoist") or {}).get("api_token") or "").strip()


def set_token(value: Optional[str]) -> None:
    with _lock:
        cfg = load_config()
        td = dict(cfg.get("todoist") or {})
        if value is None or is_masked(value):
            return
        value = value.strip()
        if value == CLEAR_KEY:
            td["api_token"] = ""
        elif value:
            td["api_token"] = value
        else:
            return
        cfg["todoist"] = td
        save_config(cfg)
    _cache.clear()


# --------------------------------------------------------------------------- http
class TodoistError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(base_url=API_URL, timeout=httpx.Timeout(12.0, connect=5.0))
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


async def _request(method: str, path: str, *, params: Optional[dict] = None, json: Optional[dict] = None) -> Any:
    token = get_token()
    if not token:
        raise TodoistError(412, "No Todoist token saved yet. Add it in the TODAY tab settings.")
    try:
        r = await _http().request(
            method, path, params=params, json=json,
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as e:
        raise TodoistError(503, f"Couldn't reach Todoist ({type(e).__name__}). Check the internet connection.")
    if r.status_code in (401, 403):
        raise TodoistError(401, "Todoist rejected the token. Paste a fresh one from Todoist → Settings → Integrations → Developer.")
    if r.status_code == 429:
        raise TodoistError(429, "Todoist says slow down (rate limit). Try again in a minute.")
    if r.status_code >= 400:
        detail = r.text[:300]
        try:
            j = r.json()
            detail = j.get("error") or j.get("error_tag") or detail
        except Exception:
            pass
        raise TodoistError(r.status_code if r.status_code < 500 else 502, f"Todoist error: {detail}")
    if r.status_code == 204 or not r.content:
        return {}
    try:
        return r.json()
    except ValueError:
        return {}


async def _paged(path: str, params: Optional[dict] = None, max_pages: int = 10) -> List[dict]:
    out: List[dict] = []
    cursor: Optional[str] = None
    for _ in range(max_pages):
        p = dict(params or {})
        p["limit"] = 200
        if cursor:
            p["cursor"] = cursor
        data = await _request("GET", path, params=p)
        if isinstance(data, list):  # defensive: older shape
            return out + data
        out.extend(data.get("results") or [])
        cursor = data.get("next_cursor")
        if not cursor:
            break
    return out


async def _sync(commands: List[dict]) -> dict:
    """Sync API write, used where the REST API has no equivalent (keeping a repeat while moving the date)."""
    import json as _json
    import uuid
    for c in commands:
        c.setdefault("uuid", str(uuid.uuid4()))
    token = get_token()
    if not token:
        raise TodoistError(412, "No Todoist token saved yet.")
    try:
        r = await _http().post("/sync", data={"commands": _json.dumps(commands)},
                               headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as e:
        raise TodoistError(503, f"Couldn't reach Todoist ({type(e).__name__}).")
    if r.status_code >= 400:
        raise TodoistError(502, f"Todoist error: {r.text[:300]}")
    data = r.json()
    for c in commands:
        st = (data.get("sync_status") or {}).get(c["uuid"])
        if st != "ok":
            msg = st.get("error") if isinstance(st, dict) else str(st)
            raise TodoistError(400, f"Todoist refused the change: {msg}")
    return data


# --------------------------------------------------------------------------- shaping
def _prio(api_priority: Any) -> str:
    # The API counts the other way round: 4 = P1 (red), 1 = P4 (none).
    try:
        return f"p{5 - int(api_priority)}"
    except (TypeError, ValueError):
        return "p4"


def _api_prio(p: str) -> int:
    try:
        return 5 - int(str(p).lower().lstrip("p"))
    except ValueError:
        return 1


def shape_task(t: dict) -> dict:
    due = t.get("due") or None
    return {
        "id": str(t.get("id")),
        "content": t.get("content") or "",
        "description": t.get("description") or "",
        "project_id": str(t.get("project_id") or ""),
        "section_id": str(t["section_id"]) if t.get("section_id") else None,
        "parent_id": str(t["parent_id"]) if t.get("parent_id") else None,
        "priority": _prio(t.get("priority", 1)),
        "order": t.get("child_order", t.get("order", 0)) or 0,
        "due": {
            "date": due.get("date"),
            "string": due.get("string") or "",
            "is_recurring": bool(due.get("is_recurring")),
        } if due else None,
        "labels": t.get("labels") or [],
    }


def shape_project(p: dict) -> dict:
    return {
        "id": str(p.get("id")),
        "name": p.get("name") or "",
        "inbox": bool(p.get("inbox_project") or p.get("is_inbox_project")),
        "order": p.get("child_order", 0) or 0,
        "archived": bool(p.get("is_archived")),
        "description": p.get("description") or "",
    }


def shape_section(s: dict) -> dict:
    return {
        "id": str(s.get("id")),
        "name": s.get("name") or "",
        "project_id": str(s.get("project_id") or ""),
        "order": s.get("section_order", 0) or 0,
    }


def section_rank(name: str) -> int:
    n = (name or "").lower()
    for i, key in enumerate(SECTION_ORDER):
        if n.startswith(key):
            return i
    return 99


# --------------------------------------------------------------------------- cached reads
class _Cache:
    def __init__(self):
        self.data: Dict[str, Any] = {}

    def get(self, key: str, max_age: float):
        hit = self.data.get(key)
        if hit and time.time() - hit[0] < max_age:
            return hit[1]
        return None

    def put(self, key: str, value: Any):
        self.data[key] = (time.time(), value)
        return value

    def clear(self):
        self.data.clear()


_cache = _Cache()


async def get_projects(max_age: float = 300) -> List[dict]:
    hit = _cache.get("projects", max_age)
    if hit is not None:
        return hit
    projects = [shape_project(p) for p in await _paged("/projects")]
    projects = [p for p in projects if not p["archived"]]
    projects.sort(key=lambda p: (not p["inbox"], p["order"]))
    return _cache.put("projects", projects)


def _find_project(projects: List[dict], name: str) -> Optional[dict]:
    return next((p for p in projects if p["name"].strip().lower() == name), None)


async def get_board(project_id: str) -> dict:
    sections, tasks = await asyncio.gather(
        _paged("/sections", {"project_id": project_id}),
        _paged("/tasks", {"project_id": project_id}),
    )
    secs = sorted((shape_section(s) for s in sections), key=lambda s: (section_rank(s["name"]), s["order"]))
    items = sorted((shape_task(t) for t in tasks), key=lambda t: t["order"])
    return {"project_id": project_id, "sections": secs, "tasks": items}


async def get_today(max_age: float = 0) -> List[dict]:
    hit = _cache.get("today", max_age) if max_age else None
    if hit is not None:
        return hit
    tasks = [shape_task(t) for t in await _paged("/tasks/filter", {"query": "today | overdue"})]
    tasks.sort(key=lambda t: ((t["due"] or {}).get("date") or "9999"))
    return _cache.put("today", tasks)


def _due_dt(task: dict) -> Optional[dt.datetime]:
    d = (task.get("due") or {}).get("date")
    if not d or "T" not in d:
        return None
    try:
        v = dt.datetime.fromisoformat(d.replace("Z", "+00:00"))
        if v.tzinfo is not None:
            v = v.astimezone().replace(tzinfo=None)
        return v
    except ValueError:
        return None


async def get_focus(max_age: float = 45) -> dict:
    """What matters right now: current routine block, the Now task, what's next, how much is overdue."""
    hit = _cache.get("focus", max_age)
    if hit is not None:
        return hit
    projects = await get_projects()
    today = await get_today(max_age=max_age)
    now = dt.datetime.now()
    today_key = now.date().isoformat()

    routine = _find_project(projects, ROUTINE_PROJECT)
    timed = sorted(
        [t for t in today if _due_dt(t) and _due_dt(t).date().isoformat() == today_key
         and (not routine or t["project_id"] == routine["id"])],
        key=lambda t: _due_dt(t),
    )
    current = None
    upcoming = None
    for t in timed:
        if _due_dt(t) <= now:
            current = t
        elif upcoming is None:
            upcoming = t

    now_tasks: List[dict] = []
    next_tasks: List[dict] = []
    proj = _find_project(projects, PROJECTS_PROJECT)
    if proj:
        try:
            board = await get_board(proj["id"])
            for s in board["sections"]:
                rank = section_rank(s["name"])
                if rank == 0:
                    now_tasks = [t for t in board["tasks"] if t["section_id"] == s["id"]]
                elif rank == 1:
                    next_tasks = [t for t in board["tasks"] if t["section_id"] == s["id"]]
        except TodoistError:
            pass

    overdue = [t for t in today if (t["due"] or {}).get("date", "")[:10] < today_key]
    result = {
        "configured": True,
        "current_block": current,
        "next_block": upcoming,
        "now": now_tasks,
        "next": next_tasks,
        "overdue_count": len(overdue),
        "today_count": len(today),
        "generated_at": time.time(),
    }
    return _cache.put("focus", result)


async def focus_text() -> str:
    """One compact paragraph for Silas's system prompt. Never raises."""
    if not get_token():
        return ""
    try:
        f = await get_focus()
    except Exception:
        return ""
    parts = []
    if f.get("current_block"):
        parts.append(f"current routine block: {f['current_block']['content']}")
    if f.get("next_block"):
        nb = f["next_block"]
        t = (_due_dt(nb) or dt.datetime.now()).strftime("%H:%M")
        parts.append(f"next block at {t}: {nb['content']}")
    if f.get("now"):
        parts.append("NOW project (the only thing he should be building): " + "; ".join(t["content"] for t in f["now"]))
        if len(f["now"]) > 1:
            parts.append("WARNING: more than one task in Now")
    if f.get("next"):
        parts.append("Next up: " + "; ".join(t["content"] for t in f["next"][:3]))
    if f.get("overdue_count"):
        parts.append(f"{f['overdue_count']} overdue Todoist tasks")
    if not parts:
        return ""
    return ("\nKarl's plan from Todoist (he has ADHD; help him start and finish ONE thing, nudge him back to "
            "the Now project if he drifts, remind him to eat around midday): " + " | ".join(parts))


# --------------------------------------------------------------------------- routes
def _err(e: TodoistError):
    raise HTTPException(status_code=e.status, detail=e.message)


class TokenModel(BaseModel):
    api_token: str


class NewTaskModel(BaseModel):
    content: str
    description: Optional[str] = None
    project_id: Optional[str] = None
    section_id: Optional[str] = None
    due_string: Optional[str] = None
    priority: Optional[str] = None


class UpdateTaskModel(BaseModel):
    content: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    due_string: Optional[str] = None   # natural language, "none" clears the date
    date: Optional[str] = None         # YYYY-MM-DD: move the date, keep the time and any repeat


class MoveModel(BaseModel):
    section_id: Optional[str] = None
    project_id: Optional[str] = None


class ReorderModel(BaseModel):
    ids: List[str]


@router.get("/status")
def status():
    tok = get_token()
    return {"configured": bool(tok), "token": mask_secret(tok)}


@router.post("/config")
async def save_config_route(req: TokenModel):
    set_token(req.api_token)
    if not get_token():
        return {"success": True, "configured": False}
    try:
        projects = await get_projects(max_age=0)
    except TodoistError as e:
        _err(e)
    return {"success": True, "configured": True, "projects": len(projects)}


@router.get("/projects")
async def projects_route(fresh: bool = False):
    try:
        return await get_projects(max_age=0 if fresh else 300)
    except TodoistError as e:
        _err(e)


@router.get("/board/{project_id}")
async def board_route(project_id: str):
    try:
        return await get_board(project_id)
    except TodoistError as e:
        _err(e)


@router.get("/today")
async def today_route():
    try:
        return await get_today(max_age=0)
    except TodoistError as e:
        _err(e)


@router.get("/focus")
async def focus_route(fresh: bool = False):
    if not get_token():
        return {"configured": False}
    try:
        return await get_focus(max_age=0 if fresh else 45)
    except TodoistError as e:
        _err(e)


@router.post("/tasks")
async def add_task_route(req: NewTaskModel):
    body: Dict[str, Any] = {"content": req.content.strip()}
    if not body["content"]:
        raise HTTPException(status_code=400, detail="A task needs a title.")
    if req.description:
        body["description"] = req.description
    if req.section_id:
        body["section_id"] = req.section_id
    if req.project_id and req.project_id != "inbox":
        body["project_id"] = req.project_id
    if req.due_string:
        body["due_string"] = req.due_string
    if req.priority:
        body["priority"] = _api_prio(req.priority)
    try:
        t = await _request("POST", "/tasks", json=body)
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return shape_task(t)


@router.post("/tasks/{task_id}")
async def update_task_route(task_id: str, req: UpdateTaskModel):
    body: Dict[str, Any] = {}
    if req.content is not None and req.content.strip():
        body["content"] = req.content.strip()
    if req.description is not None:
        body["description"] = req.description
    if req.priority:
        body["priority"] = _api_prio(req.priority)
    if req.due_string is not None and req.due_string.strip():
        s = req.due_string.strip()
        body["due_string"] = "no date" if s.lower() in ("none", "no date", "clear", "remove") else s
    try:
        task = None
        if body:
            task = await _request("POST", f"/tasks/{task_id}", json=body)
        if req.date and not body.get("due_string"):
            task = await _move_date(task_id, req.date, task)
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return {"success": True}


async def _move_date(task_id: str, new_date: str, task: Optional[dict]) -> dict:
    try:
        dt.date.fromisoformat(new_date)
    except ValueError:
        raise TodoistError(400, "Date must look like 2026-10-20.")
    if task is None:
        task = await _request("GET", f"/tasks/{task_id}")
    due = task.get("due") or {}
    old = due.get("date") or ""
    time_part = old[10:] if len(old) > 10 else ""  # e.g. "T07:00:00"
    if due.get("is_recurring"):
        # The REST API would drop the repeat; the Sync API keeps it when the string is resent.
        await _sync([{
            "type": "item_update",
            "args": {"id": task_id, "due": {"date": new_date + time_part, "string": due.get("string"),
                                             "lang": due.get("lang") or "en", "is_recurring": True}},
        }])
        return task
    if time_part:
        return await _request("POST", f"/tasks/{task_id}", json={"due_datetime": new_date + time_part})
    return await _request("POST", f"/tasks/{task_id}", json={"due_date": new_date})


@router.post("/tasks/{task_id}/move")
async def move_task_route(task_id: str, req: MoveModel):
    body = {"section_id": req.section_id} if req.section_id else ({"project_id": req.project_id} if req.project_id else None)
    if not body:
        raise HTTPException(status_code=400, detail="Say where to move it (section_id or project_id).")
    try:
        await _request("POST", f"/tasks/{task_id}/move", json=body)
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return {"success": True}


@router.post("/tasks/{task_id}/close")
async def close_task_route(task_id: str):
    try:
        await _request("POST", f"/tasks/{task_id}/close")
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return {"success": True}


@router.delete("/tasks/{task_id}")
async def delete_task_route(task_id: str):
    try:
        await _request("DELETE", f"/tasks/{task_id}")
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return {"success": True}


@router.post("/reorder")
async def reorder_route(req: ReorderModel):
    ids = [i for i in req.ids if i][:60]
    if not ids:
        return {"success": True}
    try:
        await _sync([{"type": "item_reorder", "args": {"items": [{"id": i, "child_order": n + 1} for n, i in enumerate(ids)]}}])
    except TodoistError as e:
        _err(e)
    _cache.clear()
    return {"success": True}
