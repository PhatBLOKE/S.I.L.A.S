from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List
import httpx
from pydantic import BaseModel

# One pooled HTTP client for the whole fleet instead of a fresh TCP handshake per poll.
_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(4.0, connect=2.0),
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
        )
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
    _http_client = None

class ToolheadInfo(BaseModel):
    id: str  # e.g., 'T0', 'T1', 'extruder'
    name: str  # e.g., 'Primary Extruder', 'Tool 1'
    extruder_temp: float = 0.0
    extruder_target: float = 0.0
    nozzle_diameter: Optional[float] = 0.4
    is_active: bool = False

class PrinterTelemetry(BaseModel):
    id: str
    name: str
    type: str  # 'moonraker' | 'octoprint'
    online: bool
    state: str  # 'printing', 'paused', 'standby', 'complete', 'error', 'offline'
    progress_percent: float = 0.0
    layer_current: Optional[int] = None
    layer_total: Optional[int] = None
    extruder_temp: float = 0.0
    extruder_target: float = 0.0
    bed_temp: float = 0.0
    bed_target: float = 0.0
    filename: Optional[str] = None
    print_duration_seconds: int = 0
    time_left_seconds: int = 0
    eta_timestamp: Optional[str] = None
    eta_confidence: Optional[str] = None   # 'low' | 'medium' | 'high'
    eta_source: Optional[str] = None       # 'slicer' | 'progress' | 'blended' | 'printer'
    slicer_estimate_seconds: Optional[int] = None
    webcam_url: Optional[str] = None
    error_message: Optional[str] = None
    
    # Toolhead Detection
    active_toolhead: Optional[str] = "T0"  # e.g. 'T0', 'T1'
    toolheads: List[ToolheadInfo] = []

    # Printer-side exceptions (Snapmaker U1 exception_manager) and live event link status
    printer_exceptions: List[Dict[str, Any]] = []
    event_link: Optional[str] = None  # 'live' | 'down' | None (not applicable)

    # G-Code Preview & Slicer Metadata
    thumbnail_url: Optional[str] = None
    slicer_metadata: Optional[Dict[str, Any]] = None


class BasePrinter(ABC):
    def __init__(self, config: Dict[str, Any]):
        self.id = config.get("id", "")
        self.name = config.get("name", "Unknown Printer")
        self.type = config.get("type", "unknown")
        self.host = config.get("host", "localhost")
        self.port = config.get("port", 7125)
        self.api_key = config.get("api_key", "")
        self.webcam_url = config.get("webcam_url", "")
        self.enabled = config.get("enabled", True)

    @property
    def base_url(self) -> str:
        protocol = "http"
        host = self.host.strip()
        if host.startswith("http://") or host.startswith("https://"):
            return f"{host}:{self.port}"
        return f"{protocol}://{host}:{self.port}"

    @property
    def auth_headers(self) -> Dict[str, str]:
        return {"X-Api-Key": self.api_key} if self.api_key else {}

    @abstractmethod
    async def get_status(self) -> PrinterTelemetry:
        """Fetch real-time telemetry from printer controller"""
        pass

    @abstractmethod
    async def execute_command(self, command: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Execute action: pause, resume, cancel, emergency_stop, preheat"""
        pass
