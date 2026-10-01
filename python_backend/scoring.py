"""Authoritative Python city scoring; preserves the JavaScript result shape."""

from __future__ import annotations

from .cards import COLORS


def district_score(card: dict) -> int:
    special = card.get("purple") or {}
    if special.get("effect") == "scoreAs":
        return special["scoreAs"]
    return card.get("scoreValue") or card["cost"]


def compute_scores(state: dict) -> list[dict]:
    target = state["config"]["endDistricts"]
    rows = []
    for index, player in enumerate(state["players"]):
        city = player["city"]
        base = sum(district_score(card) for card in city)
        museum = sum(len(card.get("museum") or []) for card in city)
        beautified = sum(1 for card in city if card.get("beautified"))
        bonus = 0
        detail = [{"label": "建筑总分", "value": base}]
        if museum:
            bonus += museum
            detail.append({"label": "博物馆", "value": museum})
        if beautified:
            bonus += beautified
            detail.append({"label": "美化", "value": beautified})

        colors = {card["color"] for card in city}
        missing = sum(1 for color in COLORS if color not in colors)
        usable_ghosts = sum(1 for card in city
                            if (card.get("purple") or {}).get("effect") == "anyColorScore"
                            and card.get("builtRound") != state["round"])
        if missing == 0 or 0 < missing <= usable_ghosts:
            bonus += 3
            detail.append({"label": "五色齐全", "value": 3})

        if state["firstToFinish"] == index:
            bonus += 4
            detail.append({"label": f"率先建成 {target} 栋", "value": 4})
        elif len(city) >= target:
            bonus += 2
            detail.append({"label": f"建成 {target} 栋", "value": 2})
        rows.append({"playerIdx": index, "name": player["name"], "base": base,
                     "bonus": bonus, "total": base + bonus, "detail": detail,
                     "cityCount": len(city)})
    return rows
