import datetime
import re
import time
from typing import Dict, Any, Optional, List

from .base import BasePrinter, PrinterTelemetry, ToolheadInfo, get_http_client
from .eta import blend_eta

_EXTRUDER_RE = re.compile(r"^extruder(\d*)$")
_TOOL_RE = re.compile(r"^T(\d{1,2})$")
OBJECT_LIST_TTL = 300  # re-discover printer objects every 5 min (or after a reconnect)

# Objects we want if the printer has them; extruders are discovered dynamically.
_BASE_OBJECTS = ["webhooks", "print_stats", "toolhead", "heater_bed", "display_status",
                 "virtual_sdcard", "toolchanger", "dual_carriage",
                 "exception_manager"]  # Snapmaker U1 only


def _extruder_index(name: str) -> int:
    m = _EXTRUDER_RE.match(name)
    if not m:
        return 9999
    return int(m.group(1) or 0)


class MoonrakerPrinter(BasePrinter):
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._thumb_cache: Dict[str, str] = {}
        self._thumb_rel_paths: Dict[str, str] = {}
        self._slicer_meta_cache: Dict[str, Dict[str, Any]] = {}
        self._last_filename: Optional[str] = None
        self._objects: Optional[List[str]] = None
        self._objects_fetched_at: float = 0.0

    # ------------------------------------------------------------------ discovery
    async def _discover_objects(self) -> List[str]:
        now = time.monotonic()
        if self._objects is not None and now - self._objects_fetched_at < OBJECT_LIST_TTL:
            return self._objects
        client = get_http_client()
        resp = await client.get(f"{self.base_url}/printer/objects/list", headers=self.auth_headers)
        resp.raise_for_status()
        available = set(resp.json().get("result", {}).get("objects", []))
        extruders = sorted((o for o in available if _EXTRUDER_RE.match(o)), key=_extruder_index)
        wanted = [o for o in _BASE_OBJECTS if o in available] + extruders
        self._objects = wanted
        self._objects_fetched_at = now
        return wanted

    # ------------------------------------------------------------------ thumbnails / metadata
    async def get_thumbnail_bytes(self, filename: Optional[str] = None) -> Optional[bytes]:
        fname = filename or self._last_filename
        if not fname:
            return None
        rel_path = self._thumb_rel_paths.get(fname)
        if not rel_path:
            await self._fetch_thumbnail_metadata(fname)
            rel_path = self._thumb_rel_paths.get(fname)
        if not rel_path:
            return None
        # Thumbnails live next to the gcode file (relative to its directory).
        directory = fname.rsplit("/", 1)[0] + "/" if "/" in fname else ""
        try:
            resp = await get_http_client().get(
                f"{self.base_url}/server/files/gcodes/{directory}{rel_path}", headers=self.auth_headers
            )
            if resp.status_code == 200:
                return resp.content
        except Exception:
            pass
        return None

    async def _fetch_thumbnail_metadata(self, filename: str) -> None:
        try:
            resp = await get_http_client().get(
                f"{self.base_url}/server/files/metadata",
                params={"filename": filename},
                headers=self.auth_headers,
            )
            if resp.status_code != 200:
                return
            meta = resp.json().get("result", {})
            thumbs = meta.get("thumbnails") or []
            if thumbs:
                best = max(thumbs, key=lambda x: (x.get("width", 0) or 0) * (x.get("height", 0) or 0))
                rel_path = best.get("relative_path", "")
                if rel_path:
                    self._thumb_rel_paths[filename] = rel_path
                    from urllib.parse import quote
                    self._thumb_cache[filename] = f"/api/printers/{self.id}/thumbnail?filename={quote(filename)}"
            self._slicer_meta_cache[filename] = {
                "filament_type": meta.get("filament_type"),
                "filament_name": meta.get("filament_name"),
                "layer_height": meta.get("layer_height"),
                "layer_count": meta.get("layer_count"),
                "object_height": meta.get("object_height"),
                "slicer": meta.get("slicer"),
                "slicer_version": meta.get("slicer_version"),
                "estimated_time": meta.get("estimated_time"),
                "filament_total": meta.get("filament_total"),
            }
        except Exception:
            pass

    # ------------------------------------------------------------------ status
    def _offline(self, msg: str) -> PrinterTelemetry:
        return PrinterTelemetry(
            id=self.id, name=self.name, type=self.type, online=False, state="offline",
            error_message=msg, active_toolhead=None, toolheads=[],
            webcam_url=self.webcam_url or None,
        )

    async def get_status(self) -> PrinterTelemetry:
        if not self.enabled:
            return self._offline("Printer disabled in settings")

        try:
            objects = await self._discover_objects()
            client = get_http_client()
            resp = await client.get(
                f"{self.base_url}/printer/objects/query",
                params={o: "" for o in objects},
                headers=self.auth_headers,
            )
            if resp.status_code != 200:
                self._objects = None
                return self._offline(f"HTTP {resp.status_code}: {resp.text[:100]}")
            data = resp.json().get("result", {}).get("status", {})
        except Exception as e:
            self._objects = None  # force re-discovery after reconnect
            return self._offline(f"Connection failed: {str(e)[:100] or type(e).__name__}")

        webhooks = data.get("webhooks", {})
        print_stats = data.get("print_stats", {})
        heater_bed = data.get("heater_bed", {})
        display_status = data.get("display_status", {})
        vsd = data.get("virtual_sdcard", {})
        toolhead_data = data.get("toolhead", {})
        toolchanger = data.get("toolchanger") or {}
        exceptions = (data.get("exception_manager") or {}).get("exceptions") or []

        # --- toolheads: every extruderN Klipper exposes, so 10-tool changers show all 10
        active_extruder = toolhead_data.get("extruder") or "extruder"
        tc_number = toolchanger.get("tool_number")
        extruder_keys = sorted((k for k in data if _EXTRUDER_RE.match(k)), key=_extruder_index)
        toolheads: List[ToolheadInfo] = []
        for key in extruder_keys:
            info = data.get(key) or {}
            idx = _extruder_index(key)
            if isinstance(tc_number, int) and tc_number >= 0:
                is_active = idx == tc_number
            else:
                is_active = key == active_extruder
            toolheads.append(ToolheadInfo(
                id=f"T{idx}",
                name=f"Toolhead T{idx}",
                extruder_temp=round(float(info.get("temperature") or 0.0), 1),
                extruder_target=round(float(info.get("target") or 0.0), 1),
                is_active=is_active,
            ))
        if toolheads and not any(t.is_active for t in toolheads):
            toolheads[0].is_active = True
        active_tool = next((t for t in toolheads if t.is_active), None)

        # --- state
        klipper_state = webhooks.get("state", "unknown")
        raw_print_state = (print_stats.get("state") or "standby").lower()
        if klipper_state in ("error", "shutdown"):
            state = "error"
        elif klipper_state == "startup":
            state = "standby"
        elif raw_print_state in ("printing", "paused", "complete", "standby", "cancelled"):
            state = "standby" if raw_print_state == "cancelled" else raw_print_state
        elif raw_print_state == "error":
            state = "error"
        else:
            state = "standby"

        # display_status.progress honours slicer M73; fall back to file position
        progress_frac = float(display_status.get("progress") or vsd.get("progress") or 0.0)
        print_duration = int(print_stats.get("print_duration") or 0)

        filename = print_stats.get("filename") or None
        if filename:
            self._last_filename = filename
            if filename not in self._slicer_meta_cache:
                await self._fetch_thumbnail_metadata(filename)
        slicer_meta = self._slicer_meta_cache.get(filename) if filename else None
        thumbnail_url = self._thumb_cache.get(filename) if filename else None

        info = print_stats.get("info") or {}
        layer_current = info.get("current_layer")
        layer_total = info.get("total_layer") or (slicer_meta or {}).get("layer_count")

        time_left = 0
        eta_str = None
        eta_conf = None
        eta_src = None
        slicer_total = (slicer_meta or {}).get("estimated_time")
        if state in ("printing", "paused"):
            est = blend_eta(progress_frac, print_duration, slicer_total)
            if est.seconds_left is not None:
                time_left = est.seconds_left
                eta_conf, eta_src = est.confidence, est.source
                if state == "printing":
                    eta_str = (datetime.datetime.now().astimezone()
                               + datetime.timedelta(seconds=time_left)).isoformat()

        return PrinterTelemetry(
            id=self.id,
            name=self.name,
            type=self.type,
            online=True,
            state=state,
            progress_percent=round(progress_frac * 100.0, 1),
            layer_current=layer_current,
            layer_total=layer_total,
            extruder_temp=active_tool.extruder_temp if active_tool else 0.0,
            extruder_target=active_tool.extruder_target if active_tool else 0.0,
            bed_temp=round(float(heater_bed.get("temperature") or 0.0), 1),
            bed_target=round(float(heater_bed.get("target") or 0.0), 1),
            filename=filename,
            print_duration_seconds=print_duration,
            time_left_seconds=time_left,
            eta_timestamp=eta_str,
            eta_confidence=eta_conf,
            eta_source=eta_src,
            slicer_estimate_seconds=int(slicer_total) if slicer_total else None,
            webcam_url=self.webcam_url or None,
            error_message=webhooks.get("state_message") if state == "error" else None,
            active_toolhead=active_tool.id if active_tool else None,
            toolheads=toolheads,
            thumbnail_url=thumbnail_url,
            slicer_metadata=slicer_meta,
            printer_exceptions=[e for e in exceptions if isinstance(e, dict)],
        )

    # ------------------------------------------------------------------ commands
    async def _gcode(self, script: str):
        return await get_http_client().post(
            f"{self.base_url}/printer/gcode/script",
            params={"script": script},
            headers=self.auth_headers,
            timeout=30.0,  # heating/homing macros can block
        )

    async def execute_command(self, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        params = params or {}
        cmd_map = {
            "pause": "/printer/print/pause",
            "resume": "/printer/print/resume",
            "cancel": "/printer/print/cancel",
            "emergency_stop": "/printer/emergency_stop",
            "restart": "/printer/restart",
            "firmware_restart": "/printer/firmware_restart",
        }
        try:
            if command in cmd_map:
                resp = await get_http_client().post(f"{self.base_url}{cmd_map[command]}",
                                                    headers=self.auth_headers, timeout=10.0)
                return {"success": resp.status_code == 200, "result": resp.text}

            if command == "select_tool":
                tool = str(params.get("tool", "T0")).upper().strip()
                if not _TOOL_RE.match(tool):
                    return {"success": False, "error": f"Invalid tool '{tool}'"}
                resp = await self._gcode(tool)
                return {"success": resp.status_code == 200, "result": resp.text, "active_tool": tool}

            if command == "preheat":
                material = str(params.get("material", "PLA")).upper()
                ext_t, bed_t = {"PLA": (210, 60), "PETG": (245, 80)}.get(material, (255, 100))
                resp = await self._gcode(f"M104 S{ext_t}\nM140 S{bed_t}")
                return {"success": resp.status_code == 200, "result": resp.text,
                        "target": {"extruder": ext_t, "bed": bed_t}}

            if command == "cooldown":
                resp = await self._gcode("TURN_OFF_HEATERS")
                return {"success": resp.status_code == 200, "result": resp.text}

            if command == "gcode":
                script = str(params.get("gcode", "")).strip()
                if not script:
                    return {"success": False, "error": "Empty G-code"}
                resp = await self._gcode(script)
                return {"success": resp.status_code == 200, "result": resp.text}
        except Exception as e:
            return {"success": False, "error": f"Printer unreachable: {str(e)[:120]}"}

        return {"success": False, "error": f"Unknown command: {command}"}
