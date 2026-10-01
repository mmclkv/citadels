"""Small deterministic heuristic driver for Python-hosted NPC seats."""

from __future__ import annotations

import math
import random
import copy

from . import cards
from .game import _blackmailer_valid, apply_action, get_available_actions


def _color_count(player: dict, color: str | None) -> int:
    return sum(item["color"] == color for item in player["city"]) if color else 0


def _card_value(card: dict, player: dict, state: dict | None = None) -> float:
    colors = {item["color"] for item in player["city"]}
    color_count = _color_count(player, card["color"])
    value = card["cost"] * 1.05
    if card["color"] not in colors:
        value += 2.2
        if len(colors) == 4:
            value += 5.5
    else:
        value += min(1.2, color_count * 0.25)
    if card["color"] == "purple":
        value += 1.2
    effect = (card.get("purple") or {}).get("effect")
    if effect == "scoreAs":
        value += 0.8
    elif effect in ("keepBoth", "draw3keep1"):
        value += 1.0
    elif effect in ("smithy", "lab"):
        value += 0.8
    elif effect == "immune":
        value += 1.0
    elif effect == "anyColorIncome":
        value += 1.8 if _color_count(player, "blue") == 0 else 0.8
    elif effect == "extraBuild":
        value += 1.8
    if state:
        left = max(0, state["config"]["endDistricts"] - len(player["city"]))
        if left <= 2:
            value += card["cost"] * 0.35
        if left == 1:
            value += 9.0
        elif left == 0:
            value -= 8.0
        threat = any(other is not player and len(other["city"]) >=
                     state["config"]["endDistricts"] - 1 and len(other["hand"]) > 0 and other["gold"] >= 1
                     for other in state["players"])
        if threat and left == 1:
            value += 3.0
    return value


def _can_build_card(player: dict, card: dict, gold: int | None = None) -> bool:
    quarry = sum((district.get("purple") or {}).get("effect") == "quarry"
                 for district in player["city"])
    copies = sum(district["name"] == card["name"] for district in player["city"])
    return card["cost"] <= (player["gold"] if gold is None else gold) and copies < 1 + quarry


def _build_plan_score(state: dict, player: dict, gold: int | None = None) -> float:
    # Match JS buildPlanScore: one-ply card value. buildActionScore separately
    # adds the projected post-build opportunity value.
    return max((_card_value(card, player, state) for card in player["hand"]
                if _can_build_card(player, card, gold)), default=0.0)


def _strategic_position(state: dict, player_id: str) -> float:
    index = next((i for i, player in enumerate(state["players"])
                  if player["id"] == player_id), -1)
    if index < 0:
        return -1e9
    player = state["players"][index]
    target = state["config"]["endDistricts"]
    colors = len({card["color"] for card in player["city"]})
    hand_value = sum(min(2.5, card["cost"] * 0.35) for card in player["hand"])
    value = (sum(card["cost"] * 0.8 for card in player["city"]) +
             len(player["city"]) * 2.4 + colors * 1.4 + player["gold"] * 0.65 + hand_value)
    if len(player["city"]) >= target - 1:
        value += 6
    if len(player["city"]) >= target:
        value += 12
    for other_index, other in enumerate(state["players"]):
        if other_index == index:
            continue
        if (len(other["city"]) >= target - 1 and other["hand"] and other["gold"] >= 1):
            value -= 2.5
        if len(player["city"]) - len(other["city"]) >= 2:
            value += 0.4
    return value


def _projected_action_position(state: dict, player_id: str, action: dict):
    projected = copy.deepcopy(state)
    result = apply_action(projected, player_id, action)
    if not result.get("ok"):
        return None
    return projected, _strategic_position(projected, player_id)


def _build_action_score(state: dict, player: dict, card: dict) -> float:
    base = _card_value(card, player, state)
    projected = _projected_action_position(state, player["id"],
                                           {"type": "build", "uid": card["uid"]})
    if not projected:
        return base
    next_state, next_position = projected
    before = _strategic_position(state, player["id"])
    next_player = next((item for item in next_state["players"] if item["id"] == player["id"]), None)
    next_build = _build_plan_score(next_state, next_player, next_player["gold"]) if next_player else 0
    return base + (next_position - before) * 0.55 + next_build * 0.18


