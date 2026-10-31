"""Printer camera discovery. Run from the project root:  python -m pytest backend/tests -q"""
import asyncio

import httpx

from backend import webcams as w


def test_relative_and_localhost_urls_point_at_the_printer():
    assert w.resolve_url("/webcam/?action=stream", "192.168.1.50") == "http://192.168.1.50/webcam/?action=stream"
    assert w.resolve_url("http://localhost:8080/?action=stream", "u1.local") == "http://u1.local:8080/?action=stream"
    assert w.resolve_url(":8080/?action=snapshot", "10.0.0.2") == "http://10.0.0.2:8080/?action=snapshot"
    assert w.resolve_url("javascript:alert(1)", "10.0.0.2") == ""


def test_hostname_from_various_inputs():
    assert w.printer_hostname("http://192.168.1.9:7125/") == "192.168.1.9"
    assert w.printer_hostname("voron.local:7125") == "voron.local"
    assert w.printer_hostname("192.168.1.9") == "192.168.1.9"


def test_clean_camera_modes_and_safety():
    assert w.clean_camera({"stream_url": "http://a/webcam/?action=stream"})["mode"] == "mjpeg"
    snap = w.clean_camera({"stream_url": "http://a/webrtc", "snapshot_url": "http://a/snap.jpg", "service": "webrtc-camerastreamer"})
    assert snap["mode"] == "snapshot"
    assert w.clean_camera({"stream_url": "http://a/webrtc", "service": "webrtc-camerastreamer"})["mode"] == "page"
    assert w.clean_camera({"stream_url": "file:///etc/passwd"}) is None
    assert w.clean_camera({"stream_url": "http://a/x", "rotation": 45})["rotation"] == 0


def test_legacy_webcam_url_becomes_a_camera():
    cams = w.cameras_for({"webcam_url": "http://192.168.1.103/webcam/?action=stream"})
    assert len(cams) == 1 and cams[0]["mode"] == "mjpeg"


def _fake_printer(request: httpx.Request) -> httpx.Response:
    path = request.url.raw_path.decode()
    if request.url.port == 7125 and path == "/server/webcams/list":
        return httpx.Response(200, json={"result": {"webcams": [
            {"name": "nozzle", "enabled": True, "service": "mjpegstreamer-adaptive",
             "stream_url": "/webcam/?action=stream", "snapshot_url": "/webcam/?action=snapshot",
             "rotation": 180, "flip_horizontal": True, "flip_vertical": False},
            {"name": "off", "enabled": False, "stream_url": "/webcam9/?action=stream"},
        ]}})
    if path == "/webcam2/?action=stream":
        return httpx.Response(200, headers={"content-type": "multipart/x-mixed-replace; boundary=x"}, content=b"--x")
    return httpx.Response(404)


def test_discover_lists_moonraker_cams_and_finds_extra_ones():
    res = asyncio.run(w.discover("192.168.1.50", 7125, "moonraker", transport=httpx.MockTransport(_fake_printer)))
    names = [c["name"] for c in res["cameras"]]
    assert names == ["nozzle", "Webcam 2"]
    nozzle = res["cameras"][0]
    assert nozzle["stream_url"] == "http://192.168.1.50/webcam/?action=stream"
    assert nozzle["rotation"] == 180 and nozzle["flip_h"] is True and nozzle["source"] == "moonraker"
    assert res["cameras"][1]["source"] == "found"
