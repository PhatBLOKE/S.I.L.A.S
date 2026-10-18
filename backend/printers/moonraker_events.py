"""
Live Moonraker event listener (one persistent websocket per Moonraker printer).

HTTP polling only sees what's true *now*. A lot of printer errors are one-shot: the U1
raises "filament tangled" or a defect-detection hit, pauses, and the condition is gone
from the status objects by the next poll. Moonraker broadcasts those to every connected
websocket client, so SILAS listens like a touchscreen would:

  notify_exception_notification  Snapmaker U1: every exception the screen pops up
  notify_exception_status        Snapmaker U1: the current list of active exceptions
  notify_gcode_response          any Klipper: lines starting "!!" are errors
  notify_klippy_shutdown         any Klipper: firmware shut down

Stock Klipper printers simply never send the Snapmaker notifications, so this is safe
to run against every Moonraker machine.
"""
import asyncio
import itertools
import json
from typing import Any, Dict, Optional

try:
    import websockets
except ImportError:  # requirements not installed yet: fall back to polling the U1 exception list
    websockets = None

from ..alerts import alert_center

_ids = itertools.count(1)
RECONNECT_MIN, RECONNECT_MAX = 2.0, 30.0


def _ws_url(host: str, port: int) -> str:
    host = host.strip().rstrip("/")
    for prefix in ("http://", "https://"):
        if host.startswith(prefix):
            scheme = "wss://" if prefix == "https://" else "ws://"
            return f"{scheme}{host[len(prefix):]}:{port}/websocket"
    return f"ws://{host}:{port}/websocket"


async def _connect(url: str, headers: Dict[str, str]):
    # websockets changed this keyword between versions; support both, never go via a proxy.
    try:
        return await websockets.connect(url, additional_headers=headers, proxy=None,
                                        open_timeout=5, ping_interval=20, ping_timeout=20,
                                        max_size=4 * 1024 * 1024)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers, open_timeout=5,
                                        ping_interval=20, ping_timeout=20, max_size=4 * 1024 * 1024)


class MoonrakerEventListener:
    def __init__(self, printer_id: str, name: str, host: str, port: int, api_key: str = "") -> None:
        self.printer_id = printer_id
        self.name = name
        self.url = _ws_url(host, port)
        self.headers = {"X-Api-Key": api_key} if api_key else {}
        self.connected = False
        self.supports_exceptions = False
        self.last_error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._pending: Dict[int, str] = {}

    @property
    def signature(self) -> tuple:
        return (self.url, tuple(sorted(self.headers.items())), self.name)

    def start(self) -> None:
        if websockets is None:
            self.last_error = "websockets package missing - run: python -m pip install -r backend\\requirements.txt"
            return
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run(), name=f"moonraker-events-{self.printer_id}")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        self.connected = False

    async def _send(self, ws, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        req_id = next(_ids)
        self._pending[req_id] = method
        msg = {"jsonrpc": "2.0", "method": method, "id": req_id}
        if params:
            msg["params"] = params
        await ws.send(json.dumps(msg))

    async def _run(self) -> None:
        delay = RECONNECT_MIN
        while True:
            try:
                ws = await _connect(self.url, self.headers)
                try:
                    self.connected, self.last_error, delay = True, None, RECONNECT_MIN
                    await self._send(ws, "server.connection.identify", {
                        "client_name": "SILAS", "version": "2.1", "type": "agent",
                        "url": "http://havoc.local"})
                    # U1 only: what's already wrong right now (e.g. errors raised before we connected)
                    await self._send(ws, "server.exception.query")
                    async for raw in ws:
                        self._handle(raw)
                finally:
                    await ws.close()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = str(e)[:160] or type(e).__name__
            self.connected = False
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX)

    def _handle(self, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            return
        if "id" in msg and "method" not in msg:
            method = self._pending.pop(msg.get("id"), None)
            if method == "server.exception.query" and isinstance(msg.get("result"), dict):
                self.supports_exceptions = True
                alert_center.snapmaker_status(self.printer_id, self.name, msg["result"].get("exceptions") or [])
            return

        method = msg.get("method")
        params = msg.get("params") or []
        first = params[0] if params else None

        if method == "notify_exception_notification" and isinstance(first, dict):
            self.supports_exceptions = True
            alert_center.snapmaker_exception(self.printer_id, self.name, first)
        elif method == "notify_exception_status" and isinstance(first, dict):
            self.supports_exceptions = True
            alert_center.snapmaker_status(self.printer_id, self.name, first.get("exceptions") or [])
        elif method == "notify_gcode_response" and isinstance(first, str) and first.startswith("!!"):
            alert_center.klipper_error_line(self.printer_id, self.name, first)
        elif method == "notify_klippy_shutdown":
            alert_center.klippy_shutdown(self.printer_id, self.name, "")