def _resource_projection(state: dict, player_id: str, action_type: str, baseline: float) -> float:
    projected = _projected_action_position(state, player_id, {"type": action_type})
    if not projected:
        return -1e9
    next_state, value = projected
    if action_type == "take_cards":
        turn = next_state.get("turn") or {}
        pending = turn.get("pending") or {}
        for card in pending.get("cards") or []:
            kept = _projected_action_position(next_state, player_id,
                                              {"type": "draw_keep", "uid": card["uid"]})
            if kept:
                value = max(value, kept[1])
    return value if math.isfinite(value) else baseline


def _leader_index(state: dict) -> int:
    return max(range(len(state["players"])), key=lambda i:
               sum(card["cost"] for card in state["players"][i]["city"]) +
               len(state["players"][i]["city"]) * 2)


def _character_value(state: dict, index: int, character_id: str) -> float:
    character = cards.CHAR_MAP[character_id]
    player = state["players"][index]
    value = 0.0
    if character.get("income"):
        value += _color_count(player, character["income"]) * 1.3
    value += (character.get("goldBonus") or 0) * 1.4
    value += (character.get("drawBonus") or 0) * 0.9
    value += (character.get("buildLimit", 1) - 1) * 1.6
    if character.get("noBuild"):
        value -= 0.5
    hand_cost = sum(card["cost"] for card in player["hand"])
    if len(player["hand"]) <= 1:
        value += (character.get("drawBonus") or 0) * 1.2
        if character["id"] == "scholar":
            value += 2
    if player["gold"] >= 5 and hand_cost >= 5:
        value += (character.get("buildLimit", 1) - 1) * 1.2
    leader = _leader_index(state)
    behind = len(state["players"][leader]["city"]) - len(player["city"])
    char_id = character["id"]
    if char_id == "architect": value += 1.2
    elif char_id == "merchant": value += 0.6
    elif char_id == "bishop": value += 0.8 + _color_count(player, "blue") * 0.2
    elif char_id == "warlord":
        value += _color_count(player, "red") * 0.3
        if behind >= 2: value += 2.0
        if player["gold"] >= 4: value += 0.8
    elif char_id == "diplomat":
        if behind >= 2: value += 1.2
        value += _color_count(player, "red") * 0.3
    elif char_id == "marshal":
        if behind >= 2: value += 1.4
        value += _color_count(player, "red") * 0.3
    elif char_id == "thief":
        value += min(3, max((other["gold"] for i, other in enumerate(state["players"])
                             if i != index), default=0) * 0.45)
    elif char_id == "assassin": value += 1.0
    elif char_id == "magician": value += 1.6 if len(player["hand"]) <= 1 else 0.2
    elif char_id == "king": value += 0.7 + (0 if player.get("hasCrown") else 0.5)
    elif char_id == "noble": value += _color_count(player, "yellow") * 0.9
    elif char_id == "navigator": value += 1.0
    elif char_id == "scholar": value += 1.2
    elif char_id == "alchemist": value += 1.5 if player["gold"] >= 6 else 0.1
    elif char_id == "businessman":
        value += _color_count(player, "green") * 0.3
        value += sum(card["color"] == "green" for card in player["hand"]) * 0.9
    elif char_id == "monk": value += _color_count(player, "blue") * 0.8
    elif char_id == "artist": value += 1.4 if player["gold"] >= 4 else 0
    elif char_id == "queen": value += 0.5
    elif char_id == "witch": value += 0.9
    elif char_id == "emperor": value += 0.4
    elif char_id == "prophet": value += 0.9
    if len(player["city"]) >= state["config"]["endDistricts"] - 2:
        value += (character.get("buildLimit", 1) - 1) * 1.4
    return value


def _choices(state: dict, player_id: str, action_type: str) -> list[dict]:
    from .game import get_available_actions
    return [action for action in (get_available_actions(state, player_id).get("actions") or [])
            if action.get("type") == action_type and not action.get("disabled")]


def _role_for_num(state: dict, number: int) -> dict | None:
    active_ids = state.get("charDeck") or []
    for character_id in active_ids:
        character = cards.CHAR_MAP.get(character_id)
        if character and character["num"] == number:
            return character
    return next((character for character in cards.CHARACTERS if character["num"] == number), None)


