"""
SILAS state hub.

One background loop owns all polling. Every tick it:
  1. polls the whole fleet once (pooled HTTP, all printers in parallel)
  2. reads the calendar from cache (remote feed refreshed per refresh_interval_minutes)
  3. runs the collision engine
  4. pushes the snapshot to every connected WebSocket client

REST endpoints read the same snapshot, so N browser tabs no longer mean N x printers
x Google requests every 3 seconds.
"""
import asyncio
import datetime
import json
import time
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket

from .alerts import HAVOC_LINES, alert_center
from .ai_usage import ai_usage
from .calendar_sync.ical_service import calendar_cache, get_all_calendar_events
from .config import get_pa_settings
from .pa_intelligence import generate_briefing
from .printers.manager import fleet_manager

POLL_INTERVAL_ACTIVE = 2.0   # someone is watching (WS client or recent REST hit)
POLL_INTERVAL_IDLE = 10.0    # nobody looking: keep the radar alive, go easy on the printers
REST_ACTIVITY_WINDOW = 15.0
HAVOC_STOPPED = HAVOC_LINES["stopped"]


class StateHub:
    def __init__(self) -> None:
        self.snapshot: Optional[Dict[str, Any]] = None
        self._clients: Set[WebSocket] = set()
        self._wake = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._refresh_lock = asyncio.Lock()
        self._last_rest_hit = 0.0
        self.tick = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._prev_states: Dict[str, Dict[str, Any]] = {}
        self._commands: Dict[str, Dict[str, Any]] = {}  # printer id -> last command sent from SILAS
        alert_center.on_alert(self._on_alert)
        alert_center.busy_check = self._is_busy
        ai_usage.on_back(self._ai_back)

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name="havoc-hub")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        await fleet_manager.stop_listeners()

    # ---------------------------------------------------------------- alerts
    def _on_alert(self, alert: Dict[str, Any]) -> None:
        """Push alerts the instant they arrive - don't wait for the next poll tick."""
        if not self._loop:
            return
        payload = {"type": "alert", "alert": alert, "alerts": alert_center.unacknowledged()}
        if self.snapshot is not None:
            self.snapshot["alerts"] = payload["alerts"]
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._loop.create_task(self._broadcast(payload))
        else:
            asyncio.run_coroutine_threadsafe(self._broadcast(payload), self._loop)

    async def push_alerts(self) -> None:
        alerts = alert_center.unacknowledged()
        if self.snapshot is not None:
            self.snapshot["alerts"] = alerts
        await self._broadcast({"type": "alerts", "alerts": alerts})

    @staticmethod
    def _ai_back(svc: Dict[str, Any]) -> None:
        alert_center.raise_alert(
            printer_id=f"ai:{svc['id']}", printer_name=svc.get("name", "AI app"), source="ai",
            key="ai:back", severity="info", title=f"{svc.get('name', 'AI app')} is back",
            message=f"{svc.get('name', 'Your AI app')}'s usage limit has reset. Go and break it again.",
            havoc="Your other brain has finished its nap. Try not to burn through it in an hour this time.",
            extra={"help_url": svc.get("url") or None}, active=False)

    # ---------------------------------------------------------------- siren helpers
    def _is_busy(self, pid: str) -> bool:
        return (self._prev_states.get(pid) or {}).get("state") in ("printing", "paused")

    def note_command(self, pid: str, command: str) -> None:
        """A pause/cancel you pressed in SILAS shouldn't set the siren off."""
        self._commands[pid] = {"command": command, "at": time.time()}

    def _you_did_it(self, pid: str, commands, within: float = 90.0) -> bool:
        c = self._commands.get(pid)
        return bool(c and c["command"] in commands and time.time() - c["at"] < within)

    def _check_transitions(self, fleet: List[Dict[str, Any]]) -> None:
        """Alerts SILAS raises itself from state changes, for every printer type."""
        for p in fleet:
            pid, name = p.get("id"), p.get("name", "Printer")
            prev = self._prev_states.get(pid)
            state = p.get("state")
            if prev is not None:
                was = prev.get("state")
                mid_print = was in ("printing", "paused")
                job = p.get("filename") or p.get("file") or ""
                job_txt = f" ({job})" if job else ""
                if state == "error" and was != "error":
                    msg = (p.get("error_message") or "Printer reported an error.").strip()
                    alert_center.raise_alert(
                        printer_id=pid, printer_name=name, source="klipper", key="klippy:shutdown",
                        severity="critical", title="Printer error", message=msg,
                        extra={"siren": mid_print and not self._you_did_it(pid, ("emergency_stop",))})
                # Print stopped on its own: paused or dropped back to standby/cancelled mid-job.
                # (A U1 pop-up for the same stop already carries the siren, so don't double up.)
                elif was == "printing" and state == "paused" and p.get("online") \
                        and not self._you_did_it(pid, ("pause",)) \
                        and not alert_center.recent(pid, 60, source="snapmaker", siren_only=True):
                    alert_center.raise_alert(
                        printer_id=pid, printer_name=name, source="state", key="state:paused",
                        severity="critical", title="Print paused",
                        message=f"{name} paused itself mid-print{job_txt}.",
                        havoc=HAVOC_STOPPED, extra={"siren": True})
                elif mid_print and state == "standby" and p.get("online") \
                        and not self._you_did_it(pid, ("cancel", "emergency_stop")) \
                        and not alert_center.recent(pid, 60, source="snapmaker", siren_only=True):
                    alert_center.raise_alert(
                        printer_id=pid, printer_name=name, source="state", key="state:stopped",
                        severity="critical", title="Print stopped",
                        message=f"{name} stopped mid-print{job_txt} - the job was cancelled or aborted.",
                        havoc=HAVOC_STOPPED, extra={"siren": True})
                elif was == "error" and state != "error" and p.get("online"):
                    alert_center.resolve(pid, keep_keys=None, source="klipper")
                if was in ("printing", "paused") and not p.get("online"):
                    alert_center.raise_alert(
                        printer_id=pid, printer_name=name, source="state", key="state:lost",
                        severity="warning", title="Lost contact mid-print",
                        # siren only if it stays gone for a minute (Wi-Fi blips happen)
                        extra={"siren": True, "siren_delay": 60},
                        message=f"SILAS can't reach {name} any more and it was {was}. "
                                f"Check power / network: {(p.get('error_message') or '')[:80]}")
                elif prev.get("online") is False and p.get("online"):
                    alert_center.resolve(pid, source="state")

            # U1 exception list from polling: only trusted when the live link is down,
            # because the websocket also carries system-level exceptions polling can't see.
            lst = fleet_manager.listener(pid)
            if lst is not None:
                p["event_link"] = "live" if lst.connected else "down"
                if not lst.connected and p.get("online") and "printer_exceptions" in p:
                    if p["printer_exceptions"] or prev and prev.get("had_u1_exc"):
                        alert_center.snapmaker_status(pid, name, p["printer_exceptions"])
            self._prev_states[pid] = {"state": state, "online": p.get("online"),
                                      "had_u1_exc": bool(p.get("printer_exceptions"))}

    def poke(self, calendar: bool = False) -> None:
        """Refresh now (after a command or config change) instead of waiting for the next tick."""
        if calendar:
            calendar_cache.invalidate()
        self._wake.set()

    def mark_rest_activity(self) -> None:
        self._last_rest_hit = asyncio.get_event_loop().time()

    # ---------------------------------------------------------------- polling
    async def refresh(self) -> Dict[str, Any]:
        async with self._refresh_lock:
            await fleet_manager.sync_listeners()
            ai_usage.tick()
            fleet, events = await asyncio.gather(
                fleet_manager.get_all_status(),
                get_all_calendar_events(),
            )
            buffer_limit = int(get_pa_settings().get("collision_buffer_minutes", 15) or 15)
            self._check_transitions(fleet)
            briefing = generate_briefing(fleet, events, buffer_limit=buffer_limit)
            self.tick += 1
            self.snapshot = {
                "type": "snapshot",
                "tick": self.tick,
                "server_time": datetime.datetime.now().astimezone().isoformat(),
                "fleet": fleet,
                "events": events,
                "briefing": briefing,
                "alerts": alert_center.unacknowledged(),
                "calendar_status": {
                    "last_success": calendar_cache.last_success,
                    "last_error": calendar_cache.last_error,
                },
            }
            return self.snapshot

    async def get_snapshot(self) -> Dict[str, Any]:
        self.mark_rest_activity()
        if self.snapshot is None:
            return await self.refresh()
        return self.snapshot

    def latest_fleet(self) -> Optional[List[Dict[str, Any]]]:
        return self.snapshot["fleet"] if self.snapshot else None

    def _interval(self) -> float:
        loop_time = asyncio.get_event_loop().time()
        watching = bool(self._clients) or (loop_time - self._last_rest_hit) < REST_ACTIVITY_WINDOW
        return POLL_INTERVAL_ACTIVE if watching else POLL_INTERVAL_IDLE

    async def _run(self) -> None:
        while True:
            try:
                snap = await self.refresh()
                await self._broadcast(snap)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # never let the loop die
                print(f"[Hub] refresh failed: {e!r}")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._interval())
            except asyncio.TimeoutError:
                pass

    # ---------------------------------------------------------------- websockets
    async def _broadcast(self, snap: Dict[str, Any]) -> None:
        if not self._clients:
            return
        payload = json.dumps(snap, default=str)
        dead = []
        for ws in list(self._clients):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=5.0)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

    async def serve(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        self._wake.set()  # drop out of the idle interval straight away
        try:
            snap = self.snapshot or await self.refresh()
            await ws.send_text(json.dumps(snap, default=str))
            while True:
                # Client messages are just keepalives / "refresh now" requests.
                msg = await ws.receive_text()
                if msg == "refresh":
                    self.poke()
        except Exception:
            pass
        finally:
            self._clients.discard(ws)


hub = StateHub()
