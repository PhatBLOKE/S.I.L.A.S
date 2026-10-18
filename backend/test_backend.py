import asyncio
import datetime
from backend.config import get_printers, get_local_events, add_local_event, delete_local_event
from backend.printers.manager import fleet_manager
from backend.pa_intelligence import analyze_conflicts, generate_briefing

async def run_tests():
    print("[1/5] Testing Fleet Manager...")
    status = await fleet_manager.get_all_status()
    print(f"  Fleet status retrieved: {len(status)} configured printers.")
    for p in status:
        print(f"  -> {p['name']} ({p['type']}): State={p['state']}, Online={p['online']}")

    print("\n[2/5] Testing Printer Dynamic Add/Delete...")
    new_p = fleet_manager.add_printer({
        "name": "OctoPrint Lab Test",
        "type": "octoprint",
        "host": "192.168.1.150",
        "port": 5000,
        "api_key": "testkey123",
        "enabled": False
    })
    print(f"  Added printer ID: {new_p['id']}")
    assert any(p["id"] == new_p["id"] for p in get_printers())
    
    fleet_manager.delete_printer(new_p["id"])
    assert not any(p["id"] == new_p["id"] for p in get_printers())
    print("  Successfully added and removed dynamic printer!")

    print("\n[3/5] Testing Calendar Local Events...")
    test_id = f"test-{datetime.datetime.now().timestamp()}"
    add_local_event({
        "id": test_id,
        "title": "Silas Diagnostics Test",
        "start": "2026-09-16T20:00:00",
        "end": "2026-09-16T21:00:00",
        "location": "Local",
        "description": "System check."
    })
    assert any(e["id"] == test_id for e in get_local_events())
    delete_local_event(test_id)
    assert not any(e["id"] == test_id for e in get_local_events())
    print("  Calendar event CRUD verified!")

    print("\n[4/5] Testing PA Collision Radar...")
    now = datetime.datetime.now()
    meeting_start = now + datetime.timedelta(minutes=30)
    meeting_end = now + datetime.timedelta(minutes=90)
    print_eta = now + datetime.timedelta(minutes=45)

    mock_printers = [{
        "id": "p1",
        "name": "Sovol SV08",
        "type": "moonraker",
        "online": True,
        "state": "printing",
        "filename": "benchy_fast.gcode",
        "eta_timestamp": print_eta.isoformat()
    }]
    mock_events = [{
        "id": "ev1",
        "title": "Product Strategy Call",
        "start": meeting_start.isoformat(),
        "end": meeting_end.isoformat()
    }]

    conflicts = analyze_conflicts(mock_printers, mock_events)
    print(f"  Detected {len(conflicts)} conflict(s):")
    for c in conflicts:
        print(f"  -> [{c['severity'].upper()}] {c['message']}")
    assert len(conflicts) > 0, "Failed to detect conflict!"

    print("\n[5/7] Testing Executive Briefing Generator...")
    briefing = generate_briefing(mock_printers, mock_events)
    print(f"  Briefing greeting: {briefing['greeting']}")
    print(f"  Fleet summary: {briefing['fleet_summary']}")
    print(f"  Agenda summary: {briefing['agenda_summary']}")
    assert "Silas" in briefing["greeting"]

    print("\n[6/7] Testing Active Toolhead Tracking...")
    from backend.printers.base import ToolheadInfo, PrinterTelemetry
    mock_telemetry = PrinterTelemetry(
        id="p-tool",
        name="Voron StealthChanger",
        type="moonraker",
        online=True,
        state="printing",
        active_toolhead="T1",
        toolheads=[
            ToolheadInfo(id="T0", name="Tool 0 (PLA)", extruder_temp=150.0, is_active=False),
            ToolheadInfo(id="T1", name="Tool 1 (PETG)", extruder_temp=240.0, is_active=True)
        ]
    )
    assert mock_telemetry.active_toolhead == "T1"
    assert len(mock_telemetry.toolheads) == 2
    print(f"  Active toolhead confirmed: {mock_telemetry.active_toolhead} with {len(mock_telemetry.toolheads)} tools registered.")

    print("\n[7/7] Testing AI Companion Diagnostics...")
    from backend.ai_companion import get_ai_response, analyze_printer_telemetry
    
    # Test query matching
    ai_res1 = get_ai_response("Why is my first layer peeling and lifting off the bed?")
    assert "First Layer" in ai_res1.get("topic", "") or "First layer" in ai_res1.get("reply", "")
    print("  -> First layer query recognized and handled.")

    ai_res2 = get_ai_response("I have an error with eddy probe sensor_type")
    assert "Eddy" in ai_res2.get("topic", "") or "Eddy" in ai_res2.get("reply", "")
    print("  -> Eddy current probe query recognized and handled.")

    # Test printer telemetry diagnosis
    diag = analyze_printer_telemetry(mock_telemetry.model_dump())
    assert "T1" in diag
    print("  -> Live printer telemetry diagnosis verified with active toolhead.")

    print("\nALL 7 BACKEND TESTS PASSED WITH FLYING COLORS!")

if __name__ == "__main__":
    asyncio.run(run_tests())
