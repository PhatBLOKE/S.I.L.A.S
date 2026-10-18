"""Run from the project root:  python -m pytest backend/tests -q"""
import asyncio
import time

import httpx
import pytest

from backend import ai_usage as mod
from backend.ai_usage import AIUsage


@pytest.fixture
def usage(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "USAGE_FILE", tmp_path / "ai_usage.json")
    return AIUsage()


def fake_provider(request: httpx.Request) -> httpx.Response:
    if "groq" in str(request.url):
        return httpx.Response(200, json={"model": "llama-3.3-70b", "choices": [{"message": {"content": "hi"}}],
                                         "usage": {"prompt_tokens": 120, "completion_tokens": 30}},
                              headers={"x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "998",
                                       "x-ratelimit-reset-requests": "1m26s"})
    if "gemini" in str(request.url):
        return httpx.Response(200, json={"candidates": [], "modelVersion": "gemini-2.5-flash",
                                         "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10}})
    return httpx.Response(429, json={"error": {"message": "slow down"}})


async def call(usage, provider, url):
    async with usage.metered_client(provider, "fallback-model", transport=httpx.MockTransport(fake_provider)) as c:
        r = await c.post(url, json={})
        return r.json()  # body must still be readable by the caller after metering


def test_meters_tokens_and_rate_limits(usage):
    body = asyncio.run(call(usage, "groq", "https://api.groq.com/openai/v1/chat/completions"))
    assert body["choices"][0]["message"]["content"] == "hi"
    asyncio.run(call(usage, "gemini", "https://generativelanguage.googleapis.com/gemini"))
    asyncio.run(call(usage, "openai", "https://api.openai.com/v1/chat/completions"))
    s = usage.summary()
    by = {p["provider"]: p for p in s["providers"]}
    assert by["groq"]["tokens_today"] == 150 and by["groq"]["ratelimit"]["remaining_requests"] == "998"
    assert by["gemini"]["tokens_today"] == 60 and by["gemini"]["last_model"] == "gemini-2.5-flash"
    assert by["openai"]["errors_7d"] == 1 and "last_429" in by["openai"]["ratelimit"]
    assert sum(d["tokens"] for d in s["daily_tokens"]) == 210


def test_limit_countdown_and_back_ping(usage):
    pinged = []
    usage.on_back(pinged.append)
    usage.mark_limited("claude", time.time() + 3600)
    usage.tick()
    assert pinged == [] and usage._svc("claude")["status"] == "limited"
    usage._svc("claude")["reset_at"] = time.time() - 1
    usage.tick()
    assert pinged and pinged[0]["id"] == "claude" and usage._svc("claude")["status"] == "ready"
    assert next(s for s in usage.summary()["services"] if s["id"] == "claude")["limits_7d"] == 1


def test_unknown_reset_stays_limited_until_cleared(usage):
    usage.mark_limited("chatgpt", None)
    usage.tick()
    assert usage._svc("chatgpt")["status"] == "limited"
    usage.mark_ready("chatgpt")
    assert usage._svc("chatgpt")["status"] == "ready"


def test_custom_service(usage):
    s = usage.upsert_service(None, "Perplexity", "https://perplexity.ai", "🔎")
    assert usage._svc(s["id"])["name"] == "Perplexity"
    assert usage.delete_service(s["id"])
