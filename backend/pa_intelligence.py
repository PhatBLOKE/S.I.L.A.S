import datetime
import re
from typing import List, Dict, Any, Optional
from dateutil import parser as date_parser
from dateutil import tz

_DURATION_RE = re.compile(
    # Anchored so '3mm', '20mm_bracket' or 'm3_bolt' aren't mistaken for durations.
    r'(?<![a-z0-9])(?:(?P<h>\d+)h)?(?:(?P<m>\d+)m)?(?:(?P<s>\d+)s)?(?![a-z0-9])'
)


def parse_duration_from_filename(filename: str) -> Optional[int]:
    """
    Parses slicer duration tags in filenames like _52m32s or _1h55m.
    Useful when Moonraker is warming up and time_left_seconds is 0.
    """
    if not filename:
        return None
    for m in _DURATION_RE.finditer(filename.lower()):
        if not (m.group("h") or m.group("m")):
            continue
        total = int(m.group("h") or 0) * 3600 + int(m.group("m") or 0) * 60 + int(m.group("s") or 0)
        if total > 0:
            return total
    return None


LOCAL_TZ = tz.tzlocal()


def _now() -> datetime.datetime:
    return datetime.datetime.now(tz=LOCAL_TZ)


def _aware(value) -> Optional[datetime.datetime]:
    """Parse anything date-ish into a tz-aware local datetime."""
    if not value:
        return None
    try:
        dt = value if isinstance(value, datetime.datetime) else date_parser.parse(str(value))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt.astimezone(LOCAL_TZ)


def _hhmm(dt: datetime.datetime, ref: datetime.datetime) -> str:
    """'14:30', or 'Thu 14:30' when it isn't today."""
    return dt.strftime("%H:%M") if dt.date() == ref.date() else dt.strftime("%a %H:%M")


def _print_eta(p: Dict[str, Any], now: datetime.datetime) -> Optional[datetime.datetime]:
    eta = _aware(p.get("eta_timestamp"))
    if eta:
        return eta
    rem = p.get("time_left_seconds") or 0
    if rem <= 0:
        rem = parse_duration_from_filename(p.get("filename") or "") or 0
    return now + datetime.timedelta(seconds=rem) if rem > 0 else None


def _timed_events(calendar_events: List[Dict[str, Any]], now: datetime.datetime):
    """(event, start, end) for timed events that haven't finished. All-day events are ignored:
    a birthday or 'WFH' marker isn't a meeting you'd walk away from the printer for."""
    out = []
    for ev in calendar_events:
        if ev.get("is_all_day"):
            continue
        s, e = _aware(ev.get("start")), _aware(ev.get("end"))
        if not s:
            continue
        e = e or s + datetime.timedelta(hours=1)
        if e <= now:
            continue
        out.append((ev, s, e))
    out.sort(key=lambda t: t[1])
    return out


