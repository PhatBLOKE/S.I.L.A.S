import os
import sys
import json
import shutil
import hashlib
import time
from pathlib import Path, PureWindowsPath
from typing import List, Dict, Any, Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Body, Request
from pydantic import BaseModel

from .security import is_loopback


def _local_only(request: Request) -> None:
    """File moves are only allowed from the SILAS PC itself - never from another LAN device,
    even one holding the access token."""
    if not is_loopback(request.client.host if request.client else None):
        raise HTTPException(status_code=403, detail="Drive Commander only works on the SILAS PC itself.")


router = APIRouter(tags=["Drive Commander"], dependencies=[Depends(_local_only)])

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
UNDO_LOG_FILE = DATA_DIR / "undo_history.json"

PROTECTED_NAMES = {
    "$recycle.bin",
    "system volume information",
    "recovery",
    "dumpstack.log",
    "dumpstack.log.tmp",
    "pagefile.sys",
    "swapfile.sys",
    "hiberfil.sys",
    "bootmgr",
    "bootnxt",
    ".gamingroot",
    "steamlibrary",
    "xboxz",
    "xboxgames",
    "windowsapps",
    "wpsystem",
    "diablo iv",
    "star wars outlaws",
    "reddead",
    "farming",
    "star citizen",
    "callisto protocol",
    "battlestate games",
    "dodi-repacks",
    "program files",
    "program files (x86)",
    "programdata",
    "windows",
    "windows.old",
    "users",
    "documents and settings",
    "$getcurrent",
    "$sysreset",
    "$windows.~ws",
    "$winreagent"
}

CATEGORY_MAP = {
    "3D Models & CAD": [".stl", ".3mf", ".step", ".stp", ".obj", ".ctb", ".blend", ".dxf", ".scad"],
    "G-Code & Slicing": [".gcode", ".gcode.3mf", ".orca_printer"],
    "Firmware & Configs": [".bin", ".elf", ".dtb", ".hex", ".cfg", ".ini", ".env"],
    "Archives & Zips": [".zip", ".rar", ".7z", ".tar", ".gz", ".xz", ".bz2"],
    "Images & Textures": [".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp", ".tiff", ".psd"],
    "Videos & Captures": [".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv"],
    "Installers & EXEs": [".exe", ".msi", ".iso", ".msix"],
    "Documents & Notes": [".pdf", ".txt", ".docx", ".xlsx", ".md", ".doc", ".rtf", ".csv"],
    # .dll deliberately excluded: moving one breaks whatever program sits next to it.
    "Code & Scripts": [".py", ".ps1", ".bat", ".sh", ".json", ".yaml", ".yml", ".cpp", ".h", ".c"],
    "Shortcuts": [".lnk", ".url"]
}

def load_undo_history() -> List[Dict[str, Any]]:
    if not UNDO_LOG_FILE.exists():
        return []
    try:
        with open(UNDO_LOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def save_undo_history(history: List[Dict[str, Any]]) -> None:
    # Atomic write: the undo log is the only way back, it must never be half-written.
    tmp = UNDO_LOG_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2)
    os.replace(tmp, UNDO_LOG_FILE)

# Any folder *inside* one of these is off limits too (AppData, Steam libraries, Program Files...).
PROTECTED_ANCESTORS = (PROTECTED_NAMES - {"users", "documents and settings"}) | {"appdata", "steamapps", "epic games", "gog games", "ea games",
                                          "ubisoft game launcher", "battle.net", "riot games", "node_modules",
                                          ".git", "site-packages", "onedrive"}

# Files that mean "this folder is a program or a code project - shuffling it will break it".
APP_MARKERS = {".git", "package.json", "node_modules", "pyproject.toml", "requirements.txt", "setup.py",
               "cmakelists.txt", "makefile", "platformio.ini", "steam_appid.txt", "unins000.exe",
               "uninstall.exe", "printer.cfg", "moonraker.conf", ".vscode", "venv", ".venv"}


def is_protected(path_str: str) -> bool:
    """True if the path itself or ANY folder above it is protected (was: only the last name)."""
    p = PureWindowsPath(path_str)
    parts = [x.lower().rstrip("\\/") for x in p.parts]
    if p.name.lower() in PROTECTED_NAMES:
        return True
    # Ignore the drive root itself (e.g. 'E:\\'); check every folder name on the way down.
    return any(part in PROTECTED_ANCESTORS for part in parts[1:])


