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


def normalize_custom_role_selections(value) -> dict[str, list[str]]:
    """Validate one or more selected role IDs for each character number."""
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError("自选角色配置必须是对象")
    result = {}
    for number in range(1, 10):
        key = str(number)
        raw = value.get(key, value.get(number))
        options = [character for character in CHARACTERS if character["num"] == number]
        if raw is None or raw == "all":
            selected = {character["id"] for character in options}
        elif isinstance(raw, list):
            selected = set()
            for role_id in raw:
                character = CHAR_MAP.get(role_id) if isinstance(role_id, str) else None
                if not character or character["num"] != number:
                    raise ValueError(f"{number}号自选角色中包含无效角色")
                selected.add(role_id)
        else:
            raise ValueError(f"{number}号自选角色必须是角色编号列表")
        if not selected:
            raise ValueError(f"请为{number}号至少选择一个角色")
        result[key] = [character["id"] for character in options if character["id"] in selected]
    return result


def normalize_scenario(value) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str) or value not in SCENARIO_MAP:
        raise ValueError("未知的剧本选项")
    return value
