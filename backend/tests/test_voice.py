"""Voice render endpoint. Run from the project root:  python -m pytest backend/tests -q"""
import sys

from fastapi.testclient import TestClient

from backend import voice
from backend.app import app


def test_not_windows_answers_501(monkeypatch):
    monkeypatch.setattr(voice.sys, "platform", "linux")
    r = TestClient(app).post("/api/voice/render", json={"text": "Hello"})
    assert r.status_code == 501


def test_windows_path_returns_wav_and_caches(monkeypatch):
    calls = []

    def fake(text):
        calls.append(text)
        return b"RIFF" + b"\0" * 200

    monkeypatch.setattr(voice.sys, "platform", "win32")
    monkeypatch.setattr(voice, "_render_windows", fake)
    voice._CACHE.clear()
    c = TestClient(app)
    for _ in range(2):
        r = c.post("/api/voice/render", json={"text": "Take   your time."})
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert calls == ["Take your time."]


def test_text_goes_through_env_not_command_line():
    assert "SILAS_TTS_TEXT" in voice._PS_SCRIPT
    assert "$env:SILAS_TTS_TEXT" in voice._PS_SCRIPT


def test_empty_text_rejected():
    r = TestClient(app).post("/api/voice/render", json={"text": ""})
    assert r.status_code == 422