def calculate_calendar_radar(eta: datetime.datetime, event_start: datetime.datetime, event_name: str,
                             buffer_limit: int = 15, now: Optional[datetime.datetime] = None) -> Dict[str, Any]:
    """Buffer between a print finishing and the next timed event."""
    now = now or _now()
    buffer_minutes = int((event_start - eta).total_seconds() // 60)

    if buffer_minutes < 0:
        status = "alert"
        message = f"🚨 ALERT: Print job overruns '{event_name}' by {abs(buffer_minutes)} minutes!"
        recommendation = "💡 SILAS RECOMMENDATION: Shift workshop block out or pause print before toolchange."
    elif buffer_minutes <= buffer_limit:
        status = "tight"
        message = f"⚠️ WARNING: Tight buffer window ({buffer_minutes} mins) before '{event_name}'."
        recommendation = "Spine Safety: Do NOT rush to peel the part off the PEI sheet. Do your desk-decompression first."
    else:
        status = "clear"
        message = f"✅ PA RADAR ASSESSMENT: CLEAR. You have a comfortable {buffer_minutes}-minute buffer"
        recommendation = "to let the bed cool down and stretch your L4/L5/S1 discs before your next block."

    return {
        "status": status,
        "buffer_minutes": buffer_minutes,
        "estimated_completion": _hhmm(eta, now),
        "next_event_time": _hhmm(event_start, now),
        "next_event_name": event_name,
        "message": message,
        "recommendation": recommendation,
    }


def analyze_conflicts(printers_telemetry: List[Dict[str, Any]], calendar_events: List[Dict[str, Any]],
                      buffer_limit: int = 15, now: Optional[datetime.datetime] = None) -> List[Dict[str, Any]]:
    """
    One conflict per printer at most: the earliest event the print collides with is the
    one you can actually act on. Severity:
      high   - print still running when a meeting starts (unattended printing)
      medium - finishes within `buffer_limit` minutes before a meeting, or finishes while
               you're in a meeting that's already underway
    Early-print estimates (low confidence) are capped at medium to avoid crying wolf.
    """
    now = now or _now()
    events = _timed_events(calendar_events, now)
    conflicts = []

    for p in printers_telemetry:
        if not (p.get("online") and p.get("state") == "printing"):
            continue
        eta = _print_eta(p, now)
        if not eta:
            continue
        confidence = p.get("eta_confidence") or "medium"
        filename = p.get("filename") or "Current Job"

        for ev, ev_start, ev_end in events:
            if ev_start > eta + datetime.timedelta(minutes=buffer_limit):
                break  # sorted: nothing later can collide
            title = ev.get("title") or "Untitled Event"
            buffer_mins = int((ev_start - eta).total_seconds() // 60)
            ongoing = ev_start <= now

            if ongoing:
                if eta >= ev_end:
                    continue  # finishes after a meeting you're already in - you'll be back
                severity, kind = "medium", "during"
                msg = (f"⚠️ '{filename}' finishes at {_hhmm(eta, now)}, mid-way through '{title}' "
                       f"(ends {_hhmm(ev_end, now)}). It'll sit on the bed unattended until then.")
            elif eta > ev_start:
                severity, kind = "high", "overrun"
                msg = (f"🚨 Print job overruns '{title}' by {abs(buffer_mins)} mins! "
                       "Shift workshop block out or pause print before toolchange.")
            else:
                severity, kind = "medium", "tight"
                msg = (f"⚠️ Tight buffer window ({buffer_mins} mins) before '{title}'. Spine Safety: "
                       "Do NOT rush to peel the part off the PEI sheet. Do your desk-decompression first.")

            if severity == "high" and confidence == "low":
                severity = "medium"
                msg += " (Early estimate - Silas will firm this up as the print progresses.)"

            conflicts.append({
                "severity": severity,
                "kind": kind,
                "printer_id": p.get("id"),
                "printer_name": p.get("name", "Unknown Printer"),
                "filename": filename,
                "eta": _hhmm(eta, now),
                "eta_iso": eta.isoformat(),
                "eta_confidence": confidence,
                "event_title": title,
                "event_start": _hhmm(ev_start, now),
                "event_end": _hhmm(ev_end, now),
                "buffer_minutes": buffer_mins,
                "overrun_mins": max(0, -buffer_mins),
                "message": msg,
            })
            break

    conflicts.sort(key=lambda c: (c["severity"] != "high", c["eta_iso"]))
    return conflicts

def generate_briefing(printers_telemetry: List[Dict[str, Any]], calendar_events: List[Dict[str, Any]],
                      buffer_limit: int = 15) -> Dict[str, Any]:
    now = _now()

    todays_events = []
    upcoming_event = None
    upcoming_start = None
    for ev in calendar_events:
        ev_start = _aware(ev.get("start"))
        if not ev_start:
            continue
        if ev_start.date() == now.date():
            todays_events.append(ev)
        if ev_start > now and not ev.get("is_all_day") and (upcoming_start is None or ev_start < upcoming_start):
            upcoming_start = ev_start
            upcoming_event = {
                "title": ev.get("title"),
                "time": _hhmm(ev_start, now),
                "start": ev_start.isoformat(),
                "location": ev.get("location", "")
            }

    # Fleet statistics
    total_printers = len(printers_telemetry)
    printing_count = sum(1 for p in printers_telemetry if p.get("state") == "printing")
    standby_count = sum(1 for p in printers_telemetry if p.get("state") == "standby")
    error_count = sum(1 for p in printers_telemetry if p.get("state") == "error")
    offline_count = sum(1 for p in printers_telemetry if not p.get("online") or p.get("state") == "offline")

    # Sarcastic Silas greeting
    if printing_count > 0:
        fleet_comment = f"{printing_count} machine(s) extruding plastic without setting the workshop alight. Keep expectations low."
    else:
        fleet_comment = "All print heads are currently cold and dormant. A rare moment of mechanical tranquility."

    if len(todays_events) == 0:
        agenda_comment = "Your schedule appears suspiciously empty today. Try not to squander it on mindless scrolling."
    else:
        agenda_comment = f"You have {len(todays_events)} agenda item(s) to attend to. Try to be punctual for once."

    conflicts = analyze_conflicts(printers_telemetry, calendar_events, buffer_limit=buffer_limit, now=now)

    # Radar headline: the LAST print to finish vs the next timed event (that's when you're free).
    radar_assessment = None
    etas = [e for e in (_print_eta(p, now) for p in printers_telemetry
                        if p.get("online") and p.get("state") == "printing") if e]
    if upcoming_start and etas:
        radar_assessment = calculate_calendar_radar(max(etas), upcoming_start, upcoming_event["title"],
                                                    buffer_limit=buffer_limit, now=now)

    return {
        "timestamp": now.isoformat(),
        "collision_buffer_minutes": buffer_limit,
        "date_display": now.strftime("%A, %B %d"),
        "time_display": now.strftime("%H:%M"),
        "persona": "Silas",
        "greeting": f"Good day, Karl. Silas online.",
        "agenda_summary": agenda_comment,
        "fleet_summary": fleet_comment,
        "next_event": upcoming_event,
        "metrics": {
            "total_printers": total_printers,
            "printing": printing_count,
            "standby": standby_count,
            "error": error_count,
            "offline": offline_count,
            "events_today": len(todays_events)
        },
        "conflicts": conflicts,
        "radar_assessment": radar_assessment
    }


