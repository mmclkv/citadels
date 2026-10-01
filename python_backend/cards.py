"""Static game data and deterministic card helpers, with no JavaScript runtime dependency."""

from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Callable, TypeVar

_catalog = json.loads((Path(__file__).with_name("catalog.json")).read_text(encoding="utf-8"))
COLORS = _catalog["colors"]
DISTRICTS = _catalog["districts"]
CHARACTERS = _catalog["characters"]
CHAR_MAP = {character["id"]: character for character in CHARACTERS}

T = TypeVar("T")


def shuffle(items: list[T], rnd: Callable[[], float] = random.random) -> list[T]:
    result = items.copy()
    for index in range(len(result) - 1, 0, -1):
        selected = int(rnd() * (index + 1))
        result[index], result[selected] = result[selected], result[index]
    return result


def build_district_deck(rnd: Callable[[], float] = random.random) -> list[dict]:
    cards = []
    for definition in DISTRICTS:
        for _ in range(definition["count"]):
            cards.append({
                "uid": f"d{len(cards)}",
                "name": definition["name"],
                "en": definition["en"],
                "color": definition["color"],
                "cost": definition["cost"],
                "scoreValue": definition.get("scoreValue") or definition["cost"],
                "purple": definition.get("purple", {}).copy() or None,
                "desc": definition.get("desc") or "",
            })
    return shuffle(cards, rnd)


def pick_character_set(player_count: int, mode: str = "base",
                       rnd: Callable[[], float] = random.random) -> list[dict]:
    mode = mode or "base"
    if mode == "base":
        pool = [character for character in CHARACTERS if character["version"] == "base"]
    elif mode == "dark":
        ids = ("witch", "blackmailer", "wizard", "emperor", "abbot", "alchemist",
               "navigator", "diplomat", "tax_collector")
        pool = [CHAR_MAP[character_id] for character_id in ids]
    else:
        by_number: dict[int, list[dict]] = {}
        for character in CHARACTERS:
            if (character.get("twoPlayerBan") and player_count <= 2 or
                    character.get("smallBan", 0) > player_count):
                continue
            by_number.setdefault(character["num"], []).append(character)
        pool = [options[int(rnd() * len(options))] for _, options in sorted(by_number.items())]

    characters = sorted((character for character in pool
                         if not (character.get("twoPlayerBan") and player_count <= 2)
                         and character.get("smallBan", 0) <= player_count),
                        key=lambda character: character["num"])
    if player_count <= 3 and len(characters) > 8:
        seen = set()
        filtered = []
        for character in characters:
            if character["num"] not in seen:
                seen.add(character["num"])
                filtered.append(character)
        characters = filtered[:8]
    if len(characters) < player_count + 1:
        used = {character["num"] for character in characters}
        extras = sorted((character for character in CHARACTERS
                         if character["num"] not in used
                         and not (character.get("twoPlayerBan") and player_count <= 2)
                         and character.get("smallBan", 0) <= player_count),
                        key=lambda character: -character["num"])
        for character in extras:
            if len(characters) >= player_count + 1:
                break
            if character["num"] not in used:
                characters.append(character)
                used.add(character["num"])
        characters.sort(key=lambda character: character["num"])
    return characters
