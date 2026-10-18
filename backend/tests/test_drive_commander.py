"""Run from the project root:  python -m pytest backend/tests -q"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import drive_commander as dc


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(dc, "UNDO_LOG_FILE", tmp_path / "undo.json")
    app = FastAPI()
    app.include_router(dc.router)
    return TestClient(app)


def make(folder, *names):
    folder.mkdir(parents=True, exist_ok=True)
    for n in names:
        (folder / n).write_text("x")


def test_organize_moves_and_undo_restores(client, tmp_path):
    d = tmp_path / "Downloads"
    make(d, "bracket.stl", "notes.pdf", "thing.zip")
    r = client.post("/api/folder/organize", json={"path": str(d), "categories": ["3D Models & CAD", "Documents & Notes"], "dry_run": False})
    assert r.status_code == 200 and r.json()["count"] == 2
    assert (d / "_3D_Models_STLs" / "bracket.stl").exists() and (d / "thing.zip").exists()
    op = client.get("/api/undo/history").json()["history"][0]
    client.post("/api/undo/revert", json={"id": op["id"]})
    assert (d / "bracket.stl").exists() and (d / "notes.pdf").exists()


def test_refuses_installed_program_folder(client, tmp_path):
    d = tmp_path / "SomeApp"
    make(d, "app.exe", "core.dll", "config.json")
    r = client.post("/api/folder/organize", json={"path": str(d), "categories": ["Code & Scripts"], "dry_run": False})
    assert r.status_code == 400 and "program" in r.json()["detail"]
    assert (d / "config.json").exists()


def test_refuses_code_project(client, tmp_path):
    d = tmp_path / "havoc"
    make(d, "package.json", "app.py")
    r = client.post("/api/folder/organize", json={"path": str(d), "categories": ["Code & Scripts"], "dry_run": True})
    assert r.status_code == 400


def test_duplicate_scan_skips_app_folders(client, tmp_path):
    root = tmp_path / "stuff"
    make(root / "a", "big.stl")
    make(root / "b", "big.stl")
    make(root / "game", "big.stl", "engine.dll")
    for f in [root / "a" / "big.stl", root / "b" / "big.stl", root / "game" / "big.stl"]:
        f.write_bytes(b"0" * 2_000_000)
    res = client.post("/api/duplicates/scan", json={"path": str(root), "min_size_mb": 1}).json()
    assert res["duplicate_sets"] == 1
    paths = [f["path"] for f in res["clusters"][0]["files"]]
    assert len(paths) == 2 and not any("game" in p for p in paths)


def test_lan_device_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(dc, "UNDO_LOG_FILE", tmp_path / "undo.json")
    app = FastAPI()
    app.include_router(dc.router)
    lan = TestClient(app, client=("192.168.1.50", 5555))
    assert lan.get("/api/undo/history").status_code == 403
