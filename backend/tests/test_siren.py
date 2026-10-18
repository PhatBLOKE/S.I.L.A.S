"""Siren rules: a print that stops on its own sets the siren off; you pausing it from SILAS doesn't."""
import pytest

from backend import alerts as alerts_mod
from backend import hub as hub_mod
from backend.alerts import AlertCenter


@pytest.fixture
def hub(tmp_path, monkeypatch):
    monkeypatch.setattr(alerts_mod, "ALERTS_FILE", tmp_path / "alerts.json")
    center = AlertCenter()
    monkeypatch.setattr(hub_mod, "alert_center", center)
    h = hub_mod.StateHub()
    h.center = center
    return h


def p(state, online=True, **kw):
    return {"id": "u1", "name": "Snapmaker U1", "state": state, "online": online, "filename": "bracket.gcode", **kw}


def run(h, *states):
    for s in states:
        h._check_transitions([s if isinstance(s, dict) else p(s)])
    return h.center.unacknowledged()


def test_runs_quietly_while_printing(hub):
    assert run(hub, "printing", "printing", "printing") == []


def test_finishing_normally_is_not_a_siren(hub):
    assert run(hub, "printing", "complete") == []


def test_pause_on_its_own_is_a_siren(hub):
    (a,) = run(hub, "printing", "paused")
    assert a["key"] == "state:paused" and a["siren"] is True and a["severity"] == "critical"
    assert "bracket.gcode" in a["message"]


def test_pause_from_havoc_is_not(hub):
    run(hub, "printing")
    hub.note_command("u1", "pause")
    assert run(hub, "paused") == []


def test_cancel_or_abort_mid_print_is_a_siren(hub):
    (a,) = run(hub, "printing", "standby")
    assert a["key"] == "state:stopped" and a["siren"] is True


def test_cancel_from_havoc_is_not(hub):
    run(hub, "printing")
    hub.note_command("u1", "cancel")
    assert run(hub, "standby") == []


def test_error_mid_print_is_a_siren_but_not_when_idle(hub):
    (a,) = run(hub, "printing", "error")
    assert a["siren"] is True
    hub.center.acknowledge()
    run(hub, "standby", "standby")
    (b,) = run(hub, "error")
    assert not b.get("siren")


def test_lost_contact_siren_waits_a_minute(hub):
    (a,) = run(hub, "printing", p("offline", online=False))
    assert a["siren"] is True and a["siren_delay"] == 60


def test_u1_popup_mid_print_is_a_siren_and_not_doubled(hub):
    run(hub, "printing")
    hub.center.snapmaker_exception("u1", "Snapmaker U1",
                                   {"id": 523, "index": 1, "code": 0, "level": 2, "message": "e1_filament runout"})
    alerts = run(hub, "paused")
    assert len(alerts) == 1 and alerts[0]["source"] == "snapmaker" and alerts[0]["siren"] is True


def test_u1_notice_or_idle_popup_is_not_a_siren(hub):
    run(hub, "standby")
    hub.center.snapmaker_exception("u1", "Snapmaker U1",
                                   {"id": 533, "index": 0, "code": 0, "level": 2, "message": "purifier"})
    run(hub, "printing")
    hub.center.snapmaker_exception("u1", "Snapmaker U1",
                                   {"id": 524, "index": 0, "code": 1, "level": 1, "message": "camera"})
    assert not any(a.get("siren") for a in hub.center.unacknowledged())
