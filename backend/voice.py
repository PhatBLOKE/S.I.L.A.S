"""
Speech audio for the test-chamber voice.

The browser's built-in speech can't be run through audio effects, so for that persona SILAS
asks Windows' own speech engine (System.Speech, part of every Windows install) to record the
line to a WAV, sends the WAV to the page, and the page re-synthesises it (frontend/src/voiceFx.js).

Windows only. Elsewhere the endpoint answers 501 and the page falls back to normal speech.
The text goes to PowerShell through an environment variable, never the command line, so it
can't be used to run commands.
"""
import asyncio
import base64
import hashlib
import os
import subprocess
import sys
import tempfile
from collections import OrderedDict

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter()

_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
$pick = $voices | Where-Object { $_.Name -match 'Zira' } | Select-Object -First 1
if (-not $pick) { $pick = $voices | Where-Object { $_.Gender -eq 'Female' -and $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
if ($pick) { $s.SelectVoice($pick.Name) }
$s.Rate = -1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:SILAS_TTS_OUT, $fmt)
$s.Speak($env:SILAS_TTS_TEXT)
$s.Dispose()
"""

# -EncodedCommand (UTF-16LE base64) sidesteps every quoting problem on the Windows command line.
_ENCODED = base64.b64encode(_PS_SCRIPT.encode("utf-16-le")).decode("ascii")

_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_CACHE_MAX = 24


class RenderRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=800)


def _render_windows(text: str) -> bytes:
    fd, path = tempfile.mkstemp(prefix="silas_tts_", suffix=".wav")
    os.close(fd)
    try:
        env = {**os.environ, "SILAS_TTS_TEXT": text, "SILAS_TTS_OUT": path}
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", _ENCODED],
            env=env, capture_output=True, timeout=25,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or b"").decode(errors="replace")[-300:] or "speech engine failed")
        with open(path, "rb") as f:
            data = f.read()
        if len(data) < 100:
            raise RuntimeError("speech engine produced no audio")
        return data
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


@router.post("/api/voice/render")
async def render_voice(req: RenderRequest):
    if sys.platform != "win32":
        raise HTTPException(status_code=501, detail="Recorded voices need Windows")
    text = " ".join(req.text.split())
    key = hashlib.sha1(text.encode()).hexdigest()
    data = _CACHE.get(key)
    if data is None:
        try:
            data = await asyncio.to_thread(_render_windows, text)
        except Exception as e:  # noqa: BLE001 - report, don't crash the server
            raise HTTPException(status_code=502, detail=f"Speech engine error: {e}")
        _CACHE[key] = data
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    else:
        _CACHE.move_to_end(key)
    return Response(content=data, media_type="audio/wav", headers={"Cache-Control": "no-store"})
