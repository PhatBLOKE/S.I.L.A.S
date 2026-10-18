"""
SILAS AI usage tracker - one place to keep an eye on every AI app.

Two kinds of data, because that's what actually exists:

1. METERED: every LLM call SILAS itself makes (Gemini, Groq, OpenAI, Skippy/custom, and
   anything else added later) is recorded with real token counts from the provider's reply
   and the rate-limit headers the provider sends back (remaining requests/tokens, reset).

2. TRACKED: the subscription apps (Claude, ChatGPT, Gemini app, Antigravity, Copilot...)
   have no official way to read your remaining allowance from outside. So each gets a card:
   click "Hit limit" when one locks you out, say when it resets, and SILAS counts down and
   pings you the moment it's usable again. Each card links to the app's own usage page.

Stored in backend/data/ai_usage.json.
"""
import json
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx

from .config import DATA_DIR

USAGE_FILE = DATA_DIR / "ai_usage.json"
MAX_EVENTS = 5000

DEFAULT_SERVICES: List[Dict[str, Any]] = [
    {"id": "claude", "name": "Claude", "icon": "🟠", "url": "https://claude.ai/settings/usage",
     "notes": "5-hour session window + weekly limit. The usage page shows both as %."},
    {"id": "chatgpt", "name": "ChatGPT", "icon": "🟢", "url": "https://chatgpt.com", "notes": ""},
    {"id": "gemini", "name": "Gemini", "icon": "🔷", "url": "https://gemini.google.com", "notes": ""},
    {"id": "antigravity", "name": "Antigravity", "icon": "🌀", "url": "", "notes": "Google's agent IDE."},
    {"id": "copilot", "name": "GitHub Copilot", "icon": "🐙", "url": "https://github.com/settings/copilot", "notes": ""},
]

RATE_HEADERS = {
    # OpenAI / Groq style
    "x-ratelimit-limit-requests": "limit_requests",
    "x-ratelimit-remaining-requests": "remaining_requests",
    "x-ratelimit-reset-requests": "reset_requests",
    "x-ratelimit-limit-tokens": "limit_tokens",
    "x-ratelimit-remaining-tokens": "remaining_tokens",
    "x-ratelimit-reset-tokens": "reset_tokens",
    # Anthropic API style
    "anthropic-ratelimit-requests-limit": "limit_requests",
    "anthropic-ratelimit-requests-remaining": "remaining_requests",
    "anthropic-ratelimit-requests-reset": "reset_requests",
    "anthropic-ratelimit-tokens-limit": "limit_tokens",
    "anthropic-ratelimit-tokens-remaining": "remaining_tokens",
    "anthropic-ratelimit-tokens-reset": "reset_tokens",
    "retry-after": "retry_after",
}


def _extract_tokens(body: Any) -> Dict[str, int]:
    """Token counts from any of the common reply shapes."""
    if not isinstance(body, dict):
        return {}
    u = body.get("usage") or {}
    if isinstance(u, dict) and u:
        # OpenAI / Groq: prompt_tokens/completion_tokens; Anthropic: input_tokens/output_tokens
        inp = u.get("prompt_tokens", u.get("input_tokens"))
        out = u.get("completion_tokens", u.get("output_tokens"))
        if inp is not None or out is not None:
            return {"input": int(inp or 0), "output": int(out or 0)}
    m = body.get("usageMetadata") or {}
    if isinstance(m, dict) and m:  # Gemini
        return {"input": int(m.get("promptTokenCount") or 0),
                "output": int(m.get("candidatesTokenCount") or 0) + int(m.get("thoughtsTokenCount") or 0)}
    return {}


def _model_from(body: Any, fallback: Optional[str]) -> Optional[str]:
    if isinstance(body, dict):
        return body.get("model") or body.get("modelVersion") or fallback
    return fallback