def _role_likelihood(state: dict, player: dict, role: dict | None) -> float:
    if not role:
        return 1.0
    if any((f"【{role['name']}】{player['name']}" in entry.get("text", "") or
            f"{player['name']}（{role['name']}）" in entry.get("text", ""))
           for entry in state.get("log", [])):
        return 100.0
    score = 1.0
    if role.get("income"):
        score += _color_count(player, role["income"]) * 0.7
    role_id = role["id"]
    if role_id == "architect":
        score += max(0, len(player["hand"]) - 2) * 0.35 + player["gold"] * 0.12
    if role_id == "merchant":
        score += _color_count(player, "green") * 0.25 + player["gold"] * 0.08
    if role_id in ("warlord", "marshal"):
        leader = _leader_index(state)
        score += max(0, len(state["players"][leader]["city"]) - len(player["city"])) * 0.45
    if role_id == "thief" and player["gold"] < 2:
        score += 0.25
    if role_id in ("magician", "wizard", "spy"):
        score += len(player["hand"]) * 0.12
    if role_id in ("king", "emperor") and player.get("hasCrown"):
        score += 0.35
    if (len(player["city"]) >= state["config"]["endDistricts"] - 2 and
            role.get("buildLimit", 1) > 1):
        score += 0.7
    return max(0.05, score)


def _target_utility(state: dict, player: dict, role: dict | None) -> float:
    target = state["config"]["endDistricts"]
    value = len(player["hand"]) * 0.9 + player["gold"] * 0.25 + len(player["city"]) * 0.7
    if len(player["city"]) >= target - 1:
        value += 3.5
    if len(player["city"]) >= target - 2:
        value += 1.5
    if role and role.get("income"):
        value += _color_count(player, role["income"]) * 0.45
    return value


def _best_public_target(state: dict, player_id: str, role: dict | None) -> dict | None:
    own_index = next((i for i, player in enumerate(state["players"]) if player["id"] == player_id), -1)
    options = [( _target_utility(state, player, role), player)
               for i, player in enumerate(state["players"]) if i != own_index]
    return max(options, key=lambda item: item[0])[1] if options else None


def _top_city_color(player: dict, fallback: str | None = None) -> str | None:
    counts: dict[str, int] = {}
    for district in player["city"]:
        counts[district["color"]] = counts.get(district["color"], 0) + 1
    return max(counts, key=counts.get) if counts else fallback


def _softmax_target(state: dict, player_id: str, level: int,
                    rng: random.Random, thief: bool = False) -> int | None:
    choices = _choices(state, player_id, "choose_char")
    if not choices:
        return None
    own_index = next(i for i, player in enumerate(state["players"]) if player["id"] == player_id)
    player = state["players"][own_index]
    assassin_base = {2: 2.35, 3: 2.25, 4: 2.55, 5: 2.20, 6: 2.50, 7: 2.70, 8: 2.55, 9: 2.15}
    thief_base = {2: 1.4, 3: 1.1, 4: 1.8, 5: 1.2, 6: 2.0, 7: 1.7, 8: 1.3, 9: 1.0}
    temperature = ({2: 0.65, 1: 1.0, 0: 1.45} if thief else {2: 0.72, 1: 1.05, 0: 1.55})[level]
    scored = []
    for action in choices:
        number = action["num"]
        role = _role_for_num(state, number)
        if thief:
            score = thief_base.get(number, 1.0) * 0.35
            best_gold = 0.0
            for i, opponent in enumerate(state["players"]):
                if i == own_index or opponent["gold"] < 2:
                    continue
                income = _color_count(opponent, role.get("income")) if role else 0
                flexible = sum((district.get("purple") or {}).get("effect") == "anyColorIncome"
                               for district in opponent["city"])
                best_gold = max(best_gold, (opponent["gold"] * 0.35 + (income + flexible) * 0.6) *
                                (_role_likelihood(state, opponent, role) * 0.45))
            score += best_gold
            score += sum(_role_likelihood(state, opponent, role)
                         for i, opponent in enumerate(state["players"])
                         if i != own_index) * 0.55
        else:
            score = assassin_base.get(number, 2.15) * 0.35
            likelihood = sum(_role_likelihood(state, opponent, role)
                             for i, opponent in enumerate(state["players"]) if i != own_index)
            score += likelihood * (0.7 if role and role.get("buildLimit", 1) > 1 else 0.35)
            if role:
                score += sum(_role_likelihood(state, opponent, role) *
                             _target_utility(state, opponent, role) * 0.08
                             for i, opponent in enumerate(state["players"]) if i != own_index)
            if (len(player["city"]) >= state["config"]["endDistricts"] - 2 and number in (7, 8)):
                score += 0.18
        scored.append((number, score))
    maximum = max(score for _, score in scored)
    weights = [math.exp((score - maximum) / temperature) for _, score in scored]
    pick = rng.random() * sum(weights)
    for (number, _), weight in zip(scored, weights):
        pick -= weight
        if pick <= 0:
            return number
    return scored[-1][0]