def app_or_project_reason(folder: Path) -> Optional[str]:
    """Why this folder must not be reorganised, or None if it looks like plain storage."""
    try:
        names = {e.name.lower(): e for e in os.scandir(str(folder))}
    except Exception:
        return None
    hit = sorted(m for m in APP_MARKERS if m in names)
    if hit:
        return f"looks like a program or code project ({', '.join(hit[:3])})"
    if any(n.endswith(".dll") for n in names):
        return "contains .dll files - it's an installed program"
    return None


def _guard_folder(p: Path) -> None:
    if is_protected(str(p)):
        raise HTTPException(status_code=400, detail="This is inside a protected system/game/app area. Silas refuses to touch it.")
    reason = app_or_project_reason(p)
    if reason:
        raise HTTPException(status_code=400, detail=f"Not touching this folder: it {reason}.")

def get_hash(filepath: Path, chunk_only: bool = False) -> str:
    hasher = hashlib.md5()
    try:
        with open(filepath, "rb") as f:
            if chunk_only:
                hasher.update(f.read(65536))
            else:
                for chunk in iter(lambda: f.read(1048576), b""):
                    hasher.update(chunk)
        return hasher.hexdigest()
    except Exception:
        return ""

def format_size(size_bytes: int) -> str:
    if size_bytes >= 1024**4:
        return f"{size_bytes / (1024**4):.2f} TB"
    elif size_bytes >= 1024**3:
        return f"{size_bytes / (1024**3):.2f} GB"
    elif size_bytes >= 1024**2:
        return f"{size_bytes / (1024**2):.2f} MB"
    elif size_bytes >= 1024:
        return f"{size_bytes / 1024:.2f} KB"
    return f"{size_bytes} B"

@router.get("/api/drives")
def list_drives():
    drives = []
    drive_type_map = {
        0: "Unknown",
        1: "No Root Directory",
        2: "Removable (USB)",
        3: "Fixed SSD/HDD",
        4: "Network Drive",
        5: "CD-ROM",
        6: "RAM Disk"
    }

    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        root = f"{letter}:\\"
        if os.path.exists(root):
            try:
                total, used, free = shutil.disk_usage(root)
                vol_name = ""
                drive_type_str = "Fixed SSD"
                try:
                    import win32api, win32file
                    vol_info = win32api.GetVolumeInformation(root)
                    vol_name = vol_info[0] if vol_info else ""
                    dt = win32file.GetDriveType(root)
                    drive_type_str = drive_type_map.get(dt, "Fixed Drive")
                except Exception:
                    pass

                percent_used = round((used / total) * 100, 1) if total > 0 else 0
                status = "healthy"
                if percent_used >= 95:
                    status = "critical"
                elif percent_used >= 85:
                    status = "warning"

                drives.append({
                    "drive": f"{letter}:",
                    "letter": letter,
                    "path": root,
                    "name": vol_name if vol_name else ("Windows System" if letter == "C" else f"Local Disk ({letter}:)"),
                    "type": drive_type_str,
                    "total": total,
                    "used": used,
                    "free": free,
                    "total_str": format_size(total),
                    "used_str": format_size(used),
                    "free_str": format_size(free),
                    "percent_used": percent_used,
                    "status": status
                })
            except Exception:
                pass
    return {"drives": drives}

