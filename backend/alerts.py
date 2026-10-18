"""
SILAS alert centre.

Everything that goes wrong on a printer ends up here, from whichever source saw it first:

  snapmaker  - Snapmaker U1 exception_manager (the pop-ups on the U1 touchscreen),
               pushed live over Moonraker's websocket as notify_exception_notification
               and reconciled against the exception list (notify_exception_status /
               the `exception_manager` printer object).
  klipper    - Klipper shutdowns / "!! ..." error lines from any Klipper printer.
  state      - state changes SILAS spots itself (print went to error, printer vanished mid-print).

Alerts are de-duplicated per printer + code, stay on screen until acknowledged, and are
pushed to the UI the moment they arrive (not on the next poll).
"""
import json
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from .config import DATA_DIR

ALERTS_FILE = DATA_DIR / "alerts.json"
MAX_ALERTS = 200

# ---------------------------------------------------------------- Snapmaker U1 code decoding
# Structured code shown on the U1 screen: LLLL-MMMM-IIII-CCCC (level-module-index-code).
U1_MODULES = {
    522: "Motion",
    523: "Toolhead",
    524: "Camera",
    525: "Filament feeder",
    526: "Heated bed",
    527: "Chamber",
    528: "Homing",
    529: "G-code",
    530: "Probe / calibration",
    531: "Print file",
    532: "Defect detection",
    533: "Purifier",
    2052: "System",
}
# exception_manager action levels: 1 = notice, 2 = print paused, 3 = print cancelled / fatal
U1_LEVELS = {1: "info", 2: "warning", 3: "critical"}
U1_LEVEL_ACTION = {1: "Notice", 2: "Print paused", 3: "Print stopped"}

# Known codes from the U1 firmware source. Anything else still gets the printer's own message.
U1_KNOWN = {
    (523, 0): "Filament runout",
    (523, 37): "Extruder problem",
    (523, 38): "Filament tangled",
    (525, 0): "Feeder fault",
    (525, 1): "Feeder motor speed abnormal",
    (525, 2): "Feeder wheel speed abnormal",
    (525, 3): "No filament in feeder",
    (533, 0): "Purifier fault",
    (533, 1): "Purifier fault",
}

U1_WIKI = "https://wiki.snapmaker.com/en/snapmaker_u1/troubleshooting/u1_error_codes"

# Silas's commentary, by module. Short: it's on a banner, not a monologue.
HAVOC_LINES = {
    "Toolhead": "One of your four little nozzles has given up on life. Go and look at it, Karl.",
    "Filament feeder": "The feeder is choking. Unlike you, it can't just walk away from the problem.",
    "Motion": "Something in the motion system has objected. Loudly. With physics.",
    "Heated bed": "The bed is having a thermal crisis. Do not touch it to check, meatbag.",
    "Homing": "It can't find home. Relatable, but still your problem.",
    "Defect detection": "The camera thinks your print is spaghetti. The camera is usually right.",
    "Purifier": "The air purifier quit. Open a window before the fumes start writing poetry.",
    "Print file": "The G-code file is broken. I'd blame the slicer, but we both know who sliced it.",
    "Camera": "The camera has gone blind. I'm now monitoring your printer on vibes alone.",
    "System": "System-level fault. This is the printer equivalent of a blue screen.",
    "klipper": "Klipper has thrown a wobbly. It's a firmware tantrum, not a fire. Probably.",
    "state": "Your printer just changed its mind about being fine.",
    "stopped": "Your printer has stopped mid-print. That's not a nap, Karl. Get up.",
}


def decode_u1(id_: int, index: int, code: int, level: int, message: str) -> Dict[str, Any]:
    module = U1_MODULES.get(id_, f"Module {id_}")
    title = U1_KNOWN.get((id_, code)) or module + " error"
    where = ""
    if id_ in (523, 525):
        where = f"T{index}"
    elif index:
        where = f"#{index}"
    return {
        "code": f"{level:04d}-{id_:04d}-{index:04d}-{code:04d}",
        "module": module,
        "location": where,
        "title": f"{title} ({where})" if where else title,
        "severity": U1_LEVELS.get(level, "critical"),
        "action": U1_LEVEL_ACTION.get(level),
        "havoc": HAVOC_LINES.get(module, HAVOC_LINES["System"]),
        "help_url": U1_WIKI,
        "message": message or title,
    }