def _pending_decision(state: dict, index: int, rng: random.Random) -> dict:
    turn = state["turn"]
    pending = turn["pending"]
    player = state["players"][index]
    player_id = player["id"]
    kind = pending["kind"]
    if kind == "magistrate_declare":
        choices = _choices(state, player_id, "magistrate_signed")
        return {"type": "magistrate_signed", "num": choices[0].get("num", 1) if choices else 1}
    if kind in ("magistrate_second", "magistrate_third"):
        choices = _choices(state, player_id, "magistrate_char")
        return {"type": "magistrate_char", "num": choices[0].get("num", 1) if choices else 1}
    if kind in ("blackmailer_declare", "blackmailer_second"):
        exclude = {pending["first"]} if kind == "blackmailer_second" else set()
        choices = _blackmailer_valid(state, turn, exclude)
        return {"type": "blackmailer_char", "num": choices[0]} if choices else {"type": "ability_skip"}
    if kind == "blackmailer_signed":
        choices = [choice.get("num") for choice in _choices(state, player_id, "blackmailer_signed")]
        return {"type": "blackmailer_signed", "num": rng.choice(choices) if choices else 1}
    if kind == "blackmailer_threat":
        return {"type": "blackmailer_bribe" if player["gold"] >= 4 else "blackmailer_refuse"}
    if kind in ("spy_target", "wizard_target"):
        role = cards.CHAR_MAP["spy" if kind == "spy_target" else "wizard"]
        target = _best_public_target(state, player_id, role)
        return {"type": kind, "target": target["id"] if target else None}
    if kind == "spy_color":
        target = state["players"][pending["targetIdx"]]
        color = _top_city_color(target)
        choices = [choice.get("color") for choice in _choices(state, player_id, "spy_color")]
        return {"type": "spy_color", "color": color if color in choices else (choices[0] if choices else "blue")}
    if kind == "wizard_card":
        card = max(pending.get("cards") or [], key=lambda item: item["cost"], default=None)
        return {"type": "wizard_card", "uid": card.get("uid") if card else None}
    if kind == "wizard_choice":
        card = pending.get("card") or {}
        return {"type": "wizard_build" if player["gold"] >= card.get("cost", 0) else "wizard_take"}
    if kind == "assassin":
        level = {"easy": 0, "normal": 1, "hard": 2}.get(player.get("botLevel"), 1)
        number = _softmax_target(state, player_id, level, rng)
        return {"type": "choose_char", "num": number} if number is not None else {"type": "ability_skip"}
    if kind == "thief":
        level = {"easy": 0, "normal": 1, "hard": 2}.get(player.get("botLevel"), 1)
        number = _softmax_target(state, player_id, level, rng, thief=True)
        return {"type": "choose_char", "num": number} if number is not None else {"type": "ability_skip"}
    if kind == "witch_target":
        level = {"easy": 0, "normal": 1, "hard": 2}.get(player.get("botLevel"), 1)
        number = _softmax_target(state, player_id, level, rng)
        return {"type": "choose_char", "num": number} if number is not None else {"type": "ability_skip"}
    if kind == "magician_choice":
        maximum = max((len(other["hand"]) for i, other in enumerate(state["players"]) if i != index), default=-1)
        mode = "swap" if (len(player["hand"]) <= 1 and maximum >= 2 or
                           len(player["hand"]) >= 3 and maximum >= 4) else "redraw"
        return {"type": "magician_mode", "mode": mode}
    if kind == "magician_swap":
        target = _best_public_target(state, player_id, cards.CHAR_MAP["magician"])
        if not target:
            target = state["players"][(index + 1) % len(state["players"])]
        return {"type": "choose_player", "target": target["id"]}
    if kind == "magician_redraw":
        discard = [card["uid"] for card in player["hand"]
                   if (sum(district["name"] == card["name"] for district in player["city"]) >=
                       1 + sum((district.get("purple") or {}).get("effect") == "quarry"
                               for district in player["city"]) and card["color"] != "purple")
                   or card["cost"] > player["gold"] + 4]
        return {"type": "choose_cards", "uids": discard}
    if kind in ("warlord_destroy", "marshal_seize"):
        actions = _choices(state, player_id, "choose_district")
        allowed = {action.get("uid") for action in actions}
        leader = _leader_index(state)
        candidates = []
        for target_index, target in enumerate(state["players"]):
            for district in target["city"]:
                if district["uid"] not in allowed:
                    continue
                if kind == "warlord_destroy":
                    destroy_cost = max(0, district["cost"] - 1 + int(bool(district.get("beautified"))) +
                                       int(any(other["uid"] != district["uid"] and
                                               (other.get("purple") or {}).get("effect") == "wallCost"
                                               for other in target["city"])))
                    score = district["cost"] * 1.2 - destroy_cost * 0.4
                    score += 2.0 if target_index == leader else 0
                    score -= 6 if target_index == index else 0
                else:
                    if target_index == index or sum(item["name"] == district["name"]
                                                    for item in player["city"]) >= 1 + sum(
                            (item.get("purple") or {}).get("effect") == "quarry" for item in player["city"]):
                        continue
                    score = district["cost"] * 1.2 + (1.5 if target_index == leader else 0)
                candidates.append((score, target["id"], district["uid"]))
        if candidates:
            _, target_id, uid = max(candidates)
            return {"type": "choose_district", "target": target_id, "uid": uid}
        return {"type": "ability_skip"}
    if kind == "diplomat_mine":
        city = [district for district in player["city"]
                if (district.get("purple") or {}).get("effect") not in ("immune", "scoreAs")]
        if not city:
            return {"type": "ability_skip"}
        district = min(city, key=lambda item: item["cost"] + (4 if item["color"] == "purple" else 0))
        return {"type": "choose_district", "target": player_id, "uid": district["uid"]}
    if kind == "diplomat_theirs":
        mine = next((item for item in player["city"] if item["uid"] == pending.get("mineUid")), None)
        if not mine:
            return {"type": "ability_skip"}
        allowed = {action.get("uid") for action in _choices(state, player_id, "choose_district")}
        candidates = []
        for target_index, target in enumerate(state["players"]):
            if target_index == index:
                continue
            for district in target["city"]:
                if district["uid"] not in allowed or sum(item["name"] == district["name"]
                                                         for item in player["city"]) >= 1 + sum(
                        (item.get("purple") or {}).get("effect") == "quarry" for item in player["city"]):
                    continue
                diff = max(0, district["cost"] - mine["cost"])
                score = district["cost"] - mine["cost"] - diff * 0.5 + (1 if target_index == _leader_index(state) else 0)
                candidates.append((score, target["id"], district["uid"]))
        if not candidates or max(candidates)[0] <= 0.2:
            return {"type": "ability_skip"}
        _, target_id, uid = max(candidates)
        return {"type": "choose_district", "target": target_id, "uid": uid}
    if kind == "artist":
        selected = list(pending.get("selected") or [])
        if len(selected) >= 2 or player["gold"] <= 1 or len(selected) >= len(player["city"]):
            return {"type": "artist_done", "uids": selected}
        candidates = [district for district in player["city"]
                      if not district.get("beautified") and district["uid"] not in selected]
        if not candidates:
            return {"type": "artist_done", "uids": selected}
        district = max(candidates, key=lambda item: item["cost"])
        return {"type": "choose_district", "target": player_id, "uid": district["uid"]}
    if kind == "navigator_bonus":
        need_gold = any(card["cost"] > player["gold"] + 4 for card in player["hand"])
        return {"type": "navigator_bonus", "mode": "gold" if player["gold"] < 6 or need_gold else "cards"}
    if kind == "tax_collect":
        return {"type": "tax_collect"}
    if kind in ("scholar_pick", "draw_keep"):
        options = pending.get("cards") or []
        if not options:
            return {"type": "ability_skip"}
        best = max(options, key=lambda card: _card_value(card, player, state))
        return {"type": kind, "uid": best["uid"]}
    if kind == "bishop_repay":
        need = max(0, pending.get("amount") or 0)
        pool = [card for card in player["hand"] if card["uid"] != pending.get("uid")]
        pool.sort(key=lambda card: _card_value(card, player, state))
        return {"type": "choose_cards", "uids": [card["uid"] for card in pool[:need]]}
    if kind == "bishop_payer":
        payers = [candidate for i, candidate in enumerate(state["players"])
                  if i != index and candidate["gold"] >= (pending.get("amount") or 0)]
        if not payers:
            return {"type": "ability_skip"}
        return {"type": "choose_player", "target": max(payers, key=lambda candidate: candidate["gold"])["id"]}
    if kind == "monk_declare":
        religious = _color_count(player, "blue") + sum(
            (district.get("purple") or {}).get("effect") == "anyColorIncome" for district in player["city"])
        cards_count = min(religious, 2) if player["gold"] >= 6 or len(player["hand"]) <= 1 else 0
        return {"type": "monk_resource", "gold": religious - cards_count, "cards": cards_count}
    if kind == "emperor_crown":
        targets = [(len(other["city"]) * 2 + other["gold"] * 0.3, i, other)
                   for i, other in enumerate(state["players"]) if i != index]
        target = min(targets, default=(0, (index + 1) % len(state["players"]),
                                       state["players"][(index + 1) % len(state["players"]) ]))[2]
        return {"type": "emperor_crown", "target": target["id"]}
    if kind == "emperor_take":
        target = state["players"][pending["targetIdx"]]
        return {"type": "emperor_take", "mode": "gold" if target["gold"] >= 2 else "card"}
    if kind == "prophet_give":
        if not player["hand"]:
            return {"type": "ability_skip"}
        worst = min(player["hand"], key=lambda card: _card_value(card, player, state))
        return {"type": "prophet_give", "uid": worst["uid"]}
    return {"type": "ability_skip"}


