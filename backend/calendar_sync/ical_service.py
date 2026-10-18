import asyncio
import datetime
import time
from typing import List, Dict, Any, Optional

import httpx
from icalendar import Calendar
from dateutil import tz
from ..config import get_calendar_config, get_local_events

try:
    import recurring_ical_events  # expands RRULE series (weekly meetings etc.)
except ImportError:  # pragma: no cover - degrade gracefully if not installed
    recurring_ical_events = None

WINDOW_PAST = datetime.timedelta(days=7)
WINDOW_FUTURE = datetime.timedelta(days=30)


def parse_datetime(value) -> Optional[datetime.datetime]:
    if value is None:
        return None
    val = getattr(value, "dt", value)
    if isinstance(val, datetime.date) and not isinstance(val, datetime.datetime):
        return datetime.datetime.combine(val, datetime.time.min).replace(tzinfo=tz.tzlocal())
    if isinstance(val, datetime.datetime):
        if val.tzinfo is None:
            val = val.replace(tzinfo=tz.tzlocal())
        return val.astimezone(tz.tzlocal())
    return None


def _component_to_event(component, idx: int) -> Optional[Dict[str, Any]]:
    dtstart = component.get("dtstart")
    start_dt = parse_datetime(dtstart)
    if not start_dt:
        return None
    is_all_day = not isinstance(getattr(dtstart, "dt", None), datetime.datetime)
    end_dt = parse_datetime(component.get("dtend"))
    if not end_dt:
        dur = component.get("duration")
        if dur is not None and hasattr(dur, "dt"):
            end_dt = start_dt + dur.dt
        else:
            end_dt = start_dt + (datetime.timedelta(days=1) if is_all_day else datetime.timedelta(hours=1))
    uid = str(component.get("uid") or f"ical-{idx}")
    # Recurring instances share a UID; make the id unique per occurrence.
    return {
        "id": f"{uid}@{start_dt.isoformat()}",
        "title": str(component.get("summary") or "Untitled Event"),
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "location": str(component.get("location") or ""),
        "description": str(component.get("description") or ""),
        "source": "google_ical",
        "is_all_day": is_all_day,
    }


def parse_ical(content: bytes, now: Optional[datetime.datetime] = None) -> List[Dict[str, Any]]:
    now = now or datetime.datetime.now(tz=tz.tzlocal())
    window_start, window_end = now - WINDOW_PAST, now + WINDOW_FUTURE
    cal = Calendar.from_ical(content)

    if recurring_ical_events is not None:
        components = recurring_ical_events.of(cal).between(window_start, window_end)
    else:
        components = [c for c in cal.walk() if c.name == "VEVENT"]

    events = []
    for i, comp in enumerate(components):
        if str(comp.get("status") or "").upper() == "CANCELLED":
            continue
        ev = _component_to_event(comp, i)
        if not ev:
            continue
        s = datetime.datetime.fromisoformat(ev["start"])
        e = datetime.datetime.fromisoformat(ev["end"])
        if s > window_end or e < window_start:
            continue
        events.append(ev)
    return sorted(events, key=lambda x: x["start"])


class CalendarCache:
    """Fetches the remote feed at most once per refresh interval and keeps the last good copy."""

    def __init__(self):
        self._events: List[Dict[str, Any]] = []
        self._fetched_at: float = 0.0
        self._url: Optional[str] = None
        self._lock = asyncio.Lock()
        self.last_error: Optional[str] = None
        self.last_success: Optional[str] = None

    def invalidate(self) -> None:
        self._fetched_at = 0.0

    async def remote_events(self, force: bool = False) -> List[Dict[str, Any]]:
        cfg = get_calendar_config()
        url = (cfg.get("ical_url") or "").strip()
        if not url:
            self._events, self._url = [], None
            return []
        if url.startswith("webcal://"):
            url = "https://" + url[len("webcal://"):]
        interval = max(1, int(cfg.get("refresh_interval_minutes") or 5)) * 60

        async with self._lock:
            fresh = (time.monotonic() - self._fetched_at) < interval and url == self._url
            if fresh and not force:
                return self._events
            try:
                async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                    resp = await client.get(url)
                if resp.status_code != 200:
                    raise RuntimeError(f"HTTP {resp.status_code}")
                self._events = await asyncio.to_thread(parse_ical, resp.content)
                self._url = url
                self.last_error = None
                self.last_success = datetime.datetime.now().astimezone().isoformat()
            except Exception as e:
                # Keep serving the last good copy; retry in a minute rather than hammering.
                self.last_error = str(e)[:200]
                print(f"[Calendar] Feed fetch failed: {self.last_error}")
                self._fetched_at = time.monotonic() - interval + 60
                return self._events
            self._fetched_at = time.monotonic()
            return self._events


calendar_cache = CalendarCache()


def _local_events() -> List[Dict[str, Any]]:
    out = []
    for le in get_local_events():
        ev = dict(le)
        ev["source"] = "local"
        ev.setdefault("is_all_day", False)
        out.append(ev)
    return out


def _sort_key(e: Dict[str, Any]):
    try:
        dt = datetime.datetime.fromisoformat(e.get("start", ""))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz.tzlocal())
        return dt.timestamp()
    except Exception:
        return float("inf")


async def get_all_calendar_events(force: bool = False) -> List[Dict[str, Any]]:
    events = list(await calendar_cache.remote_events(force=force)) + _local_events()
    events.sort(key=_sort_key)
    return events


# Back-compat for anything still importing the old name.
async def fetch_ical_events(ical_url: str) -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.get(ical_url)
    return parse_ical(resp.content) if resp.status_code == 200 else []
