"""Test-only card/deck helpers for the retired Python rules reference."""

from __future__ import annotations

from typing import Callable, TypeVar

from python_backend.cards import CHARACTERS, CHAR_MAP, COLORS, DISTRICTS

T = TypeVar("T")


def shuffle(items: list[T], rnd: Callable[[], float]) -> list[T]:
    result = items.copy()
    for index in range(len(result) - 1, 0, -1):
        selected = int(rnd() * (index + 1))
        result[index], result[selected] = result[selected], result[index]
    return result


def build_district_deck(rnd: Callable[[], float]) -> list[dict]:
    deck = []
    for definition in DISTRICTS:
        for _ in range(definition["count"]):
            deck.append({
                "uid": f"d{len(deck)}", "name": definition["name"], "en": definition["en"],
                "color": definition["color"], "cost": definition["cost"],
                "scoreValue": definition.get("scoreValue") or definition["cost"],
                "purple": definition.get("purple", {}).copy() or None,
                "desc": definition.get("desc") or "",
            })
    return shuffle(deck, rnd)


def pick_character_set(player_count: int, mode: str,
                       rnd: Callable[[], float]) -> list[dict]:
    if mode == "base":
        pool = [character for character in CHARACTERS if character["version"] == "base"]
    elif mode == "dark":
        ids = ("witch", "blackmailer", "wizard", "emperor", "abbot", "alchemist",
               "navigator", "diplomat", "tax_collector")
        pool = [CHAR_MAP[character_id] for character_id in ids]
    else:
        by_number: dict[int, list[dict]] = {}
        for character in CHARACTERS:
            if ((character.get("twoPlayerBan") and player_count <= 2) or
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
        characters = [character for character in characters
                      if not (character["num"] in seen or seen.add(character["num"]))][:8]
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
