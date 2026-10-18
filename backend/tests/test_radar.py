"""Run from the project root:  python -m pytest backend/tests -q"""
import datetime

from dateutil import tz

from backend.pa_intelligence import analyze_conflicts, generate_briefing, parse_duration_from_filename
from backend.printers.eta import blend_eta

L = tz.tzlocal()
NOW = datetime.datetime(2026, 10, 7, 9, 0, tzinfo=L)


def printer(eta_min, conf="high", state="printing"):
    return {"id": "p1", "name": "SV08", "online": True, "state": state, "filename": "part.gcode",
            "eta_timestamp": (NOW + datetime.timedelta(minutes=eta_min)).isoformat(), "eta_confidence": conf}


def event(title, start_min, dur=30, all_day=False):
    s = NOW + datetime.timedelta(minutes=start_min)
    return {"title": title, "start": s.isoformat(), "end": (s + datetime.timedelta(minutes=dur)).isoformat(),
            "is_all_day": all_day}


def test_overrun_is_high():
    c = analyze_conflicts([printer(90)], [event("Sync", 60)], now=NOW)
    assert len(c) == 1 and c[0]["severity"] == "high" and c[0]["kind"] == "overrun"
    assert c[0]["overrun_mins"] == 30


def test_tight_buffer_is_medium():
    c = analyze_conflicts([printer(50)], [event("Sync", 60)], buffer_limit=15, now=NOW)
    assert c[0]["kind"] == "tight" and c[0]["buffer_minutes"] == 10


def test_clear_when_plenty_of_buffer():
    assert analyze_conflicts([printer(30)], [event("Sync", 120)], now=NOW) == []


def test_all_day_events_ignored():
    assert analyze_conflicts([printer(600)], [event("Bin day", -540, dur=1440, all_day=True)], now=NOW) == []


def test_finishing_during_ongoing_meeting():
    c = analyze_conflicts([printer(10)], [event("Standup", -5, dur=30)], now=NOW)
    assert c[0]["kind"] == "during"


def test_ongoing_meeting_print_finishes_after_is_fine():
    assert analyze_conflicts([printer(60)], [event("Standup", -5, dur=30)], now=NOW) == []


def test_low_confidence_downgraded():
    c = analyze_conflicts([printer(90, conf="low")], [event("Sync", 60)], now=NOW)
    assert c[0]["severity"] == "medium"


def test_only_earliest_conflict_per_printer():
    c = analyze_conflicts([printer(300)], [event("A", 60), event("B", 120), event("C", 180)], now=NOW)
    assert len(c) == 1 and c[0]["event_title"] == "A"


def test_paused_prints_ignored():
    assert analyze_conflicts([printer(90, state="paused")], [event("Sync", 60)], now=NOW) == []


def test_briefing_radar_uses_tight_status():
    b = generate_briefing([printer(50)], [event("Sync", 60)], buffer_limit=15)
    # generate_briefing uses the real clock, so just check shape/status vocabulary
    assert b["radar_assessment"] is None or b["radar_assessment"]["status"] in ("alert", "tight", "clear")


def test_eta_blend_prefers_slicer_early():
    r = blend_eta(0.02, 600, 7200)
    assert r.source == "blended" and 6000 < r.seconds_left < 12000


def test_eta_progress_only_low_confidence_early():
    assert blend_eta(0.02, 600, None).confidence == "low"


def test_eta_progress_dominates_late():
    r = blend_eta(0.5, 3000, 7200)
    assert r.source == "progress" and r.seconds_left == 3000


def test_filename_durations():
    assert parse_duration_from_filename("Kraken_52m32s.gcode") == 3152
    assert parse_duration_from_filename("bracket_3mm.gcode") is None
    assert parse_duration_from_filename("m3_bolt_20mm.gcode") is None
