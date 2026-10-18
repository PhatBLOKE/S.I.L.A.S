import datetime
from contextlib import asynccontextmanager
from typing import Dict, Any, Optional
from .base import BasePrinter, PrinterTelemetry, get_http_client
from .eta import blend_eta


@asynccontextmanager
async def _shared_client():
    # Pooled client; never closed per-request.
    yield get_http_client()

class OctoPrintPrinter(BasePrinter):
    async def get_status(self) -> PrinterTelemetry:
        if not self.enabled:
            return PrinterTelemetry(
                id=self.id,
                name=self.name,
                type=self.type,
                online=False,
                state="offline",
                error_message="Printer disabled in settings"
            )

        headers = {}
        if self.api_key:
            headers["X-Api-Key"] = self.api_key

        try:
            async with _shared_client() as client:
                # Query printer state and temps
                printer_resp = await client.get(f"{self.base_url}/api/printer", headers=headers)
                job_resp = await client.get(f"{self.base_url}/api/job", headers=headers)

                if printer_resp.status_code != 200 or job_resp.status_code != 200:
                    return PrinterTelemetry(
                        id=self.id,
                        name=self.name,
                        type=self.type,
                        online=False,
                        state="offline",
                        error_message=f"OctoPrint returned {printer_resp.status_code}"
                    )

                p_data = printer_resp.json()
                j_data = job_resp.json()

                tool0 = p_data.get("temperature", {}).get("tool0", {})
                bed = p_data.get("temperature", {}).get("bed", {})
                job_state = j_data.get("state", "Operational").lower()
                progress_data = j_data.get("progress", {})

                # Normalize state
                if "error" in job_state or "offline" in job_state:
                    state = "error"
                elif "printing" in job_state:
                    state = "printing"
                elif "paused" in job_state:
                    state = "paused"
                else:
                    state = "standby"

                progress = float(progress_data.get("completion") or 0.0)
                print_time = int(progress_data.get("printTime") or 0)
                print_time_left = int(progress_data.get("printTimeLeft") or 0)
                filename = j_data.get("job", {}).get("file", {}).get("name") or None

                eta_str = None
                est = blend_eta(progress / 100.0, print_time,
                                (j_data.get("job") or {}).get("estimatedPrintTime"),
                                printer_reported_left=print_time_left)
                if state in ("printing", "paused") and est.seconds_left is not None:
                    print_time_left = est.seconds_left
                if state == "printing" and est.seconds_left:
                    eta_dt = datetime.datetime.now().astimezone() + datetime.timedelta(seconds=est.seconds_left)
                    eta_str = eta_dt.isoformat()

                return PrinterTelemetry(
                    id=self.id,
                    name=self.name,
                    type=self.type,
                    online=True,
                    state=state,
                    progress_percent=round(progress, 1),
                    extruder_temp=round(float(tool0.get("actual", 0.0)), 1),
                    extruder_target=round(float(tool0.get("target", 0.0)), 1),
                    bed_temp=round(float(bed.get("actual", 0.0)), 1),
                    bed_target=round(float(bed.get("target", 0.0)), 1),
                    filename=filename,
                    print_duration_seconds=print_time,
                    time_left_seconds=print_time_left,
                    eta_timestamp=eta_str,
                    eta_confidence=est.confidence if state in ("printing", "paused") else None,
                    eta_source=est.source if state in ("printing", "paused") else None,
                    webcam_url=self.webcam_url or None
                )
        except Exception as e:
            return PrinterTelemetry(
                id=self.id,
                name=self.name,
                type=self.type,
                online=False,
                state="offline",
                error_message=f"Connection failed: {str(e)[:100]}"
            )

    async def execute_command(self, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        headers = {}
        if self.api_key:
            headers["X-Api-Key"] = self.api_key

        async with _shared_client() as client:
            if command in ("pause", "resume"):
                action = "pause" if command == "pause" else "resume"
                url = f"{self.base_url}/api/job"
                resp = await client.post(url, headers=headers, json={"command": "pause", "action": action})
                return {"success": resp.status_code in (200, 204)}

            elif command == "cancel":
                url = f"{self.base_url}/api/job"
                resp = await client.post(url, headers=headers, json={"command": "cancel"})
                return {"success": resp.status_code in (200, 204)}

            elif command == "emergency_stop":
                url = f"{self.base_url}/api/printer/command"
                resp = await client.post(url, headers=headers, json={"command": "M112"})
                return {"success": resp.status_code in (200, 204)}

            elif command == "preheat":
                material = (params or {}).get("material", "PLA").upper()
                ext_temp = 210 if material == "PLA" else 245
                bed_temp = 60 if material == "PLA" else 80
                await client.post(f"{self.base_url}/api/printer/tool", headers=headers, json={"command": "target", "targets": {"tool0": ext_temp}})
                await client.post(f"{self.base_url}/api/printer/bed", headers=headers, json={"command": "target", "target": bed_temp})
                return {"success": True, "target": {"extruder": ext_temp, "bed": bed_temp}}

            elif command == "cooldown":
                await client.post(f"{self.base_url}/api/printer/tool", headers=headers, json={"command": "target", "targets": {"tool0": 0}})
                await client.post(f"{self.base_url}/api/printer/bed", headers=headers, json={"command": "target", "target": 0})
                return {"success": True}

            return {"success": False, "error": f"Unknown command: {command}"}