def _should_use_ability(state: dict, index: int, turn: dict, character: dict) -> bool:
    player = state["players"][index]
    role = character["id"]
    if role in {"assassin", "thief", "witch", "magician", "magistrate", "spy",
                "blackmailer", "wizard", "tax_collector", "emperor", "scholar", "prophet"}:
        return True
    leader = _leader_index(state)
    if role == "warlord":
        return (player["gold"] >= 1 and leader != index and
                len(state["players"][leader]["city"]) < state["config"]["endDistricts"] and
                len(player["city"]) <= len(state["players"][leader]["city"]))
    if role == "marshal":
        return player["gold"] >= 2 and leader != index and len(state["players"][leader]["city"]) > len(player["city"])
    if role == "diplomat":
        mine = any((district.get("purple") or {}).get("effect") != "immune" for district in player["city"])
        return player["gold"] >= 1 and mine and leader != index
    if role == "artist":
        return player["gold"] >= 3 and len(player["city"]) >= 2
    if role == "navigator":
        return not turn.get("bonusDone")
    return False


def _choose_resource(state: dict, player: dict, character: dict) -> str:
    gold = player["gold"]
    hand = player["hand"]
    city = player["city"]
    if character["id"] == "navigator":
        return "take_gold" if gold < 6 else "take_cards"
    current_plan = _build_plan_score(state, player, gold)
    gold_plan = _build_plan_score(state, player, gold + 2 + (character.get("goldBonus") or 0))
    baseline = _strategic_position(state, player["id"])
    gold_projection = _resource_projection(state, player["id"], "take_gold", baseline)
    card_projection = _resource_projection(state, player["id"], "take_cards", baseline)
    gold_score = (max(0, gold_plan - current_plan) +
                  max(0, gold_projection - baseline) * 0.65 + (1.2 if gold < 2 else 0))
    best_cost = min((card["cost"] for card in hand
                     if _can_build_card(player, card, gold + 1 + (character.get("goldBonus") or 0))),
                    default=math.inf)
    hand_poor = len(hand) <= 1
    gold_hungry = gold < 3
    if len(city) >= state["config"]["endDistricts"] - 1 and best_cost < math.inf:
        return "take_gold"
    if hand_poor and gold < 2:
        return "take_cards"
    card_score = ((2.6 if hand_poor else 0) + (1.0 if len(hand) <= 2 else 0) +
                  (1.8 if current_plan <= 0 else 0) - (0.5 if gold >= 6 else 0) +
                  max(0, card_projection - baseline) * 0.65)
    if len(city) >= state["config"]["endDistricts"] - 2 and gold_score > 0:
        return "take_gold"
    if gold_score > card_score or (gold_hungry and best_cost < math.inf):
        return "take_gold"
    return "take_cards"


