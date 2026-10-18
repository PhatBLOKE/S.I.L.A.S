import json
import os
import threading
from pathlib import Path
from typing import Dict, Any, List

DATA_DIR = Path(__file__).resolve().parent / "data"
CONFIG_FILE = DATA_DIR / "config.json"

DEFAULT_CONFIG: Dict[str, Any] = {
    "printers": [
        {
            "id": "printer-1",
            "name": "Klipper Core (Primary)",
            "type": "moonraker",
            "host": "192.168.1.103",
            "port": 7125,
            "api_key": "",
            "webcam_url": "http://192.168.1.103/webcam/?action=stream",
            "enabled": True,
            "notes": "Primary Sovol/Voron rig"
        },
        {
            "id": "printer-2",
            "name": "Secondary Rig (In Progress)",
            "type": "moonraker",
            "host": "192.168.1.104",
            "port": 7125,
            "api_key": "",
            "webcam_url": "",
            "enabled": False,
            "notes": "Nearly operational, calibrating Eddy/probe"
        }
    ],
    "calendar": {
        "ical_url": "",
        "refresh_interval_minutes": 5,
        "include_mock_if_empty": True
    },
    "local_events": [
        {
            "id": "mock-1",
            "title": "Workshop Machine Calibration & Test Print",
            "start": "2026-09-16T18:00:00",
            "end": "2026-09-16T19:30:00",
            "location": "Workshop",
            "description": "First layer checks on new nozzle."
        },
        {
            "id": "mock-2",
            "title": "Team Sync / Catchup",
            "start": "2026-09-17T10:00:00",
            "end": "2026-09-17T11:00:00",
            "location": "Google Meet",
            "description": "Weekly status meeting."
        },
        {
            "id": "mock-3",
            "title": "Project Review & Logistics",
            "start": "2026-09-17T14:30:00",
            "end": "2026-09-17T15:30:00",
            "location": "Office",
            "description": "Review CAD designs and shipping updates."
        }
    ],
    "pa_settings": {
        "persona": "Silas",
        "voice_alert_enabled": False,
        "collision_buffer_minutes": 15
    }
}

_lock = threading.RLock()

# Sentinel the UI sends to explicitly delete a stored key.
CLEAR_KEY = "__CLEAR__"
MASK_CHAR = "\u2022"  # bullet; masked keys look like "\u2022\u2022\u2022\u2022D7x9"


def mask_secret(value: str) -> str:
    if not value:
        return ""
    tail = value[-4:] if len(value) > 8 else ""
    return MASK_CHAR * 4 + tail


def is_masked(value: Any) -> bool:
    return isinstance(value, str) and MASK_CHAR in value


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)

def load_config() -> Dict[str, Any]:
    with _lock:
        ensure_data_dir()
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return json.loads(json.dumps(DEFAULT_CONFIG))

def save_config(cfg: Dict[str, Any]) -> None:
    # Atomic write: a crash mid-save can no longer leave a half-written config.json.
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, CONFIG_FILE)

def _locked(fn):
    def wrapper(*a, **kw):
        with _lock:
            return fn(*a, **kw)
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper

def get_pa_settings() -> Dict[str, Any]:
    cfg = load_config()
    pa = cfg.get("pa_settings") or {}
    return {"persona": "Silas", "voice_alert_enabled": False, "collision_buffer_minutes": 15, **pa}

def get_printers() -> List[Dict[str, Any]]:
    cfg = load_config()
    return cfg.get("printers", [])

@_locked
def update_printers(printers: List[Dict[str, Any]]) -> None:
    cfg = load_config()
    cfg["printers"] = printers
    save_config(cfg)

def get_calendar_config() -> Dict[str, Any]:
    cfg = load_config()
    return cfg.get("calendar", {})

@_locked
def update_calendar_config(cal_cfg: Dict[str, Any]) -> None:
    cfg = load_config()
    cfg["calendar"] = cal_cfg
    save_config(cfg)