@router.get("/api/drive/inspect")
def inspect_drive(drive: str = "E:"):
    root_path = Path(f"{drive[0].upper()}:\\")
    if not root_path.exists():
        raise HTTPException(status_code=404, detail="Drive not found")

    try:
        total, used, free = shutil.disk_usage(str(root_path))
    except Exception:
        total, used, free = 0, 0, 0

    folders = []
    loose_files = []
    empty_folders = []

    try:
        for entry in os.scandir(str(root_path)):
            name_lower = entry.name.lower()
            if entry.is_dir(follow_symlinks=False):
                protected = is_protected(entry.name)
                category = "User Workshop"
                if protected:
                    if any(g in name_lower for g in ["steam", "xbox", "windowsapps", "wpsystem", "diablo", "reddead", "outlaws", "farming", "games", "citizen", "callisto", "battlestate", "repack"]):
                        category = "Game Library (Protected)"
                    else:
                        category = "System Directory (Protected)"
                elif "3d" in name_lower or "phatbloke" in name_lower or "print" in name_lower:
                    category = "3D Workshop"
                elif "capture" in name_lower or "clip" in name_lower or "stream" in name_lower:
                    category = "Media & Captures"
                elif "mod" in name_lower or "joystick" in name_lower:
                    category = "Mods & Gaming"

                is_empty = False
                try:
                    with os.scandir(entry.path) as sub_scan:
                        first = next(sub_scan, None)
                        if first is None:
                            is_empty = True
                            if not protected:
                                empty_folders.append({"name": entry.name, "path": entry.path})
                except Exception:
                    pass

                folders.append({
                    "name": entry.name,
                    "path": entry.path,
                    "protected": protected,
                    "category": category,
                    "is_empty": is_empty,
                    "mtime": datetime.fromtimestamp(entry.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
                })
            elif entry.is_file(follow_symlinks=False):
                stat = entry.stat()
                ext = Path(entry.name).suffix.lower()
                cat = "Other / Loose"
                for cat_name, exts in CATEGORY_MAP.items():
                    if ext in exts:
                        cat = cat_name
                        break

                loose_files.append({
                    "name": entry.name,
                    "path": entry.path,
                    "size": stat.st_size,
                    "size_str": format_size(stat.st_size),
                    "protected": is_protected(entry.name),
                    "category": cat,
                    "ext": ext,
                    "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    presets = []
    d_letter = drive[0].upper()
    if d_letter == "E":
        presets = [
            {"name": "PhatBLOKE 3d \\ To sort through", "path": "E:\\PhatBLOKE 3d\\To sort through"},
            {"name": "PhatBLOKE 3d (Full Root)", "path": "E:\\PhatBLOKE 3d"},
            {"name": "back up", "path": "E:\\back up"},
            {"name": "Streaming", "path": "E:\\Streaming"},
            {"name": "Capture", "path": "E:\\Capture"}
        ]
    elif d_letter == "F":
        presets = [
            {"name": "Misc", "path": "F:\\Misc"},
            {"name": "Star Citizen", "path": "F:\\Star Citizen"},
            {"name": "SteamLibrary", "path": "F:\\SteamLibrary"}
        ]
    elif d_letter == "C":
        presets = [
            {"name": "User Downloads", "path": "C:\\Users\\PhatBLOKE\\Downloads"},
            {"name": "User Desktop", "path": "C:\\Users\\PhatBLOKE\\Desktop"},
            {"name": "OctoPrint", "path": "C:\\OctoPrint"},
            {"name": "Temp", "path": "C:\\Temp"}
        ]

    return {
        "drive": drive,
        "total": total,
        "used": used,
        "free": free,
        "total_str": format_size(total),
        "used_str": format_size(used),
        "free_str": format_size(free),
        "percent_used": round((used / total) * 100, 1) if total > 0 else 0,
        "folders": sorted(folders, key=lambda x: (not x["protected"], x["name"])),
        "empty_folders": empty_folders,
        "loose_files": sorted(loose_files, key=lambda x: x["size"], reverse=True),
        "presets": presets
    }

@router.post("/api/root/organize")
def organize_root_files(data: Dict[str, Any] = Body(...)):
    drive = data.get("drive", "E:")
    dry_run = data.get("dry_run", True)
    root_path = Path(f"{drive[0].upper()}:\\")
    system_drive = (os.environ.get("SystemDrive") or "C:")[0].upper()
    if drive[0].upper() == system_drive:
        raise HTTPException(status_code=400, detail="Not reorganising the root of the Windows drive. Pick a folder instead.")

    dest_map = {
        "3D Models & CAD": root_path / "_3D_Models_and_CAD",
        "Firmware & Configs": root_path / "_Firmware_and_3D",
        "Installers & EXEs": root_path / "_Installers",
        "Shortcuts": root_path / "_Shortcuts",
        "Archives & Zips": root_path / "_Archives",
        "Documents & Notes": root_path / "_Documents",
        "Images & Textures": root_path / "_Images",
        "Videos & Captures": root_path / "_Videos",
        "Code & Scripts": root_path / "_Scripts"
    }

    moves = []
    skipped = []

    for entry in os.scandir(str(root_path)):
        if entry.is_file(follow_symlinks=False):
            if is_protected(entry.name):
                skipped.append({"name": entry.name, "reason": "Protected system/game file"})
                continue

            ext = Path(entry.name).suffix.lower()
            target_folder = None
            category_found = "Other"

            for cat_name, exts in CATEGORY_MAP.items():
                if ext in exts and cat_name in dest_map:
                    target_folder = dest_map[cat_name]
                    category_found = cat_name
                    break

            if not target_folder:
                skipped.append({"name": entry.name, "reason": "Unrecognized category, left alone for safety"})
                continue

            dest_path = target_folder / entry.name
            moves.append({
                "src": entry.path,
                "dst": str(dest_path),
                "name": entry.name,
                "category": category_found,
                "size_str": format_size(entry.stat().st_size)
            })

    if not dry_run and moves:
        executed_moves = []
        for m in moves:
            src = Path(m["src"])
            dst = Path(m["dst"])
            try:
                dst.parent.mkdir(exist_ok=True)
                final_dst = dst
                counter = 1
                while final_dst.exists():
                    final_dst = dst.parent / f"{dst.stem}_{counter}{dst.suffix}"
                    counter += 1
                shutil.move(str(src), str(final_dst))
                executed_moves.append({"src": str(src), "dst": str(final_dst)})
            except Exception as e:
                m["error"] = str(e)

        history = load_undo_history()
        history.append({
            "id": f"op_{int(time.time())}",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "action": f"Organize {drive} Root Files",
            "count": len(executed_moves),
            "moves": executed_moves
        })
        save_undo_history(history)

    return {
        "dry_run": dry_run,
        "planned_moves": moves,
        "skipped": skipped,
        "count": len(moves)
    }

@router.post("/api/folder/scan")
def scan_folder(data: Dict[str, Any] = Body(...)):
    folder_path = data.get("path")
    if not folder_path or not os.path.exists(folder_path):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    p = Path(folder_path)
    if is_protected(str(p)):
        raise HTTPException(status_code=400, detail="This is a protected system/game directory. Silas refuses to touch it.")

    recursive = data.get("recursive", False)

    categories: Dict[str, List[Dict[str, Any]]] = {cat: [] for cat in CATEGORY_MAP}
    categories["Other"] = []
    total_size = 0
    total_files = 0

    def process_file(entry_path: Path):
        nonlocal total_size, total_files
        try:
            stat = entry_path.stat()
            size = stat.st_size
            total_size += size
            total_files += 1
            ext = entry_path.suffix.lower()

            placed = False
            for cat_name, exts in CATEGORY_MAP.items():
                if ext in exts:
                    categories[cat_name].append({
                        "name": entry_path.name,
                        "path": str(entry_path),
                        "size": size,
                        "size_str": format_size(size),
                        "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                    })
                    placed = True
                    break
            if not placed:
                categories["Other"].append({
                    "name": entry_path.name,
                    "path": str(entry_path),
                    "size": size,
                    "size_str": format_size(size),
                    "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                })
        except Exception:
            pass

    if recursive:
        for root, dirs, files in os.walk(str(p)):
            dirs[:] = [d for d in dirs if not is_protected(d) and not d.startswith("_")]
            for f in files:
                process_file(Path(root) / f)
    else:
        for entry in os.scandir(str(p)):
            if entry.is_file(follow_symlinks=False):
                process_file(Path(entry.path))

    category_stats = []
    for cat_name, file_list in categories.items():
        if file_list:
            cat_size = sum(f["size"] for f in file_list)
            category_stats.append({
                "category": cat_name,
                "count": len(file_list),
                "total_size": cat_size,
                "total_size_str": format_size(cat_size),
                "sample_files": file_list[:50]
            })

    return {
        "path": str(p),
        "total_files": total_files,
        "total_size": total_size,
        "total_size_str": format_size(total_size),
        "categories": sorted(category_stats, key=lambda x: x["total_size"], reverse=True)
    }

@router.post("/api/folder/organize")
def organize_folder(data: Dict[str, Any] = Body(...)):
    folder_path = data.get("path")
    selected_categories = data.get("categories", [])
    dry_run = data.get("dry_run", True)

    if not folder_path or not os.path.exists(folder_path):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    p = Path(folder_path)
    _guard_folder(p)

    moves = []
    folder_naming = {
        "3D Models & CAD": "_3D_Models_STLs",
        "G-Code & Slicing": "_GCode_Slices",
        "Firmware & Configs": "_Firmware_and_Configs",
        "Archives & Zips": "_Archives_and_Zips",
        "Images & Textures": "_Images_and_Textures",
        "Videos & Captures": "_Videos_and_Clips",
        "Installers & EXEs": "_Installers",
        "Documents & Notes": "_Documents_and_Notes",
        "Code & Scripts": "_Scripts_and_Code",
        "Shortcuts": "_Shortcuts"
    }

    for entry in os.scandir(str(p)):
        if entry.is_file(follow_symlinks=False):
            ext = Path(entry.name).suffix.lower()
            matched_cat = None
            for cat_name, exts in CATEGORY_MAP.items():
                if ext in exts:
                    matched_cat = cat_name
                    break

            if matched_cat and matched_cat in selected_categories:
                subfolder_name = folder_naming.get(matched_cat, f"_{matched_cat.replace(' ', '_')}")
                dest_dir = p / subfolder_name
                dest_path = dest_dir / entry.name
                moves.append({
                    "src": entry.path,
                    "dst": str(dest_path),
                    "name": entry.name,
                    "category": matched_cat,
                    "size_str": format_size(entry.stat().st_size)
                })

    if not dry_run and moves:
        executed_moves = []
        for m in moves:
            src = Path(m["src"])
            dst = Path(m["dst"])
            try:
                dst.parent.mkdir(exist_ok=True)
                final_dst = dst
                counter = 1
                while final_dst.exists():
                    final_dst = dst.parent / f"{dst.stem}_{counter}{dst.suffix}"
                    counter += 1
                shutil.move(str(src), str(final_dst))
                executed_moves.append({"src": str(src), "dst": str(final_dst)})
            except Exception as e:
                m["error"] = str(e)

        history = load_undo_history()
        history.append({
            "id": f"op_{int(time.time())}",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "action": f"Organize {p.name}",
            "count": len(executed_moves),
            "moves": executed_moves
        })
        save_undo_history(history)

    return {
        "dry_run": dry_run,
        "count": len(moves),
        "planned_moves": moves
    }

@router.post("/api/duplicates/scan")
def scan_duplicates(data: Dict[str, Any] = Body(...)):
    folder_path = data.get("path")
    min_size_mb = data.get("min_size_mb", 1)
    min_size_bytes = int(min_size_mb * 1024 * 1024)

    if not folder_path or not os.path.exists(folder_path):
        raise HTTPException(status_code=400, detail="Invalid folder path")

    p = Path(folder_path)
    if is_protected(str(p)):
        raise HTTPException(status_code=400, detail="Protected directory.")

    size_map: Dict[int, List[Path]] = {}
    total_scanned = 0

    for root, dirs, files in os.walk(str(p)):
        # Skip protected areas and program/project folders: a "duplicate" DLL or asset inside an
        # installed app is not clutter, it's load-bearing.
        dirs[:] = [d for d in dirs if not is_protected(str(Path(root) / d)) and not d.startswith("_")
                   and not app_or_project_reason(Path(root) / d)]
        for f in files:
            fp = Path(root) / f
            try:
                if not fp.is_symlink():
                    sz = fp.stat().st_size
                    total_scanned += 1
                    if sz >= min_size_bytes:
                        size_map.setdefault(sz, []).append(fp)
            except Exception:
                pass

    chunk_map: Dict[str, List[Path]] = {}
    for sz, file_list in size_map.items():
        if len(file_list) > 1:
            for fp in file_list:
                chash = get_hash(fp, chunk_only=True)
                if chash:
                    key = f"{sz}_{chash}"
                    chunk_map.setdefault(key, []).append(fp)

    duplicate_clusters = []
    total_wasted_bytes = 0

    for key, file_list in chunk_map.items():
        if len(file_list) > 1:
            full_map: Dict[str, List[Path]] = {}
            for fp in file_list:
                fhash = get_hash(fp, chunk_only=False)
                if fhash:
                    full_map.setdefault(fhash, []).append(fp)

            for fhash, matches in full_map.items():
                if len(matches) > 1:
                    matches.sort(key=lambda x: x.stat().st_mtime, reverse=True)
                    sz = matches[0].stat().st_size
                    wasted = sz * (len(matches) - 1)
                    total_wasted_bytes += wasted

                    duplicate_clusters.append({
                        "hash": fhash,
                        "file_size": sz,
                        "file_size_str": format_size(sz),
                        "wasted_str": format_size(wasted),
                        "count": len(matches),
                        "files": [
                            {
                                "name": fp.name,
                                "path": str(fp),
                                "dir": str(fp.parent),
                                "mtime": datetime.fromtimestamp(fp.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                            }
                            for fp in matches
                        ]
                    })

    duplicate_clusters.sort(key=lambda x: x["file_size"] * (x["count"] - 1), reverse=True)

    return {
        "scanned_files": total_scanned,
        "duplicate_sets": len(duplicate_clusters),
        "total_wasted_str": format_size(total_wasted_bytes),
        "total_wasted_bytes": total_wasted_bytes,
        "clusters": duplicate_clusters[:100]
    }

@router.post("/api/duplicates/quarantine")
def quarantine_duplicates(data: Dict[str, Any] = Body(...)):
    files_to_quarantine = data.get("files", [])
    drive = data.get("drive", "E:")
    dry_run = data.get("dry_run", True)

    quarantine_root = Path(f"{drive[0].upper()}:\\_Duplicates_Quarantine")

    planned = []
    for fp_str in files_to_quarantine:
        fp = Path(fp_str)
        if fp.exists() and fp.is_file() and not is_protected(str(fp)) and not app_or_project_reason(fp.parent):
            dest = quarantine_root / fp.name
            planned.append({
                "src": str(fp),
                "dst": str(dest),
                "size_str": format_size(fp.stat().st_size)
            })

    if not dry_run and planned:
        quarantine_root.mkdir(exist_ok=True)
        executed = []
        for p in planned:
            src = Path(p["src"])
            dst = Path(p["dst"])
            try:
                final_dst = dst
                c = 1
                while final_dst.exists():
                    final_dst = dst.parent / f"{dst.stem}_{c}{dst.suffix}"
                    c += 1
                shutil.move(str(src), str(final_dst))
                executed.append({"src": str(src), "dst": str(final_dst)})
            except Exception as e:
                p["error"] = str(e)

        history = load_undo_history()
        history.append({
            "id": f"op_{int(time.time())}",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "action": f"Quarantine Duplicates ({drive})",
            "count": len(executed),
            "moves": executed
        })
        save_undo_history(history)

    return {
        "dry_run": dry_run,
        "planned": planned,
        "count": len(planned)
    }

@router.post("/api/empty_folders/prune")
def prune_empty_folders(data: Dict[str, Any] = Body(...)):
    folders = data.get("folders", [])
    dry_run = data.get("dry_run", True)

    pruned = []
    skipped = []

    for f_path in folders:
        p = Path(f_path)
        if is_protected(str(p)):
            skipped.append({"path": f_path, "reason": "Protected folder"})
            continue

        try:
            has_items = any(os.scandir(str(p)))
            if has_items:
                skipped.append({"path": f_path, "reason": "Folder is not empty"})
                continue

            if not dry_run:
                p.rmdir()
            pruned.append({"path": f_path})
        except Exception as e:
            skipped.append({"path": f_path, "reason": str(e)})

    return {
        "dry_run": dry_run,
        "pruned": pruned,
        "skipped": skipped
    }

@router.get("/api/undo/history")
def get_history():
    return {"history": load_undo_history()}

@router.post("/api/undo/revert")
def revert_operation(data: Dict[str, Any] = Body(...)):
    op_id = data.get("id")
    history = load_undo_history()

    target_op = None
    target_idx = -1
    for i, op in enumerate(history):
        if op.get("id") == op_id:
            target_op = op
            target_idx = i
            break

    if not target_op:
        raise HTTPException(status_code=404, detail="Operation ID not found")

    reverted = []
    errors = []

    for item in reversed(target_op.get("moves", [])):
        src = Path(item["src"])
        dst = Path(item["dst"])
        if dst.exists():
            try:
                src.parent.mkdir(exist_ok=True)
                shutil.move(str(dst), str(src))
                reverted.append({"src": str(dst), "dst": str(src)})
            except Exception as e:
                errors.append({"file": str(dst), "error": str(e)})
        else:
            errors.append({"file": str(dst), "error": "File no longer at destination"})

    if errors:
        # Keep what couldn't be restored so it can be retried; drop only what came back.
        restored = {r["src"] for r in reverted}
        target_op["moves"] = [m for m in target_op.get("moves", []) if m["dst"] not in restored]
        target_op["count"] = len(target_op["moves"])
        target_op["action"] = target_op["action"].split(" (partly undone)")[0] + " (partly undone)"
    else:
        history.pop(target_idx)
    save_undo_history(history)

    return {
        "reverted_count": len(reverted),
        "errors": errors
    }