class AlertCenter:
    def __init__(self) -> None:
        self._alerts: List[Dict[str, Any]] = []
        self._lock = threading.RLock()
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []
        self._gcode_throttle: Dict[str, float] = {}
        # Set by the hub: True while a printer is printing/paused. Decides whether an error
        # is a "your print just died" siren or just a banner.
        self.busy_check: Optional[Callable[[str], bool]] = None
        self._load()

    def _busy(self, printer_id: str) -> bool:
        try:
            return bool(self.busy_check and self.busy_check(printer_id))
        except Exception:
            return False

    def recent(self, printer_id: str, within: float, source: Optional[str] = None,
               siren_only: bool = False) -> bool:
        """Was an unacknowledged alert raised/bumped for this printer in the last `within` seconds?"""
        cutoff = time.time() - within
        with self._lock:
            return any(a["printer_id"] == printer_id and not a["acknowledged"] and a["last_seen"] >= cutoff
                       and (source is None or a["source"] == source) and (not siren_only or a.get("siren"))
                       for a in self._alerts)

    # ---------------------------------------------------------------- plumbing
    def on_alert(self, cb: Callable[[Dict[str, Any]], None]) -> None:
        self._listeners.append(cb)

    def _emit(self, alert: Dict[str, Any]) -> None:
        for cb in self._listeners:
            try:
                cb(dict(alert))
            except Exception as e:
                print(f"[Alerts] listener failed: {e!r}")

    def _load(self) -> None:
        try:
            if ALERTS_FILE.exists():
                data = json.loads(ALERTS_FILE.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    self._alerts = data[-MAX_ALERTS:]
        except Exception:
            self._alerts = []

    def _save(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            tmp = ALERTS_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._alerts[-MAX_ALERTS:], indent=1), encoding="utf-8")
            tmp.replace(ALERTS_FILE)
        except Exception as e:
            print(f"[Alerts] could not save: {e!r}")

    # ---------------------------------------------------------------- core
    def raise_alert(self, *, printer_id: str, printer_name: str, source: str, key: str,
                    severity: str, title: str, message: str, code: Optional[str] = None,
                    havoc: Optional[str] = None, extra: Optional[Dict[str, Any]] = None,
                    active: bool = True) -> Dict[str, Any]:
        """Create or bump an alert. Same printer + key while unacknowledged = one alert, count++."""
        now = time.time()
        with self._lock:
            existing = next((a for a in reversed(self._alerts)
                             if a["printer_id"] == printer_id and a["key"] == key and not a["acknowledged"]), None)
            if existing:
                existing.update(last_seen=now, count=existing["count"] + 1, message=message or existing["message"],
                                severity=_worse(existing["severity"], severity), active=active or existing["active"])
                if extra and extra.get("siren"):
                    existing["siren"] = True
                alert = existing
            else:
                alert = {
                    "id": uuid.uuid4().hex[:10],
                    "printer_id": printer_id,
                    "printer_name": printer_name,
                    "source": source,
                    "key": key,
                    "code": code,
                    "severity": severity,
                    "title": title,
                    "message": message,
                    "havoc": havoc or HAVOC_LINES.get(source, HAVOC_LINES["state"]),
                    "first_seen": now,
                    "last_seen": now,
                    "count": 1,
                    "active": active,
                    "acknowledged": False,
                    **(extra or {}),
                }
                self._alerts.append(alert)
                self._alerts = self._alerts[-MAX_ALERTS:]
            self._save()
        print(f"[Alerts] {severity.upper()} {printer_name}: {title} - {message}")
        self._emit(alert)
        return alert

    def resolve(self, printer_id: str, keep_keys: Optional[set] = None, source: Optional[str] = None) -> None:
        """Mark active alerts as cleared on the printer side (they stay on screen until acknowledged)."""
        changed = []
        with self._lock:
            for a in self._alerts:
                if a["printer_id"] != printer_id or not a["active"]:
                    continue
                if source and a["source"] != source:
                    continue
                if keep_keys is not None and a["key"] in keep_keys:
                    continue
                a["active"] = False
                a["cleared_at"] = time.time()
                changed.append(a)
            if changed:
                self._save()
        for a in changed:
            self._emit(a)

    def acknowledge(self, alert_id: Optional[str] = None) -> int:
        n = 0
        with self._lock:
            for a in self._alerts:
                if not a["acknowledged"] and (alert_id is None or a["id"] == alert_id):
                    a["acknowledged"] = True
                    a["acknowledged_at"] = time.time()
                    n += 1
            if n:
                self._save()
        return n

    def list(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(a) for a in reversed(self._alerts[-limit:])]

    def unacknowledged(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(a) for a in reversed(self._alerts) if not a["acknowledged"]]

    # ---------------------------------------------------------------- source adapters
    def snapmaker_exception(self, printer_id: str, printer_name: str, exc: Dict[str, Any],
                            active: bool = False) -> None:
        """A raise event. Not marked 'active' until the printer's exception list confirms it is
        still standing - many U1 errors are one-shot (pause, show a dialog, done)."""
        try:
            id_, index, code = int(exc.get("id", 0)), int(exc.get("index", 0)), int(exc.get("code", 0))
            level = int(exc.get("level", 3))
        except (TypeError, ValueError):
            return
        d = decode_u1(id_, index, code, level, str(exc.get("message") or ""))
        self.raise_alert(
            printer_id=printer_id, printer_name=printer_name, source="snapmaker",
            key=f"u1:{id_}-{index}-{code}", severity=d["severity"], title=d["title"],
            message=d["message"], code=d["code"], havoc=d["havoc"],
            extra={"module": d["module"], "action": d["action"], "help_url": d["help_url"],
                   # level 2 = print paused, 3 = print stopped: siren if a job was running
                   "siren": level >= 2 and self._busy(printer_id)},
            active=active,
        )

    def snapmaker_status(self, printer_id: str, printer_name: str, exceptions: List[Dict[str, Any]]) -> None:
        """Current list of active U1 exceptions: raise any new ones, mark vanished ones as cleared."""
        keys = set()
        for exc in exceptions or []:
            try:
                keys.add(f"u1:{int(exc['id'])}-{int(exc['index'])}-{int(exc['code'])}")
            except (KeyError, TypeError, ValueError):
                continue
            key = f"u1:{int(exc['id'])}-{int(exc['index'])}-{int(exc['code'])}"
            with self._lock:
                # Already on screen, or acknowledged but still active on the printer: don't nag again.
                known = any(a["printer_id"] == printer_id and a["key"] == key
                            and (not a["acknowledged"] or a["active"]) for a in self._alerts)
            if known:
                with self._lock:
                    for a in self._alerts:
                        if a["printer_id"] == printer_id and a["key"] == key and not a["active"] \
                                and not a.get("cleared_at"):
                            a["active"] = True
            else:
                self.snapmaker_exception(printer_id, printer_name, exc, active=True)
        self.resolve(printer_id, keep_keys=keys, source="snapmaker")

    def klipper_error_line(self, printer_id: str, printer_name: str, line: str) -> None:
        text = line[2:].strip() if line.startswith("!!") else line.strip()
        if not text:
            return
        # Klipper repeats the same error a lot (e.g. every retry); one banner per 60s is plenty.
        tkey = f"{printer_id}:{text}"
        now = time.time()
        if now - self._gcode_throttle.get(tkey, 0) < 60:
            return
        self._gcode_throttle[tkey] = now
        self.raise_alert(printer_id=printer_id, printer_name=printer_name, source="klipper",
                         key=f"gcode:{text[:80]}", severity="warning", title="Klipper error", message=text,
                         active=False)

    def klippy_shutdown(self, printer_id: str, printer_name: str, message: str) -> None:
        self.raise_alert(printer_id=printer_id, printer_name=printer_name, source="klipper",
                         key="klippy:shutdown", severity="critical", title="Klipper shutdown",
                         message=message or "Klipper has shut down. FIRMWARE_RESTART needed.",
                         extra={"siren": self._busy(printer_id)})


def _worse(a: str, b: str) -> str:
    order = {"info": 0, "warning": 1, "critical": 2}
    return a if order.get(a, 2) >= order.get(b, 2) else b


alert_center = AlertCenter()
