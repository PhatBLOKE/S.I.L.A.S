"""Run from the project root:  python -m pytest backend/tests -q"""
import pytest

from backend import alerts as alerts_mod
from backend.alerts import AlertCenter, decode_u1


@pytest.fixture
def center(tmp_path, monkeypatch):
    monkeypatch.setattr(alerts_mod, "ALERTS_FILE", tmp_path / "alerts.json")
    c = AlertCenter()
    c.pushed = []
    c.on_alert(c.pushed.append)
    return c


def runout(index=1, level=2):
    return {"id": 523, "index": index, "code": 0, "level": level, "message": f"e{index}_filament runout"}


def test_decode_u1_code_matches_screen_format():
    d = decode_u1(523, 2, 38, 2, "detect filament tangled!")
    assert d["code"] == "0002-0523-0002-0038"
    assert d["title"] == "Filament tangled (T2)"
    assert d["severity"] == "warning" and d["action"] == "Print paused"


def test_unknown_module_still_reported():
    d = decode_u1(9999, 0, 7, 3, "mystery")
    assert d["severity"] == "critical" and d["message"] == "mystery"


def test_exception_is_pushed_and_deduplicated(center):
    center.snapmaker_exception("u1", "Snapmaker U1", runout())
    center.snapmaker_exception("u1", "Snapmaker U1", runout())
    assert len(center.unacknowledged()) == 1
    assert center.unacknowledged()[0]["count"] == 2
    assert len(center.pushed) == 2  # both raises reach the UI immediately


def test_status_marks_active_then_cleared(center):
    center.snapmaker_exception("u1", "Snapmaker U1", runout())
    center.snapmaker_status("u1", "Snapmaker U1", [runout()])
    assert center.unacknowledged()[0]["active"] is True
    center.snapmaker_status("u1", "Snapmaker U1", [])
    a = center.unacknowledged()[0]
    assert a["active"] is False and a.get("cleared_at")


def test_acknowledged_but_still_active_does_not_nag(center):
    center.snapmaker_status("u1", "Snapmaker U1", [runout()])
    center.acknowledge()
    center.snapmaker_status("u1", "Snapmaker U1", [runout()])  # e.g. next poll
    assert center.unacknowledged() == []


def test_reraise_after_clear_is_new_alert(center):
    center.snapmaker_status("u1", "Snapmaker U1", [runout()])
    center.acknowledge()
    center.snapmaker_status("u1", "Snapmaker U1", [])
    center.snapmaker_exception("u1", "Snapmaker U1", runout())
    assert len(center.unacknowledged()) == 1


def test_klipper_error_lines_throttled(center):
    center.klipper_error_line("p", "SV08", "!! Move out of range: 310 10 0.3")
    center.klipper_error_line("p", "SV08", "!! Move out of range: 310 10 0.3")
    assert len(center.unacknowledged()) == 1 and center.unacknowledged()[0]["count"] == 1


def test_alerts_survive_restart(center, tmp_path):
    center.snapmaker_exception("u1", "Snapmaker U1", runout())
    again = AlertCenter()
    assert len(again.unacknowledged()) == 1
