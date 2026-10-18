import asyncio
from typing import Dict, Any, List, Optional
from .base import BasePrinter, PrinterTelemetry
from .moonraker import MoonrakerPrinter
from .octoprint import OctoPrintPrinter
from .moonraker_events import MoonrakerEventListener
from ..config import get_printers, update_printers, mask_secret, is_masked

class FleetManager:
    def __init__(self):
        self._drivers: Dict[str, BasePrinter] = {}
        self._listeners: Dict[str, MoonrakerEventListener] = {}
        self.reload_fleet()

    async def sync_listeners(self) -> None:
        """Keep one live event websocket per enabled Moonraker printer. Runs on the event loop
        every hub tick, so adds/edits/deletes from the settings UI are picked up automatically."""
        wanted: Dict[str, MoonrakerEventListener] = {}
        for drv in self._drivers.values():
            if isinstance(drv, MoonrakerPrinter) and drv.enabled:
                wanted[drv.id] = MoonrakerEventListener(drv.id, drv.name, drv.host, drv.port, drv.api_key)
        for pid, lst in list(self._listeners.items()):
            if pid not in wanted or wanted[pid].signature != lst.signature:
                await lst.stop()
                del self._listeners[pid]
        for pid, lst in wanted.items():
            if pid not in self._listeners:
                self._listeners[pid] = lst
                lst.start()

    async def stop_listeners(self) -> None:
        for lst in self._listeners.values():
            await lst.stop()
        self._listeners.clear()

    def listener(self, printer_id: str) -> Optional[MoonrakerEventListener]:
        return self._listeners.get(printer_id)

    def reload_fleet(self) -> None:
        self._drivers.clear()
        configs = get_printers()
        for cfg in configs:
            p_id = cfg.get("id")
            p_type = cfg.get("type", "moonraker").lower()
            if p_type == "moonraker":
                self._drivers[p_id] = MoonrakerPrinter(cfg)
            elif p_type == "octoprint":
                self._drivers[p_id] = OctoPrintPrinter(cfg)
            else:
                self._drivers[p_id] = MoonrakerPrinter(cfg)

    async def get_all_status(self) -> List[Dict[str, Any]]:
        tasks = [driver.get_status() for driver in self._drivers.values()]
        if not tasks:
            return []
        drivers = list(self._drivers.values())
        telemetries = await asyncio.gather(*tasks, return_exceptions=True)
        results = []
        for drv, t in zip(drivers, telemetries):
            if isinstance(t, PrinterTelemetry):
                results.append(t.model_dump())
            else:
                # Never silently drop a machine from the board: show it as offline with the reason.
                results.append(PrinterTelemetry(
                    id=drv.id, name=drv.name, type=drv.type, online=False, state="offline",
                    error_message=f"Driver error: {str(t)[:100]}", active_toolhead=None, toolheads=[],
                ).model_dump())
        return results

    @staticmethod
    def public_configs() -> List[Dict[str, Any]]:
        out = []
        for c in get_printers():
            c = dict(c)
            c["api_key"] = mask_secret(c.get("api_key") or "")
            out.append(c)
        return out

    async def get_single_status(self, printer_id: str) -> Optional[Dict[str, Any]]:
        driver = self._drivers.get(printer_id)
        if not driver:
            return None
        telemetry = await driver.get_status()
        return telemetry.model_dump()

    def get_driver(self, printer_id: str) -> Optional[BasePrinter]:
        return self._drivers.get(printer_id)

    async def execute_command(self, printer_id: str, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:

        driver = self._drivers.get(printer_id)
        if not driver:
            return {"success": False, "error": f"Printer {printer_id} not found"}
        try:
            return await driver.execute_command(command, params)
        except Exception as e:
            return {"success": False, "error": f"Command failed: {str(e)[:120]}"}

    def add_printer(self, printer_data: Dict[str, Any]) -> Dict[str, Any]:
        configs = get_printers()
        # Generate id if missing
        if not printer_data.get("id"):
            import uuid
            printer_data["id"] = f"printer-{uuid.uuid4().hex[:6]}"
        configs.append(printer_data)
        update_printers(configs)
        self.reload_fleet()
        return printer_data

    def update_printer(self, printer_id: str, printer_data: Dict[str, Any]) -> bool:
        configs = get_printers()
        updated = False
        for idx, cfg in enumerate(configs):
            if cfg.get("id") == printer_id:
                incoming = dict(printer_data)
                if is_masked(incoming.get("api_key")) or incoming.get("api_key") is None:
                    incoming["api_key"] = cfg.get("api_key", "")
                configs[idx] = {**cfg, **incoming, "id": printer_id}
                updated = True
                break
        if updated:
            update_printers(configs)
            self.reload_fleet()
        return updated

    def delete_printer(self, printer_id: str) -> bool:
        configs = get_printers()
        new_configs = [c for c in configs if c.get("id") != printer_id]
        if len(new_configs) != len(configs):
            update_printers(new_configs)
            self.reload_fleet()
            return True
        return False

# Global instance
fleet_manager = FleetManager()