def get_local_events() -> List[Dict[str, Any]]:
    cfg = load_config()
    return cfg.get("local_events", [])

@_locked
def add_local_event(event: Dict[str, Any]) -> None:
    cfg = load_config()
    events = cfg.get("local_events", [])
    events.append(event)
    cfg["local_events"] = events
    save_config(cfg)

@_locked
def delete_local_event(event_id: str) -> bool:
    cfg = load_config()
    events = cfg.get("local_events", [])
    new_events = [e for e in events if e.get("id") != event_id]
    cfg["local_events"] = new_events
    save_config(cfg)
    return len(events) != len(new_events)

def get_ai_config() -> Dict[str, Any]:
    cfg = load_config()
    default_ai = {
        "provider": "gemini",
        "api_key": "",
        "model": "gemini-2.5-flash",
        "custom_url": "https://skippy.ai.studio",
        "provider_keys": {
            "gemini": "",
            "groq": "",
            "openai": "",
            "custom": ""
        }
    }
    saved_ai = cfg.get("ai_config", {})
    if not isinstance(saved_ai, dict):
        saved_ai = {}

    prov_keys = saved_ai.get("provider_keys")
    if not isinstance(prov_keys, dict):
        prov_keys = {
            "gemini": saved_ai.get("api_key", "") if saved_ai.get("provider") == "gemini" else "",
            "groq": saved_ai.get("api_key", "") if saved_ai.get("provider") == "groq" else "",
            "openai": saved_ai.get("api_key", "") if saved_ai.get("provider") == "openai" else "",
            "custom": saved_ai.get("api_key", "") if saved_ai.get("provider") == "custom" else ""
        }

    merged = {**default_ai, **saved_ai, "provider_keys": prov_keys}
    cur_provider = merged.get("provider", "gemini")
    if not merged.get("api_key") and prov_keys.get(cur_provider):
        merged["api_key"] = prov_keys[cur_provider]
    return merged

def get_ai_config_public() -> Dict[str, Any]:
    """AI config safe to hand to a browser: keys masked, never returned in full."""
    cfg = get_ai_config()
    prov_keys = cfg.get("provider_keys") or {}
    return {
        **cfg,
        "api_key": mask_secret(cfg.get("api_key", "")),
        "provider_keys": {k: mask_secret(v or "") for k, v in prov_keys.items()},
        "keys_set": {k: bool(v) for k, v in prov_keys.items()},
    }


def _resolve_key(incoming: Any, existing: str) -> str:
    """Masked or blank values mean 'unchanged'; CLEAR_KEY deletes; anything else replaces."""
    if incoming is None or is_masked(incoming):
        return existing
    if not isinstance(incoming, str):
        return existing
    incoming = incoming.strip()
    if incoming == CLEAR_KEY:
        return ""
    if incoming == "":
        return existing
    return incoming


@_locked
def update_ai_config(ai_cfg: Dict[str, Any]) -> None:
    with _lock:
        cfg = load_config()
        existing = get_ai_config()
        prov_keys = dict(existing.get("provider_keys") or {})

        incoming_prov_keys = ai_cfg.get("provider_keys")
        if isinstance(incoming_prov_keys, dict):
            for name, val in incoming_prov_keys.items():
                prov_keys[name] = _resolve_key(val, prov_keys.get(name, ""))

        provider = ai_cfg.get("provider") or existing.get("provider", "gemini")
        if "api_key" in ai_cfg:
            prov_keys[provider] = _resolve_key(ai_cfg.get("api_key"), prov_keys.get(provider, ""))

        merged = {
            **existing,
            **{k: v for k, v in ai_cfg.items() if k not in ("api_key", "provider_keys", "keys_set")},
            "provider": provider,
            "api_key": prov_keys.get(provider, ""),
            "custom_url": ai_cfg.get("custom_url") or existing.get("custom_url", ""),
            "provider_keys": prov_keys,
        }
        cfg["ai_config"] = merged
        save_config(cfg)
