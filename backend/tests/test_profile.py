"""First-run setup profile. Run from the project root:  python -m pytest backend/tests -q"""
import pytest

from backend import config, profile


@pytest.fixture(autouse=True)
def temp_config(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")


def test_fresh_install_needs_setup():
    p = profile.get_profile()
    assert p["setup_complete"] is False
    assert profile.user_name() == "Operator"


def test_name_replaces_karl_but_not_other_words():
    profile.save_profile({"name": "Sam Taylor", "call_me": "Sam", "setup_complete": True})
    assert profile.personalise("That's not a nap, Karl. Karl's rig.") == "That's not a nap, Sam. Sam's rig."
    assert profile.personalise("Karlsson") == "Karlsson"


def test_call_me_falls_back_to_name_and_bad_pronoun_is_he():
    profile.save_profile({"name": "Jo", "pronouns": "xyz"})
    assert profile.user_name() == "Jo"
    assert profile.pronoun("possessive") == "his"


def test_about_line_for_the_ai():
    profile.save_profile({"name": "Jo", "about": "Keep me on one thing", "units": "imperial", "lunch_reminder": True})
    line = profile.about_for_ai()
    assert "Keep me on one thing." in line and "inches" in line and "midday" in line


def test_profile_lives_in_config_json_not_elsewhere(tmp_path):
    profile.save_profile({"name": "Jo", "setup_complete": True})
    assert [f.name for f in tmp_path.iterdir()] == ["config.json"]
    assert config.load_config()["profile"]["name"] == "Jo"
