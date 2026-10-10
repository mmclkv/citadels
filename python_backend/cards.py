"""Static game data and deterministic card helpers, with no JavaScript runtime dependency."""

from __future__ import annotations

import json
from pathlib import Path

_catalog = json.loads((Path(__file__).with_name("catalog.json")).read_text(encoding="utf-8"))
COLORS = _catalog["colors"]
DISTRICTS = _catalog["districts"]
CHARACTERS = _catalog["characters"]
CHAR_MAP = {character["id"]: character for character in CHARACTERS}
SCENARIOS = _catalog["scenarios"]
SCENARIO_MAP = {scenario["id"]: scenario for scenario in SCENARIOS}


def normalize_scenario(value) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or value not in SCENARIO_MAP:
        raise ValueError("未知的剧本选项")
    return value
