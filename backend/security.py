"""
SILAS perimeter security.

Rules:
  * Requests from this machine (loopback) are always trusted, so the desktop
    launcher and the Edge app window keep working with zero setup.
  * Anything arriving from the LAN (phone, tablet, another PC) must present the
    access token, either once via ?token=... (which sets a cookie) or on every
    request via the X-Silas-Token header / havoc_token cookie.
  * The token lives in backend/data/access_token.txt and is generated on first
    run. Delete that file to rotate it (every LAN device then needs the new link).

Implemented as raw ASGI middleware so it guards WebSockets as well as HTTP.
"""
import hmac
import ipaddress
import secrets
from http.cookies import SimpleCookie
from typing import Optional
from urllib.parse import parse_qs, urlencode

from .config import DATA_DIR

TOKEN_FILE = DATA_DIR / "access_token.txt"
COOKIE_NAME = "havoc_token"
HEADER_NAME = b"x-havoc-token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # a year; it's your own LAN

_token_cache: Optional[str] = None


def get_access_token() -> str:
    global _token_cache
    if _token_cache:
        return _token_cache
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(tok) >= 16:
            _token_cache = tok
            return tok
    tok = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(tok, encoding="utf-8")
    _token_cache = tok
    return tok


def is_loopback(host: Optional[str]) -> bool:
    if not host:
        return False
    if host in ("localhost", "testclient"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _token_ok(candidate: Optional[str]) -> bool:
    if not candidate:
        return False
    return hmac.compare_digest(candidate.encode(), get_access_token().encode())


LOCKED_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SILAS // Locked</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090e;color:#94a3b8;
font:14px/1.6 ui-monospace,Consolas,monospace;padding:16px;box-sizing:border-box}
.box{max-width:420px;border:1px solid rgba(0,242,254,.35);padding:24px;background:#0d121d}
h1{color:#00f2fe;font-size:16px;letter-spacing:.2em;margin:0 0 12px}
b{color:#f59e0b}
</style></head><body><div class="box">
<h1>SILAS // ACCESS DENIED</h1>
<p>Nice try, unregistered meatbag device.</p>
<p>Open SILAS on the desktop, go to the <b>Mobile</b> tab and use the
<b>secure LAN link</b> shown there (it carries your access token). This device
will be remembered afterwards.</p>
</div></body></html>"""


class LanGuardMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        client = scope.get("client")
        host = client[0] if client else None
        if is_loopback(host):
            return await self.app(scope, receive, send)

        headers = dict(scope.get("headers") or [])
        query = parse_qs((scope.get("query_string") or b"").decode("latin-1"))
        q_token = (query.get("token") or [None])[0]

        cookie_token = None
        raw_cookie = headers.get(b"cookie")
        if raw_cookie:
            c = SimpleCookie()
            try:
                c.load(raw_cookie.decode("latin-1"))
                if COOKIE_NAME in c:
                    cookie_token = c[COOKIE_NAME].value
            except Exception:
                pass
        hdr_token = headers.get(HEADER_NAME, b"").decode("latin-1") or None

        authed = _token_ok(cookie_token) or _token_ok(hdr_token)

        # First visit with ?token=... on a page: set the cookie and strip the token from the URL.
        if not authed and scope["type"] == "http" and _token_ok(q_token):
            rest = {k: v for k, v in query.items() if k != "token"}
            location = scope.get("path", "/") or "/"
            if rest:
                location += "?" + urlencode(rest, doseq=True)
            await send({
                "type": "http.response.start",
                "status": 303,
                "headers": [
                    (b"location", location.encode("latin-1")),
                    (b"set-cookie", (
                        f"{COOKIE_NAME}={get_access_token()}; Max-Age={COOKIE_MAX_AGE}; "
                        "Path=/; HttpOnly; SameSite=Strict"
                    ).encode("latin-1")),
                    (b"cache-control", b"no-store"),
                ],
            })
            await send({"type": "http.response.body", "body": b""})
            return

        if authed:
            return await self.app(scope, receive, send)

        # Rejected.
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return

        path = scope.get("path", "")
        if path.startswith("/api"):
            body = b'{"detail":"SILAS access token required"}'
            ctype = b"application/json"
        else:
            body = LOCKED_PAGE.encode("utf-8")
            ctype = b"text/html; charset=utf-8"
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [(b"content-type", ctype), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