class AIUsage:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.data: Dict[str, Any] = {"events": [], "ratelimits": {}, "services": []}
        self._on_back = None
        self._load()

    # ---------------------------------------------------------------- persistence
    def _load(self) -> None:
        try:
            if USAGE_FILE.exists():
                d = json.loads(USAGE_FILE.read_text(encoding="utf-8"))
                if isinstance(d, dict):
                    self.data.update(d)
        except Exception:
            pass
        if not self.data.get("services"):
            self.data["services"] = [dict(s, status="ready", reset_at=None, history=[]) for s in DEFAULT_SERVICES]

    def _save(self) -> None:
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            self.data["events"] = self.data["events"][-MAX_EVENTS:]
            tmp = USAGE_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
            tmp.replace(USAGE_FILE)
        except Exception as e:
            print(f"[AI usage] could not save: {e!r}")

    def on_back(self, cb) -> None:
        """Callback(service) when a limited service's reset time passes."""
        self._on_back = cb

    # ---------------------------------------------------------------- metered calls
    def record_call(self, provider: str, model: Optional[str], status: int,
                    tokens: Dict[str, int], headers: Dict[str, str]) -> None:
        now = time.time()
        rl = {}
        for h, key in RATE_HEADERS.items():
            if h in headers:
                rl[key] = headers[h]
        with self._lock:
            self.data["events"].append({
                "ts": now, "provider": provider, "model": model, "status": status,
                "input": tokens.get("input", 0), "output": tokens.get("output", 0),
            })
            if rl:
                rl["seen_at"] = now
                self.data["ratelimits"][provider] = rl
            if status == 429:
                self.data["ratelimits"].setdefault(provider, {})["last_429"] = now
            self._save()

    def metered_client(self, provider: str, model: Optional[str] = None, **kwargs) -> httpx.AsyncClient:
        """Drop-in httpx.AsyncClient that records every LLM reply it receives."""
        async def _hook(response: httpx.Response) -> None:
            try:
                if response.request.method != "POST":
                    return
                await response.aread()
                body = None
                try:
                    body = response.json()
                except Exception:
                    pass
                self.record_call(provider, _model_from(body, model), response.status_code,
                                 _extract_tokens(body), {k.lower(): v for k, v in response.headers.items()})
            except Exception as e:
                print(f"[AI usage] meter failed: {e!r}")
        hooks = kwargs.pop("event_hooks", {}) or {}
        hooks.setdefault("response", []).append(_hook)
        return httpx.AsyncClient(event_hooks=hooks, **kwargs)

    # ---------------------------------------------------------------- tracked services
    def _svc(self, sid: str) -> Optional[Dict[str, Any]]:
        return next((s for s in self.data["services"] if s["id"] == sid), None)

    def upsert_service(self, sid: Optional[str], name: str, url: str = "", icon: str = "🤖", notes: str = "") -> Dict[str, Any]:
        with self._lock:
            s = self._svc(sid) if sid else None
            if s is None:
                s = {"id": sid or f"svc-{uuid.uuid4().hex[:6]}", "status": "ready", "reset_at": None, "history": []}
                self.data["services"].append(s)
            s.update(name=name.strip()[:40] or "AI app", url=url.strip()[:300], icon=(icon or "🤖")[:4],
                     notes=notes.strip()[:200])
            self._save()
            return dict(s)

    def delete_service(self, sid: str) -> bool:
        with self._lock:
            before = len(self.data["services"])
            self.data["services"] = [s for s in self.data["services"] if s["id"] != sid]
            self._save()
            return len(self.data["services"]) != before

    def mark_limited(self, sid: str, reset_at: Optional[float], note: str = "") -> Optional[Dict[str, Any]]:
        with self._lock:
            s = self._svc(sid)
            if not s:
                return None
            s["status"] = "limited"
            s["reset_at"] = reset_at
            s["limited_at"] = time.time()
            s.setdefault("history", []).append({"at": s["limited_at"], "reset_at": reset_at, "note": note[:120]})
            s["history"] = s["history"][-50:]
            self._save()
            return dict(s)

    def mark_ready(self, sid: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            s = self._svc(sid)
            if not s:
                return None
            s["status"], s["reset_at"] = "ready", None
            self._save()
            return dict(s)

    def tick(self) -> None:
        """Flip services back to ready when their reset time passes, and announce it."""
        now = time.time()
        back = []
        with self._lock:
            for s in self.data["services"]:
                if s.get("status") == "limited" and s.get("reset_at") and s["reset_at"] <= now:
                    s["status"], s["reset_at"] = "ready", None
                    back.append(dict(s))
            if back:
                self._save()
        for s in back:
            if self._on_back:
                try:
                    self._on_back(s)
                except Exception as e:
                    print(f"[AI usage] notify failed: {e!r}")

    # ---------------------------------------------------------------- summary for the UI
    def summary(self) -> Dict[str, Any]:
        now = time.time()
        day_start = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
        week_start = now - 7 * 86400
        with self._lock:
            events = list(self.data["events"])
            providers: Dict[str, Dict[str, Any]] = {}
            for e in events:
                p = providers.setdefault(e["provider"], {
                    "provider": e["provider"], "calls_today": 0, "tokens_today": 0, "calls_7d": 0,
                    "tokens_7d": 0, "errors_7d": 0, "last_call": None, "last_model": None})
                tok = (e.get("input") or 0) + (e.get("output") or 0)
                if e["ts"] >= week_start:
                    p["calls_7d"] += 1
                    p["tokens_7d"] += tok
                    if e.get("status", 200) >= 400:
                        p["errors_7d"] += 1
                if e["ts"] >= day_start:
                    p["calls_today"] += 1
                    p["tokens_today"] += tok
                if not p["last_call"] or e["ts"] > p["last_call"]:
                    p["last_call"], p["last_model"] = e["ts"], e.get("model")
            # daily totals for the last 7 days (oldest first)
            days = []
            for i in range(6, -1, -1):
                start = day_start - i * 86400
                end = start + 86400
                days.append({
                    "day": time.strftime("%a", time.localtime(start)),
                    "tokens": sum((e.get("input") or 0) + (e.get("output") or 0)
                                  for e in events if start <= e["ts"] < end),
                })
            for name, rl in self.data["ratelimits"].items():
                providers.setdefault(name, {"provider": name, "calls_today": 0, "tokens_today": 0, "calls_7d": 0,
                                            "tokens_7d": 0, "errors_7d": 0, "last_call": None, "last_model": None})
                providers[name]["ratelimit"] = rl
            services = []
            for s in self.data["services"]:
                d = {k: v for k, v in s.items() if k != "history"}
                d["limits_7d"] = sum(1 for h in s.get("history", []) if h["at"] >= week_start)
                services.append(d)
        return {
            "server_time": now,
            "services": services,
            "providers": sorted(providers.values(), key=lambda p: -(p["tokens_7d"] or 0)),
            "daily_tokens": days,
        }


ai_usage = AIUsage()
