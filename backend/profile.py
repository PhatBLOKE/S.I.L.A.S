"""
Who is using this SILAS. Filled in by the first-run setup screen and editable later.

Stored in config.json under "profile" (config.json is git-ignored, so none of this
ever reaches GitHub). Everything that used to say "Karl" now asks this module.
"""
import re
from typing import Any, Dict, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .config import _lock, load_config, save_config

PRONOUNS = {
    "he": {"subject": "he", "object": "him", "possessive": "his"},
    "she": {"subject": "she", "object": "her", "possessive": "her"},
}

DEFAULT_PROFILE: Dict[str, Any] = {
    "setup_complete": False,
    "name": "",            # full or first name
    "call_me": "",         # what Silas calls you (defaults to name)
    "pronouns": "he",      # he / she
    "about": "",           # free text: how Silas should help (e.g. "I have ADHD, keep me on one thing")
    "spelling": "british",  # british / american
    "units": "metric",     # metric / imperial
    "lunch_reminder": False,
    "work_folder": "",     # default folder for the Drives tools
}


def get_profile() -> Dict[str, Any]:
    saved = load_config().get("profile")
    return {**DEFAULT_PROFILE, **(saved if isinstance(saved, dict) else {})}


def save_profile(changes: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        cfg = load_config()
        current = cfg.get("profile") if isinstance(cfg.get("profile"), dict) else {}
        merged = {**DEFAULT_PROFILE, **current, **changes}
        if merged.get("pronouns") not in PRONOUNS:
            merged["pronouns"] = "he"
        cfg["profile"] = merged
        save_config(cfg)
        return merged


def user_name(profile: Optional[Dict[str, Any]] = None) -> str:
    p = profile or get_profile()
    return (p.get("call_me") or p.get("name") or "Operator").strip() or "Operator"


def pronoun(kind: str = "subject", profile: Optional[Dict[str, Any]] = None) -> str:
    p = profile or get_profile()
    return PRONOUNS.get(p.get("pronouns"), PRONOUNS["he"])[kind]


_KARL = re.compile(r"\bKarl\b")


def personalise(text: Any) -> Any:
    """Swap the old hard-coded name for whoever set this SILAS up."""
    if not isinstance(text, str) or "Karl" not in text:
        return text
    return _KARL.sub(user_name().replace("\\", "\\\\"), text)


def personalise_reply(reply: Dict[str, Any]) -> Dict[str, Any]:
    if isinstance(reply, dict):
        for k in ("reply", "text", "message", "greeting"):
            if k in reply:
                reply[k] = personalise(reply[k])
    return reply


def about_for_ai(profile: Optional[Dict[str, Any]] = None) -> str:
    """One line for the AI's system prompt describing the user."""
    p = profile or get_profile()
    bits = [f"The operator is {user_name(p)} (pronouns: {p.get('pronouns', 'he')})."]
    if (p.get("about") or "").strip():
        about = p["about"].strip()[:600]
        bits.append(f"In {pronoun('possessive', p)} own words: {about}" + ("" if about[-1] in ".!?" else "."))
    bits.append("Use British English spelling." if p.get("spelling") != "american" else "Use American English spelling.")
    bits.append("Give measurements in millimetres and Celsius." if p.get("units") != "imperial"
                else "Give measurements in inches and Fahrenheit where natural.")
    if p.get("lunch_reminder"):
        bits.append(f"Remind {pronoun('object', p)} to eat something around midday.")
    return " " + " ".join(bits)


# --------------------------------------------------------------------------- routes
router = APIRouter()


class ProfileModel(BaseModel):
    name: str = Field("", max_length=60)
    call_me: str = Field("", max_length=40)
    pronouns: str = "he"
    about: str = Field("", max_length=600)
    spelling: str = "british"
    units: str = "metric"
    lunch_reminder: bool = False
    work_folder: str = Field("", max_length=260)
    setup_complete: Optional[bool] = None


@router.get("/api/profile")
def read_profile():
    return get_profile()


@router.post("/api/profile")
def write_profile(body: ProfileModel):
    data = body.model_dump(exclude_unset=True) if hasattr(body, "model_dump") else body.dict(exclude_unset=True)
    data = {k: (v.strip() if isinstance(v, str) else v) for k, v in data.items()}
    if data.get("spelling") not in (None, "british", "american"):
        data["spelling"] = "british"
    if data.get("units") not in (None, "metric", "imperial"):
        data["units"] = "metric"
    if data.get("setup_complete") is None:
        data.pop("setup_complete", None)
    return {"success": True, "profile": save_profile(data)}