def _purple_action(state: dict, player: dict, actions: list[dict], turn: dict) -> dict | None:
    for action in actions:
        if action["type"] == "smithy":
            return action
    hand = player["hand"]
    city = player["city"]
    for action in actions:
        if action["type"] == "lab" and hand:
            def lab_cost(card: dict) -> float:
                if sum(district["name"] == card["name"] for district in city) >= 1 + sum(
                        (district.get("purple") or {}).get("effect") == "quarry" for district in city):
                    return -5
                return card["cost"]
            discarded = min(hand, key=lab_cost)
            return {**action, "discardUid": discarded["uid"]}
        if action["type"] == "museum" and hand:
            def museum_cost(card: dict) -> float:
                score = card["cost"] + (3 if card["color"] == "purple" else 0)
                if sum(district["name"] == card["name"] for district in city) >= 1 + sum(
                        (district.get("purple") or {}).get("effect") == "quarry" for district in city):
                    score += 2
                return score
            kept = min(hand, key=museum_cost)
            return {**action, "cardUid": kept["uid"]}
    return None


def _score_action(state: dict, player: dict, action: dict) -> float:
    kind = action.get("type")
    if kind == "build":
        card = next((item for item in player["hand"] if item["uid"] == action.get("uid")), None)
        return 100 + (_card_value(card, player, state) if card else 0)
    if kind == "take_gold":
        return 70 if player["gold"] < 3 else 38
    if kind == "take_cards":
        return 68 if len(player["hand"]) < 2 else 35
    if kind == "income":
        return 65
    if kind == "draw_keep":
        card = next((item for item in state["turn"].get("pending", {}).get("cards", [])
                     if item["uid"] == action.get("uid")), None)
        return _card_value(card, player, state) if card else 0
    if kind in ("draft_pick", "draft_discard"):
        index = next((i for i, candidate in enumerate(state["players"])
                      if candidate["id"] == player["id"]), 0)
        value = _character_value(state, index, action.get("charId"))
        return value if kind == "draft_pick" else -value
    if kind == "reaction":
        return 75 if action.get("use") else 5
    if kind in ("ability_skip", "end_turn"):
        return -20
    # Among legal choices, stable first-action selection keeps the driver total
    # over all multi-step abilities while specialized cases are added gradually.
    return 10


def _draft_decision(state: dict, player: dict, actions: list[dict],
                    rng: random.Random) -> dict | None:
    if not actions:
        return None
    index = next((i for i, candidate in enumerate(state["players"])
                  if candidate["id"] == player["id"]), 0)
    discard = all(action.get("type") == "draft_discard" for action in actions)
    if discard:
        return min(enumerate(actions), key=lambda pair:
                   (_character_value(state, index, pair[1].get("charId")), pair[0]))[1]
    level = {"easy": 0, "normal": 1, "hard": 2}.get(player.get("botLevel"), 1)
    noise = (4.0, 1.2, 0.25)[level]
    return max(enumerate(actions), key=lambda pair:
               (_character_value(state, index, pair[1].get("charId")) +
                (rng.random() - 0.5) * noise, -pair[0]))[1]


def decide(state: dict, player_id: str, available: dict | None = None,
           rng: random.Random | None = None) -> dict | None:
    player = next((item for item in state["players"] if item["id"] == player_id), None)
    if not player:
        return None
    rng = rng or random.Random()
    available = available or get_available_actions(state, player_id)
    options = available.get("actions") or []
    usable = [action for action in options if not action.get("disabled")]
    if not usable:
        return None
    index = next(i for i, candidate in enumerate(state["players"]) if candidate["id"] == player_id)
    if state["phase"] == "gameover":
        return None
    if state.get("roundConfirm"):
        if state["roundConfirm"]["confirmed"][index]:
            return None
        return next((action for action in usable if action["type"] == "confirm_round"), None)
    if state.get("reaction"):
        reaction = state["reaction"]
        if reaction["playerIdx"] != index:
            return None
        if reaction["kind"] in ("magistrate", "blackmailer"):
            return next((action for action in usable if action["type"] == "reaction" and action.get("use")), None)
        card = state.get("pendingDestroy", {}).get("card") or reaction.get("card") or {}
        use = card.get("cost", 0) >= 3 and player["gold"] >= 2
        return next((action for action in usable if action["type"] == "reaction" and
                     bool(action.get("use")) == use), usable[0])
    if state["phase"] == "draft":
        return _draft_decision(state, player, usable, rng)
    turn = state.get("turn")
    if not turn or turn["playerIdx"] != index:
        return None
    if turn.get("pending"):
        return _pending_decision(state, index, rng)
    if turn.get("phase") == "bewitched":
        return next((action for action in usable if action["type"] == "take_gold"), usable[0])
    character = cards.CHAR_MAP[turn["charId"]]
    if not turn.get("takenResources"):
        wanted = _choose_resource(state, player, character)
        return next((action for action in usable if action["type"] == wanted), usable[0])
    if not turn.get("abilityUsed") and _should_use_ability(state, index, turn, character):
        ability = next((action for action in usable if action["type"] == "ability"), None)
        if ability:
            return ability
    if not turn.get("incomeTaken") and character.get("income") and (
            _color_count(player, character["income"]) > 0 or any(
                (district.get("purple") or {}).get("effect") == "anyColorIncome" for district in player["city"])):
        income = next((action for action in usable if action["type"] == "income"), None)
        if income:
            return income
    if character["id"] == "monk" and turn.get("incomeTaken") and not turn.get("monkExtraTaken"):
        richest = max((other["gold"] for i, other in enumerate(state["players"]) if i != index), default=player["gold"])
        take = next((action for action in usable if action["type"] == "monk_take"), None)
        if take and richest > player["gold"]:
            return take
    builds = [action for action in usable if action["type"] == "build"]
    if builds and turn.get("builds", 0) < character.get("buildLimit", 1):
        return max(enumerate(builds), key=lambda pair:
                   (_build_action_score(state, player,
                    next(card for card in player["hand"] if card["uid"] == pair[1].get("uid"))),
                    -pair[0]))[1]
    purple = _purple_action(state, player, usable, turn)
    if purple:
        return purple
    expanded: list[dict] = []
    pending = (state.get("turn") or {}).get("pending") or {}
    for action in usable:
        kind = action.get("type")
        if kind == "lab":
            cards_to_discard = sorted(player["hand"], key=lambda card: _card_value(card, player))
            expanded.extend({**action, "discardUid": card["uid"]} for card in cards_to_discard[:1])
        elif kind == "museum":
            cards_to_store = sorted(player["hand"], key=lambda card: _card_value(card, player))
            expanded.extend({**action, "cardUid": card["uid"]} for card in cards_to_store[:1])
        elif kind == "choose_cards" and pending.get("kind") == "bishop_repay":
            amount = pending.get("amount", 0)
            pool = [card for card in player["hand"] if card["uid"] != pending.get("uid")]
            pool.sort(key=lambda card: _card_value(card, player))
            if len(pool) >= amount:
                expanded.append({**action, "uids": [card["uid"] for card in pool[:amount]]})
        elif kind == "choose_cards" and pending.get("kind") == "magician_redraw":
            worst = sorted(player["hand"], key=lambda card: _card_value(card, player))[:2]
            expanded.append({**action, "uids": [card["uid"] for card in worst
                                                   if _card_value(card, player) < 3]})
        else:
            expanded.append(action)
    if not expanded:
        return None
    return max(enumerate(expanded), key=lambda pair: (_score_action(state, player, pair[1]),
                                                       -pair[0]))[1]
