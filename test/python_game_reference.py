"""Test-only Python rules reference; production code must use the C++ engine.

The draft and a growing subset of action rules are implemented here. Remaining
unsupported branches fail explicitly rather than silently delegating to JS or
corrupting a room's authoritative state.
"""

from __future__ import annotations

import random
import time

from test import cards_reference as cards
from test.python_scoring_reference import compute_scores

MASK = 0xFFFFFFFF


def _imul(left: int, right: int) -> int:
    return (left * right) & MASK


def next_rand(state: dict) -> float:
    """Match the JS Mulberry32 stream, including every 32-bit overflow."""
    state["rngState"] = (state["rngState"] + 0x6D2B79F5) & MASK
    value = state["rngState"]
    value = _imul(value ^ (value >> 15), value | 1)
    value ^= (value + _imul(value ^ (value >> 7), value | 61)) & MASK
    return ((value ^ (value >> 14)) & MASK) / 4294967296


def _rand_int(state: dict, size: int) -> int:
    return int(next_rand(state) * size)


def _log(state: dict, text: str, kind: str = "info") -> None:
    log = state["log"]
    log.append({"i": len(log), "text": text, "type": kind, "round": state["round"]})
    if len(log) > 400:
        del log[0]


def _notify(state: dict, kind: str, data: dict | None = None) -> None:
    state["noticeSeq"] += 1
    state["notices"].append({"seq": state["noticeSeq"], "kind": kind,
                             "round": state["round"], **(data or {})})
    if len(state["notices"]) > 24:
        del state["notices"][0]


def _notify_hand_gain(state: dict, player_index: int, amount: int,
                      from_index: int | None, why: str) -> None:
    if amount <= 0:
        return
    player = state["players"][player_index]
    source = state["players"][from_index] if from_index is not None else None
    _notify(state, "hand_gain", {"playerIdx": player_index, "playerId": player["id"],
                                 "playerName": player["name"], "amount": amount,
                                 "fromIdx": from_index, "fromName": source["name"] if source else None,
                                 "why": why})


def _notify_gold_gain(state: dict, player_index: int, amount: int,
                      from_index: int | None, why: str) -> None:
    if amount <= 0:
        return
    player = state["players"][player_index]
    source = state["players"][from_index] if from_index is not None else None
    _notify(state, "got_gold", {"playerIdx": player_index, "playerId": player["id"],
                                "playerName": player["name"], "amount": amount,
                                "fromIdx": from_index, "fromName": source["name"] if source else None,
                                "why": why})


def create_game(config: dict | None = None) -> dict:
    config = config or {}
    seats = config.get("seats") or []
    player_count = len(seats)
    initial_crown = config.get("initialCrownSeat")
    try:
        initial_crown = int(initial_crown) if initial_crown is not None else 0
    except (TypeError, ValueError):
        initial_crown = 0
    if initial_crown < 0 or initial_crown >= player_count:
        initial_crown = 0
    state = {
        "roomId": config.get("roomId") or "local",
        "phase": "lobby",
        "rngState": (int(config["seed"]) if config.get("seed") is not None
                     else random.randrange(1_000_000_000)) & MASK,
        "config": {"playerCount": player_count, "endDistricts": config.get("endDistricts") or 8,
                   "charSetMode": config.get("charSetMode") or "base", "startingHand": 4,
                   "startingGold": 2, "initialCrownSeat": initial_crown},
        "players": [], "deck": [], "discard": [], "round": 0, "charDeck": [],
        "draft": None, "callQueue": [], "callIdx": 0, "turn": None,
        "witchResume": None, "reaction": None,
        "effects": {"assassinated": None, "thief": None, "bewitched": None,
                    "witchBy": None, "thiefBy": None, "magistrate": None,
                    "blackmailer": None, "taxCollectorGold": 0},
        "firstToFinish": -1, "pendingQueen": None, "observations": [],
        "log": [], "notices": [], "noticeSeq": 0, "scores": None,
        "winner": None, "createdAt": int(time.time() * 1000),
    }
    for index, seat in enumerate(seats):
        state["players"].append({
            "id": seat["id"], "name": seat["name"], "isBot": bool(seat.get("isBot")),
            "botLevel": seat.get("botLevel") or "normal", "botType": seat.get("botType") or "npc",
            "mcts": seat.get("mcts"), "seat": index, "gold": 0,
            "hand": [], "city": [], "chars": [], "played": [],
            "hasCrown": False, "connected": True,
        })
    state["charDeck"] = [character["id"] for character in
                         cards.pick_character_set(player_count, state["config"]["charSetMode"],
                                                  lambda: next_rand(state))]
    return state


def _draw_cards(state: dict, count: int) -> list[dict]:
    drawn = []
    for _ in range(count):
        if not state["deck"]:
            if not state["discard"]:
                break
            state["deck"] = cards.shuffle(state["discard"], lambda: next_rand(state))
            state["discard"] = []
            _log(state, "建筑牌堆已用完，弃牌堆重新洗回。", "sys")
        drawn.append(state["deck"].pop(0))
    return drawn


def start_game(state: dict) -> dict:
    if len(state["players"]) < 2:
        return {"ok": False, "error": "至少需要 2 位玩家"}
    state["deck"] = cards.build_district_deck(lambda: next_rand(state))
    for player in state["players"]:
        player["hand"] = _draw_cards(state, state["config"]["startingHand"])
        player["gold"] = state["config"]["startingGold"]
        player["city"] = []
        player["hasCrown"] = False
    crown = state["config"]["initialCrownSeat"]
    state["players"][crown]["hasCrown"] = True
    _log(state, "游戏开始！每位玩家获得 4 张建筑牌与 2 枚金币。皇冠由 " +
         state["players"][crown]["name"] + " 持有。", "sys")
    _log(state, "本局使用角色：" + "、".join(
        str(cards.CHAR_MAP[character_id]["num"]) + "." + cards.CHAR_MAP[character_id]["name"]
        for character_id in state["charDeck"]), "sys")
    start_round(state)
    return {"ok": True}


def start_round(state: dict) -> dict:
    state["round"] += 1
    state["effects"].update({"assassinated": None, "thief": None, "bewitched": None,
                             "witchBy": None, "thiefBy": None, "magistrate": None,
                             "blackmailer": None})
    state["witchResume"] = state["reaction"] = state["pendingQueen"] = state["roundConfirm"] = None
    for player in state["players"]:
        player["chars"] = []
        player["played"] = []
    pool = cards.shuffle(state["charDeck"], lambda: next_rand(state))
    player_count = len(state["players"])
    crown = next(index for index, player in enumerate(state["players"]) if player["hasCrown"])
    draft = {"pool": pool, "faceUp": [], "faceDown": [], "steps": [],
             "stepIdx": 0, "sub": "pick", "crown": crown}
    order = [(crown + index) % player_count for index in range(player_count)]
    if player_count == 2:
        draft["faceDown"].append(pool.pop(0))
        draft["steps"] = [{"player": order[0], "keep": 1, "discard": 0},
                          {"player": order[1], "keep": 1, "discard": 1},
                          {"player": order[0], "keep": 1, "discard": 1},
                          {"player": order[1], "keep": 1, "discard": 0}]
    elif player_count == 3:
        draft["faceDown"].append(pool.pop(0))
        draft["steps"] = [{"player": order[index % 3], "keep": 1, "discard": 0}
                          for index in range(6)]
    else:
        face_up_count = max(0, len(pool) - player_count - 2)
        for _ in range(face_up_count):
            selected = -1
            for _ in range(50):
                candidate = _rand_int(state, len(pool))
                if cards.CHAR_MAP[pool[candidate]]["num"] != 4:
                    selected = candidate
                    break
            if selected < 0:
                selected = _rand_int(state, len(pool))
            draft["faceUp"].append(pool.pop(selected))
        if pool:
            draft["faceDown"].append(pool.pop(_rand_int(state, len(pool))))
        draft["steps"] = [{"player": player, "keep": 1, "discard": 0} for player in order]
        if player_count >= 7:
            draft["steps"][-1]["fromFaceDown"] = True
    state["draft"] = draft
    state["phase"] = "draft"
    if draft["faceUp"]:
        _log(state, "第 " + str(state["round"]) + " 轮：明置移除 " + "、".join(
            cards.CHAR_MAP[character_id]["name"] for character_id in draft["faceUp"]) +
             "，另有 " + str(len(draft["faceDown"])) + " 张暗置移除。", "sys")
    else:
        _log(state, "第 " + str(state["round"]) + " 轮开始选角（" +
             str(len(draft["faceDown"])) + " 张暗置移除）。", "sys")
    return draft


def draft_options(state: dict, player_id: str) -> dict:
    draft = state["draft"]
    if not draft or state["phase"] != "draft":
        return {"actions": []}
    step = draft["steps"][draft["stepIdx"]] if draft["stepIdx"] < len(draft["steps"]) else None
    if not step:
        return {"actions": []}
    player_index = next((index for index, player in enumerate(state["players"])
                         if player["id"] == player_id), -1)
    if step["player"] != player_index:
        return {"actions": [], "prompt": "等待其他玩家选择角色…"}
    pool = draft["pool"] + draft["faceDown"] if step.get("fromFaceDown") and draft["sub"] == "pick" else draft["pool"]
    if draft["sub"] == "pick":
        return {"prompt": "选择一张角色牌作为你的角色", "actions": [
            {"type": "draft_pick", "charId": character_id,
             "label": str(cards.CHAR_MAP[character_id]["num"]) + " · " + cards.CHAR_MAP[character_id]["name"],
             "desc": cards.CHAR_MAP[character_id]["desc"]} for character_id in pool]}
    return {"prompt": "再选择一张角色牌暗置弃掉（国王/皇帝/贵族不可弃置）", "actions": [
        {"type": "draft_discard", "charId": character_id,
         "label": str(cards.CHAR_MAP[character_id]["num"]) + " · " + cards.CHAR_MAP[character_id]["name"]}
        for character_id in pool if cards.CHAR_MAP[character_id]["num"] != 4]}


ABILITY_LABELS = {
    "assassin": "【刺客】刺杀一个角色", "witch": "【女巫】对一个角色施咒",
    "thief": "【盗贼】偷窃一个角色", "magistrate": "【行政官】分配逮捕令",
    "spy": "【间谍】查看并调查手牌", "blackmailer": "【勒索者】分配威胁标记",
    "magician": "【魔术师】使用能力", "wizard": "【法师】查看并取得一张手牌",
    "warlord": "【领主】摧毁一栋建筑", "diplomat": "【外交官】交换建筑",
    "marshal": "【元帅】抢夺建筑（费用≤3）", "artist": "【艺术家】美化建筑",
    "emperor": "【皇帝】转移皇冠", "tax_collector": "【税务官】收取建筑税",
    "navigator": "【航海家】领取额外奖励", "scholar": "【学者】抽 7 张选 1 张",
    "prophet": "【预言家】抽取对手手牌",
}


def _build_limit(turn: dict) -> int:
    character = cards.CHAR_MAP[turn["charId"]]
    limit = character.get("buildLimit") or 0
    return max(1, limit) if turn["phase"] == "witch_resume" else limit


def _can_build(state: dict, player: dict, card: dict, turn: dict) -> bool:
    character = cards.CHAR_MAP[turn["charId"]]
    if card["cost"] > player["gold"]:
        return False
    if character["id"] == "navigator" and turn["phase"] != "witch_resume":
        return False
    green_free = (character["id"] == "businessman" and turn["phase"] != "witch_resume"
                  and card["color"] == "green")
    if not green_free and turn["builds"] >= _build_limit(turn):
        return False
    quarry_count = sum(1 for built in player["city"]
                       if (built.get("purple") or {}).get("effect") == "quarry")
    same_name = sum(1 for built in player["city"] if built["name"] == card["name"])
    return same_name < 1 + quarry_count


def _bishop_can_build_without_gold(player: dict, card: dict, turn: dict) -> bool:
    if turn["charId"] != "bishop" or turn["builds"] >= _build_limit(turn):
        return False
    quarry_count = sum(1 for built in player["city"]
                       if (built.get("purple") or {}).get("effect") == "quarry")
    return sum(1 for built in player["city"] if built["name"] == card["name"]) < 1 + quarry_count


def _income(state: dict, player: dict, turn: dict) -> dict | None:
    character = cards.CHAR_MAP[turn["charId"]]
    color = "blue" if character["id"] == "bishop" else character.get("income")
    if not color:
        return None
    count = sum(1 for built in player["city"] if built["color"] == color or
                (built.get("purple") or {}).get("effect") == "anyColorIncome")
    if character["id"] == "bishop":
        return {"n": count, "color": "blue", "kind": "cards",
                "text": f"{count} 张建筑牌（宗教建筑 ×{count}）"}
    return {"n": count, "color": color,
            "text": f"{count} 金（{cards.COLORS[color]['name']} ×{count}）"}


def _richest_other(state: dict, player_index: int) -> int:
    candidates = [(player["gold"], index) for index, player in enumerate(state["players"])
                  if index != player_index]
    if not candidates:
        return -1
    maximum = max(amount for amount, _ in candidates)
    return next(index for amount, index in candidates if amount == maximum)


def _abbot_protected(state: dict, index: int) -> bool:
    return ("abbot" in state["players"][index]["played"] and
            state["effects"]["assassinated"] != 5 and state["effects"]["bewitched"] != 5)


def _targetable(card: dict) -> bool:
    return (card.get("purple") or {}).get("effect") != "immune"


def _same_name_limit(player: dict) -> int:
    return 1 + sum((card.get("purple") or {}).get("effect") == "quarry" for card in player["city"])


def _destroy_cost(target: dict, card: dict) -> int:
    wall = any(other["uid"] != card["uid"] and
               (other.get("purple") or {}).get("effect") == "wallCost" for other in target["city"])
    return max(0, card["cost"] - 1 + (1 if card.get("beautified") else 0) + int(wall))


def _district_action(target: dict, card: dict, label: str) -> dict:
    return {"type": "choose_district", "target": target["id"], "uid": card["uid"],
            "label": label, "color": card["color"]}


def _military_choices(state: dict, turn: dict, seize: bool) -> list[dict]:
    index = turn["playerIdx"]
    player = state["players"][index]
    actions = []
    for target_index, target in enumerate(state["players"]):
        if seize and target_index == index or len(target["city"]) >= state["config"]["endDistricts"]:
            continue
        if target_index != index and _abbot_protected(state, target_index):
            continue
        for card in target["city"]:
            if not _targetable(card):
                continue
            if seize:
                if (card["cost"] > 3 or card["cost"] > player["gold"] or
                        sum(built["name"] == card["name"] for built in player["city"]) >=
                        _same_name_limit(player)):
                    continue
                label = f"{target['name']} 的『{card['name']}』— 支付 {card['cost']} 金"
            else:
                cost = _destroy_cost(target, card)
                if cost > player["gold"]:
                    continue
                label = f"{target['name']} 的『{card['name']}』— 花费 {cost} 金"
            actions.append(_district_action(target, card, label))
    if not actions:
        label = "没有可抢夺的目标，放弃使用能力" if seize else "没有可摧毁的目标，放弃使用能力"
        actions.append({"type": "ability_skip", "label": label})
    return actions


def _diplomat_targets(state: dict, turn: dict) -> list[dict]:
    player = state["players"][turn["playerIdx"]]
    mine = next(card for card in player["city"] if card["uid"] == turn["pending"]["mineUid"])
    actions = []
    for index, target in enumerate(state["players"]):
        if index == turn["playerIdx"] or _abbot_protected(state, index):
            continue
        for card in target["city"]:
            if not _targetable(card) or sum(built["name"] == card["name"] for built in player["city"]) >= _same_name_limit(player):
                continue
            difference = max(0, card["cost"] - mine["cost"])
            if difference > player["gold"]:
                continue
            suffix = f" — 补差价 {difference} 金" if difference else ""
            actions.append(_district_action(target, card, f"{target['name']} 的『{card['name']}』{suffix}"))
    if not actions:
        actions.append({"type": "ability_skip", "label": "没有可交换的目标，放弃使用能力"})
    return actions


def _turn_info(turn: dict) -> dict:
    character = cards.CHAR_MAP[turn["charId"]]
    return {"charId": turn["charId"], "name": character["name"],
            "num": turn["num"], "phase": turn["phase"], "builds": turn["builds"],
            "buildLimit": _build_limit(turn)}


def _char_choices(state: dict, turn: dict, excluded: set[int], action_type: str = "choose_char") -> list[dict]:
    face_up = {cards.CHAR_MAP[character_id]["num"] for character_id in state["draft"]["faceUp"]}
    choices = [{"type": action_type, "num": character["num"],
                "label": f"{character['num']} · {character['name']}"}
               for character_id in state["charDeck"]
               if (character := cards.CHAR_MAP[character_id])["num"] not in face_up
               and character["num"] != turn["num"] and character["num"] not in excluded]
    choices.sort(key=lambda choice: choice["num"])
    return choices or [{"type": "ability_skip", "label": "无可选目标，放弃使用能力"}]


def _blackmailer_blocked(state: dict) -> set[int]:
    blocked = {1}
    for value in (state["effects"].get("assassinated"), state["effects"].get("bewitched")):
        if isinstance(value, int):
            blocked.add(value)
    warrant = state["effects"].get("magistrate")
    if warrant:
        blocked.update(warrant.get("nums") or [])
    return blocked


def _blackmailer_valid(state: dict, turn: dict, excluded: set[int] | None = None) -> list[int]:
    return [choice["num"] for choice in _char_choices(
        state, turn, _blackmailer_blocked(state) | (excluded or set()), "blackmailer_char")
        if choice["type"] == "blackmailer_char"]


def _commit_blackmailer(state: dict, turn: dict, index: int, nums: list[int], signed: int) -> dict:
    player = state["players"][index]
    state["effects"]["blackmailer"] = {"nums": list(nums), "signed": signed,
                                          "playerIdx": index, "done": [], "revealed": []}
    turn["abilityUsed"] = True
    turn["pending"] = None
    targets = []
    for number in nums:
        char_id = next((char_id for char_id in state["charDeck"]
                        if cards.CHAR_MAP[char_id]["num"] == number), None)
        targets.append({"num": number, "charId": char_id or "",
                        "name": cards.CHAR_MAP[char_id]["name"] if char_id else "未知角色"})
    text = "、".join(f"{target['num']} 号·{target['name']}" for target in targets)
    suffix = "（其中只有一个是真的）。" if len(nums) > 1 else "。"
    _log(state, f"【勒索者】{player['name']} 把 {len(nums)} 个威胁标记发给了 {text}{suffix}", "magic")
    _notify(state, "blackmailer_declare", {"byIdx": index, "byId": player["id"],
                                            "byName": player["name"], "nums": list(nums),
                                            "targets": [{"num": target["num"], "name": target["name"]}
                                                        for target in targets]})
    return {"ok": True}


def get_available_actions(state: dict, player_id: str) -> dict:
    if state["phase"] == "gameover":
        return {"phase": "gameover", "actions": [], "prompt": "游戏结束"}
    if state["phase"] == "draft":
        return draft_options(state, player_id)
    if state["phase"] != "action":
        return {"phase": state["phase"], "actions": [], "prompt": ""}
    index = next((i for i, player in enumerate(state["players"]) if player["id"] == player_id), -1)
    if index < 0:
        return {"actions": [], "prompt": ""}
    if state.get("reaction"):
        reaction = state["reaction"]
        if reaction["playerIdx"] != index:
            if reaction["kind"] == "blackmailer" and reaction["targetIdx"] == index:
                return {"actions": [], "prompt": "请等待勒索者翻开威胁标记……"}
            return {"actions": [], "prompt": "等待其他玩家响应…"}
        if reaction["kind"] == "blackmailer":
            return {"prompt": reaction["prompt"], "actions": [
                {"type": "reaction", "use": True, "label": "是"},
                {"type": "reaction", "use": False, "label": "否"}]}
        if reaction["kind"] == "magistrate":
            name = reaction["card"]["name"]
            return {"prompt": reaction["prompt"], "actions": [
                {"type": "reaction", "use": True,
                 "label": f"发动逮捕令：没收『{name}』，免费建入自己城市"},
                {"type": "reaction", "use": False, "label": "不发动"}]}
        if reaction["kind"] == "graveyard":
            name = reaction["card"]["name"]
            return {"prompt": reaction["prompt"], "actions": [
                {"type": "reaction", "use": True,
                 "label": f"使用【墓地】：支付 1 金，将「{name}」收入手牌"},
                {"type": "reaction", "use": False, "label": "不使用"}]}
        raise NotImplementedError("Python 响应行动尚未迁移")
    confirmation = state.get("roundConfirm")
    if confirmation:
        done = sum(bool(value) for value in confirmation["confirmed"])
        if confirmation["confirmed"][index]:
            return {"actions": [], "prompt": f"已确认，等待其他玩家（{done}/{len(state['players'])}）…"}
        return {"prompt": f"第 {confirmation['round']} 轮结束（已确认 {done}/{len(state['players'])}）",
                "actions": [{"type": "confirm_round", "label": "确认本轮战果"}]}
    turn = state.get("turn")
    if not turn:
        return {"actions": [], "prompt": ""}
    if turn["playerIdx"] != index:
        return {"actions": [], "prompt": "等待 " + state["players"][turn["playerIdx"]]["name"] + " 行动…"}
    player = state["players"][index]
    pending = turn.get("pending")
    if pending:
        if pending["kind"] == "draw_keep":
            return {"prompt": pending.get("prompt") or "选择要保留的建筑牌",
                    "actions": [{"type": "draw_keep", "uid": card["uid"],
                                 "label": f"{card['name']}（{cards.COLORS[card['color']]['name']} {card['cost']} 金）",
                                 "color": card["color"]} for card in pending["cards"]]}
        if pending["kind"] in ("assassin", "thief"):
            return {"prompt": "【刺客】选择要刺杀的角色编号" if pending["kind"] == "assassin"
                    else "【盗贼】选择要偷窃的角色编号",
                    "actions": _char_choices(state, turn, {1})}
        if pending["kind"] == "bishop_payer":
            card = next((held for held in player["hand"] if held["uid"] == pending["uid"]), None)
            if not card:
                return {"prompt": "【主教】建筑牌已不存在", "actions": []}
            payers = [other for other in state["players"] if other["id"] != player_id
                      and other["gold"] >= pending["amount"]]
            return {"prompt": f"【主教】选择为『{card['name']}』代偿 {pending['amount']} 金的玩家",
                    "actions": [{"type": "choose_player", "target": other["id"],
                                 "label": f"{other['name']}（支付 {pending['amount']} 金）"}
                                for other in payers]}
        if pending["kind"] == "bishop_repay":
            payer = state["players"][pending["payerIdx"]]
            return {"prompt": f"【主教】选择 {pending['amount']} 张手牌，偿还 {payer['name']} 代付的 {pending['amount']} 金",
                    "actions": [{"type": "choose_cards", "uids": [], "label": "确认交出所选手牌"}],
                    "selectable": "hand", "multi": True, "max": pending["amount"]}
        if pending["kind"] == "magician_choice":
            return {"prompt": "【魔术师】选择一种能力", "actions": [
                {"type": "magician_mode", "mode": "swap", "label": "与一位玩家交换全部手牌"},
                {"type": "magician_mode", "mode": "redraw", "label": "弃掉任意张手牌并重抽"}]}
        if pending["kind"] == "magician_swap":
            others = [other for other in state["players"] if other["id"] != player_id]
            return {"prompt": "【魔术师】选择与谁交换手牌", "actions": [
                {"type": "choose_player", "target": other["id"],
                 "label": f"{other['name']}（{len(other['hand'])} 张手牌）"} for other in others] +
                [{"type": "pending_back", "to": "magician_choice", "label": "« 返回上一步",
                  "disabled": True}]}
        if pending["kind"] == "magician_redraw":
            return {"prompt": "【魔术师】选择要弃掉的手牌（可留空）", "actions": [
                {"type": "choose_cards", "uids": [], "label": "确定（可点选手牌后再确定）"},
                {"type": "pending_back", "to": "magician_choice", "label": "« 返回上一步",
                 "disabled": True}], "selectable": "hand", "multi": True}
        if pending["kind"] == "navigator_bonus":
            return {"prompt": "【航海家】选择额外奖励", "actions": [
                {"type": "navigator_bonus", "mode": "gold", "label": "额外获得 4 枚金币"},
                {"type": "navigator_bonus", "mode": "cards", "label": "额外抽取 4 张建筑牌"}]}
        if pending["kind"] == "scholar_pick":
            return {"prompt": "【学者】从 7 张中选择 1 张", "actions": [
                {"type": "scholar_pick", "uid": card["uid"],
                 "label": f"{card['name']}（{cards.COLORS[card['color']]['name']} {card['cost']} 金）",
                 "color": card["color"]} for card in pending["cards"]]}
        if pending["kind"] == "monk_declare":
            count = sum(1 for built in player["city"] if built["color"] == "blue" or
                        (built.get("purple") or {}).get("effect") == "anyColorIncome")
            return {"prompt": f"【修士】宣告要领取的资源组合（共 {count} 份）", "actions": [
                {"type": "monk_resource", "gold": gold, "cards": count - gold,
                 "label": f"{gold} 金 + {count - gold} 张建筑牌"}
                for gold in range(count + 1)]}
        if pending["kind"] == "spy_target":
            return {"prompt": "【间谍】选择要查看手牌的玩家", "actions": [
                {"type": "spy_target", "target": other["id"], "label": other["name"]}
                for other in state["players"] if other["id"] != player_id]}
        if pending["kind"] == "spy_color":
            return {"prompt": "【间谍】选择要调查的建筑类型", "actions": [
                {"type": "spy_color", "color": color, "label": name + "建筑"}
                for color, name in (("yellow", "皇家"), ("blue", "宗教"),
                                    ("green", "商业"), ("red", "军事"), ("purple", "独特"))]}
        if pending["kind"] == "wizard_target":
            actions = [
                {"type": "wizard_target", "target": other["id"],
                 "label": f"{other['name']}（{len(other['hand'])} 张手牌）"}
                for other in state["players"] if other["id"] != player_id and other["hand"]]
            return {"prompt": "【法师】选择要查看手牌的玩家", "actions": actions or [
                {"type": "ability_skip", "label": "没有可选项，放弃使用能力"}]}
        if pending["kind"] == "wizard_card":
            actions = [
                {"type": "wizard_card", "uid": card["uid"],
                 "label": f"{card['name']}（{card['cost']} 金）", "color": card["color"]}
                for card in pending["cards"]]
            return {"prompt": "【法师】选择一张牌", "actions": actions or [
                {"type": "ability_skip", "label": "没有可选项，放弃使用能力"}]}
        if pending["kind"] == "wizard_choice":
            actions = [{"type": "wizard_take", "label": "加入手牌"}]
            card = pending.get("card") or {}
            if card and player["gold"] >= int(card.get("cost", 0)):
                actions.append({"type": "wizard_build", "label": "立即建造（不占建造次数）"})
            actions.append({"type": "pending_back", "to": "wizard_card",
                            "label": "« 返回重新选择手牌"})
            return {"prompt": "【法师】将牌加入手牌或立即建造", "actions": actions}
        if pending["kind"] == "tax_collect":
            return {"prompt": "【税务官】收取税务标记上的金币", "actions": [
                {"type": "tax_collect", "label": f"收取 {state['effects'].get('taxCollectorGold') or 0} 枚金币"}]}
        if pending["kind"] == "emperor_crown":
            return {"prompt": "【皇帝】将皇冠交给谁？", "actions": [
                {"type": "emperor_crown", "target": other["id"], "label": other["name"]}
                for other in state["players"] if other["id"] != player_id]}
        if pending["kind"] == "emperor_take":
            target = state["players"][pending["targetIdx"]]
            return {"prompt": f"【皇帝】从 {target['name']} 处拿取", "actions": [
                {"type": "emperor_take", "mode": "gold", "label": "拿 1 枚金币"},
                {"type": "emperor_take", "mode": "card", "label": "随机拿 1 张手牌"},
                {"type": "pending_back", "to": "emperor_crown",
                 "label": "« 返回上一步（重新选皇冠对象）", "disabled": True}]}
        if pending["kind"] == "prophet_give":
            target = state["players"][pending["targetIdx"]]
            return {"prompt": f"【预言家】还给 {target['name']} 一张手牌", "actions": [
                {"type": "prophet_give", "uid": card["uid"],
                 "label": f"{card['name']}（{cards.COLORS[card['color']]['name']} {card['cost']} 金）",
                 "color": card["color"]} for card in player["hand"]]}
        if pending["kind"] == "artist":
            selected = pending.get("selected") or []
            full = len(selected) >= 2
            broke = player["gold"] <= len(selected)
            choices = [] if full or broke else [
                {"type": "choose_district", "target": player_id, "uid": card["uid"],
                 "label": f"『{card['name']}』（{card['cost']} 金）", "color": card["color"]}
                for card in player["city"] if not card.get("beautified") and card["uid"] not in selected]
            prompt = ("【艺术家】已选满 2 栋，确认或跳过" if full else
                      "【艺术家】金币不足，无法继续美化，确认或跳过" if broke else
                      "【艺术家】选择要美化的建筑（最多 2 栋，每栋 1 金）")
            label = f"确定美化（{len(selected)} 栋）" if selected else "不美化，跳过"
            return {"prompt": prompt, "actions": choices + [
                {"type": "artist_done", "uids": list(selected), "label": label}],
                "selectable": "city", "multi": True, "max": 2}
        if pending["kind"] == "warlord_destroy":
            return {"prompt": "【领主】选择要摧毁的建筑",
                    "actions": _military_choices(state, turn, False)}
        if pending["kind"] == "marshal_seize":
            return {"prompt": "【元帅】选择要抢夺的建筑（费用 ≤ 3）",
                    "actions": _military_choices(state, turn, True)}
        if pending["kind"] == "diplomat_mine":
            actions = [_district_action(player, card, f"『{card['name']}』（{card['cost']} 金）")
                       for card in player["city"] if _targetable(card)]
            if not actions:
                actions.append({"type": "ability_skip", "label": "没有可用于交换的建筑，放弃使用能力"})
            return {"prompt": "【外交官】选择你自己的一栋建筑用于交换", "actions": actions}
        if pending["kind"] == "diplomat_theirs":
            return {"prompt": "【外交官】选择要换取的建筑",
                    "actions": _diplomat_targets(state, turn) + [
                        {"type": "pending_back", "to": "diplomat_mine",
                         "label": "« 返回上一步", "disabled": True}]}
        if pending["kind"] == "witch_target":
            return {"prompt": "【女巫】选择要施咒的角色编号",
                    "actions": _char_choices(state, turn, {1})}
        if pending["kind"] == "magistrate_declare":
            return {"prompt": "【行政官】先选择真逮捕令的目标", "actions": [
                {"type": "magistrate_signed", "num": choice.get("num"), "label": choice["label"]}
                for choice in _char_choices(state, turn, set(), "magistrate_signed")]}
        if pending["kind"] in ("magistrate_second", "magistrate_third"):
            used = pending.get("used") or []
            return {"prompt": f"【行政官】选择第 {len(used)} 个假逮捕令的目标",
                    "actions": _char_choices(state, turn, set(used + [turn["num"]]), "magistrate_char")}
        if pending["kind"] == "blackmailer_declare":
            return {"prompt": "【勒索者】选择第 1 个威胁角色编号（1 号角色、被刺杀者、被施咒者、已有逮捕令者不可选）",
                    "actions": _char_choices(state, turn, _blackmailer_blocked(state), "blackmailer_char")}
        if pending["kind"] == "blackmailer_second":
            return {"prompt": "【勒索者】选择第 2 个威胁角色编号",
                    "actions": _char_choices(state, turn,
                                             _blackmailer_blocked(state) | {pending["first"]},
                                             "blackmailer_char")}
        if pending["kind"] == "blackmailer_signed":
            actions = []
            for number in pending["nums"]:
                char_id = next((char_id for char_id in state["charDeck"]
                                if cards.CHAR_MAP[char_id]["num"] == number), None)
                name = cards.CHAR_MAP[char_id]["name"] if char_id else "?"
                actions.append({"type": "blackmailer_signed", "num": number,
                                "label": f"{number} · {name}"})
            return {"prompt": "【勒索者】选择把真威胁标记放在哪个角色身上（另一个为假威胁标记）",
                    "actions": actions}
        if pending["kind"] == "blackmailer_threat":
            return {"prompt": "【勒索者】你受到威胁，可支付一半金币赎回", "actions": [
                {"type": "blackmailer_bribe", "label": f"支付 {player['gold'] // 2} 金赎回"},
                {"type": "blackmailer_refuse", "label": "拒绝支付"}]}
        raise NotImplementedError("Python 多步角色能力尚未迁移：" + pending["kind"])
    character = cards.CHAR_MAP[turn["charId"]]
    if turn["phase"] == "bewitched":
        actions = ([{"type": "take_gold", "label": "领取 2 枚金币"},
                    {"type": "take_cards", "label": "抽 2 张建筑牌，保留 1 张"}]
                   if not turn["takenResources"] else [])
        return {"prompt": "你被女巫施咒，只能领取资源。",
                "actions": actions, "turn": _turn_info(turn)}
    if not turn["takenResources"]:
        gold_bonus = character.get("goldBonus") or 0
        gold_label = "领取 2 枚金币" + (f"（+{gold_bonus}）" if gold_bonus else "")
        draw_label = "抽 2 张建筑牌，保留 1 张"
        if any((card.get("purple") or {}).get("effect") == "keepBoth" for card in player["city"]):
            draw_label = "抽 2 张建筑牌，全部保留（图书馆）"
        elif any((card.get("purple") or {}).get("effect") == "draw3keep1" for card in player["city"]):
            draw_label = "抽 3 张建筑牌，保留 1 张（天文台）"
        return {"prompt": f"『{character['name']}』— 先领取资源",
                "actions": [{"type": "take_gold", "label": gold_label},
                            {"type": "take_cards", "label": draw_label}],
                "turn": _turn_info(turn)}
    actions = []
    label = ABILITY_LABELS.get(character["id"])
    if not turn["abilityUsed"] and label:
        actions.append({"type": "ability", "label": label,
                        "disabled": character["id"] == "diplomat" and not player["city"]})
    if not turn["incomeTaken"] and (income := _income(state, player, turn)) is not None:
        actions.append({"type": "income", "label": f"领取角色收入（{income['text']}）"})
    if character["id"] == "monk" and turn["incomeTaken"] and not turn.get("monkExtraTaken"):
        richest = _richest_other(state, index)
        if richest >= 0 and state["players"][richest]["gold"] > player["gold"]:
            actions.append({"type": "monk_take",
                            "label": "从 " + state["players"][richest]["name"] + "（最富有）处拿 1 枚金币"})
    for card in player["hand"]:
        if _can_build(state, player, card, turn):
            actions.append({"type": "build", "uid": card["uid"],
                            "label": f"建造『{card['name']}』（{card['cost']} 金）",
                            "color": card["color"]})
        elif (character["id"] == "bishop" and card["cost"] > player["gold"]
              and _bishop_can_build_without_gold(player, card, turn)):
            shortfall = card["cost"] - player["gold"]
            if len(player["hand"]) - 1 >= shortfall and any(
                    payer["gold"] >= shortfall for payer in state["players"] if payer["id"] != player_id):
                actions.append({"type": "build", "uid": card["uid"],
                                "label": f"建造『{card['name']}』（先选择代偿玩家，再偿还 {shortfall} 张手牌）",
                                "color": card["color"]})
    for built in player["city"]:
        special = (built.get("purple") or {}).get("effect")
        if special == "lab" and not turn["usedLab"] and player["hand"]:
            actions.append({"type": "lab", "uid": built["uid"],
                            "label": "【实验室】弃 1 张手牌换 1 金"})
        if special == "smithy" and not turn["usedSmithy"] and player["gold"] >= 2:
            actions.append({"type": "smithy", "uid": built["uid"],
                            "label": "【铁匠铺】付 2 金抽 3 张建筑牌"})
        if special == "museum" and not turn["usedMuseum"] and player["hand"]:
            actions.append({"type": "museum", "uid": built["uid"],
                            "label": "【博物馆】将 1 张手牌放到博物馆下（计分+1）"})
    actions.append({"type": "end_turn", "label": "结束本回合"})
    prompt = (f"女巫接管『{character['name']}』的剩余行动" if turn["phase"] == "witch_resume"
              else f"『{character['name']}』— 你的回合")
    return {"prompt": prompt,
            "actions": actions, "turn": _turn_info(turn)}


def _advance_draft(state: dict) -> None:
    draft = state["draft"]
    step = draft["steps"][draft["stepIdx"]]
    if step["discard"] > 0 and draft["sub"] == "pick":
        draft["sub"] = "discard"
        return
    draft["stepIdx"] += 1
    draft["sub"] = "pick"
    if draft["stepIdx"] >= len(draft["steps"]):
        draft["faceDown"].extend(draft["pool"])
        draft["pool"] = []
        state["phase"] = "action"
        _build_call_queue(state)


def _build_call_queue(state: dict) -> None:
    state["callQueue"] = sorted(({"charId": character_id, "num": cards.CHAR_MAP[character_id]["num"],
                                  "playerIdx": index}
                                 for index, player in enumerate(state["players"])
                                 for character_id in player["chars"]), key=lambda item: item["num"])
    state["callIdx"] = 0
    _log(state, "—— 第 " + str(state["round"]) + " 轮行动阶段开始 ——", "round")
    _begin_next_call(state)


def _begin_next_call(state: dict) -> None:
    state["turn"] = None
    if state["callIdx"] >= len(state["callQueue"]):
        _end_round(state)
        return
    entry = state["callQueue"][state["callIdx"]]
    character = cards.CHAR_MAP[entry["charId"]]
    if state["effects"]["assassinated"] == entry["num"]:
        player = state["players"][entry["playerIdx"]]
        _log(state, f"【{entry['num']} {character['name']}】被刺杀，{player['name']} 跳过本回合。", "bad")
        _notify(state, "assassinated", {"playerIdx": entry["playerIdx"], "playerId": player["id"],
                                        "playerName": player["name"], "num": entry["num"],
                                        "charName": character["name"]})
        state["callIdx"] += 1
        _begin_next_call(state)
        return
    if state["effects"]["bewitched"] == entry["num"]:
        state["turn"] = _new_turn(entry, "bewitched")
        _num4_turn_start(state, entry)
        victim = state["players"][entry["playerIdx"]]
        _log(state, f"【{entry['num']} {character['name']}】被施咒，{victim['name']} 只能领取资源。", "magic")
        by_index = state["effects"]["witchBy"]
        _notify(state, "bewitched", {"playerIdx": entry["playerIdx"], "playerId": victim["id"],
                                      "playerName": victim["name"], "num": entry["num"],
                                      "charName": character["name"],
                                      "byName": state["players"][by_index]["name"] if by_index is not None else ""})
        return
    if state["effects"]["thief"] == entry["num"] and state["effects"]["thiefBy"] is not None:
        victim = state["players"][entry["playerIdx"]]
        thief = state["players"][state["effects"]["thiefBy"]]
        amount = victim["gold"]
        victim["gold"] = 0
        thief["gold"] += amount
        _log(state, f"【盗贼】{thief['name']} 偷走了 {victim['name']} 的 {amount} 枚金币。", "bad")
        _notify(state, "thief_steal", {"playerIdx": entry["playerIdx"], "playerId": victim["id"],
                                       "playerName": victim["name"], "byIdx": state["effects"]["thiefBy"],
                                       "byName": thief["name"], "amount": amount, "num": entry["num"],
                                       "charName": character["name"]})
        state["effects"]["thief"] = None
    threat = state["effects"].get("blackmailer")
    if threat and entry["num"] in threat["nums"] and entry["num"] not in threat.get("done", []):
        target = state["players"][entry["playerIdx"]]
        state["turn"] = _new_turn(entry, "main")
        state["turn"]["pending"] = {"kind": "blackmailer_threat", "targetIdx": entry["playerIdx"],
                                    "signed": threat["signed"] == entry["num"]}
        _log(state, f"【勒索者】{target['name']} 受到威胁，可支付一半金币赎回。", "bad")
        _notify(state, "blackmailer_threat", {"playerIdx": entry["playerIdx"],
                                                "playerId": target["id"], "playerName": target["name"]})
        _num4_turn_start(state, entry)
        return
    state["turn"] = _new_turn(entry, "main")
    _num4_turn_start(state, entry)
    if character["id"] == "queen":
        holder = next((index for index, player in enumerate(state["players"])
                       if any(cards.CHAR_MAP[character_id]["num"] == 4 for character_id in player["chars"])), -1)
        if holder >= 0:
            if state["effects"]["assassinated"] == 4:
                state["pendingQueen"] = {"playerIdx": entry["playerIdx"]}
            else:
                distance = abs(entry["playerIdx"] - holder)
                adjacent = distance in (1, len(state["players"]) - 1)
                if adjacent:
                    queen = state["players"][entry["playerIdx"]]
                    queen["gold"] += 3
                    _notify_gold_gain(state, entry["playerIdx"], 3, None, "皇后相邻奖励")
                    _log(state, "【皇后】" + queen["name"] + " 坐在 " +
                         state["players"][holder]["name"] + "（4号角色）旁边，获得 3 枚金币。", "good")
                else:
                    _log(state, "【皇后】座位未与 4 号角色相邻，未获得金币。")


def _new_turn(entry: dict, phase: str) -> dict:
    return {"charId": entry["charId"], "num": entry["num"],
            "playerIdx": entry["playerIdx"], "phase": phase,
            "takenResources": False, "incomeTaken": False, "abilityUsed": False,
            "builds": 0, "spentOnBuild": 0, "usedLab": False,
            "usedSmithy": False, "usedMuseum": False, "pending": None,
            "bonusDone": False}


def _num4_turn_start(state: dict, entry: dict) -> None:
    if entry["num"] != 4:
        return
    character = cards.CHAR_MAP[entry["charId"]]
    if entry["num"] == 4 and character["id"] in ("king", "noble"):
        _set_crown(state, entry["playerIdx"])
        if character["id"] == "noble":
            player = state["players"][entry["playerIdx"]]
            count = sum(1 for built in player["city"] if built["color"] == "yellow" or
                        (built.get("purple") or {}).get("effect") == "anyColorIncome")
            if count:
                drawn = _draw_cards(state, count)
                player["hand"].extend(drawn)
                _notify(state, "noble_draw", {"playerIdx": entry["playerIdx"],
                                                "playerId": player["id"],
                                                "playerName": player["name"], "amount": count,
                                                "cardNames": [card["name"] for card in drawn]})
                _log(state, f"【贵族】{player['name']} 因 {count} 栋皇家建筑抽取 {count} 张建筑牌。", "good")
            state["turn"]["incomeTaken"] = True


def _set_crown(state: dict, index: int) -> None:
    for player_index, player in enumerate(state["players"]):
        player["hasCrown"] = player_index == index
    _log(state, "【皇冠】" + state["players"][index]["name"] + " 获得皇冠，下轮优先选角。", "crown")


def _finish_game(state: dict) -> None:
    state["phase"] = "gameover"
    state["turn"] = None
    state["scores"] = compute_scores(state)
    best = max(row["total"] for row in state["scores"])
    winners = [row["playerIdx"] for row in state["scores"] if row["total"] == best]
    state["winner"] = winners[0] if len(winners) == 1 else None
    _log(state, "=== 游戏结束 ===", "sys")
    for row in state["scores"]:
        _log(state, f"{row['name']}：{row['total']} 分（建筑 {row['base']} + 奖励 {row['bonus']}）", "score")
    if state["winner"] is not None:
        _log(state, "胜利者：" + state["players"][state["winner"]]["name"] + "！", "score")
    else:
        _log(state, "平局！", "score")


def _end_round(state: dict) -> None:
    assassinated = state["effects"]["assassinated"]
    if assassinated is not None:
        entry = next((item for item in state["callQueue"] if item["num"] == assassinated), None)
        if entry:
            character = cards.CHAR_MAP[entry["charId"]]
            _log(state, "刺杀公开：" + state["players"][entry["playerIdx"]]["name"] +
                 " 本轮是『" + character["name"] + "』。", "sys")
            if entry["num"] == 4 and character["id"] in ("king", "noble"):
                _set_crown(state, entry["playerIdx"])
            elif entry["num"] == 4 and character["id"] == "emperor":
                others = [index for index in range(len(state["players"])) if index != entry["playerIdx"]]
                if others:
                    _set_crown(state, others[_rand_int(state, len(others))])
                    _log(state, "被刺杀的皇帝仍须交出皇冠。", "crown")
            if entry["num"] == 4 and state.get("pendingQueen"):
                queen_index = state["pendingQueen"]["playerIdx"]
                distance = abs(queen_index - entry["playerIdx"])
                if distance in (1, len(state["players"]) - 1):
                    state["players"][queen_index]["gold"] += 3
                    _notify_gold_gain(state, queen_index, 3, None, "皇后相邻奖励（轮末）")
                    _log(state, "【皇后】座位与 4 号角色相邻，轮末获得 3 枚金币。", "good")
                state["pendingQueen"] = None
    if any(len(player["city"]) >= state["config"]["endDistricts"] for player in state["players"]):
        _finish_game(state)
        return
    state["turn"] = None
    state["roundConfirm"] = {"round": state["round"],
                             "confirmed": [False for _ in state["players"]]}
    _log(state, f"—— 第 {state['round']} 轮结束，等待所有玩家确认战果 ——", "round")
    _notify(state, "round_end", {"round": state["round"]})


def _after_resources(state: dict, turn: dict, player: dict, character: dict) -> None:
    if character.get("drawBonus") and not turn["bonusDone"] and turn["phase"] != "witch_resume":
        bonus = character["drawBonus"]
        drawn = _draw_cards(state, bonus)
        player["hand"].extend(drawn)
        _notify_hand_gain(state, turn["playerIdx"], len(drawn), None,
                          character["name"] + "额外抽牌")
        turn["bonusDone"] = True
        _log(state, f"【{character['name']}】{player['name']} 额外抽取 {bonus} 张建筑牌。", "good")
    if character["id"] == "navigator" and not turn["bonusDone"] and turn["phase"] != "witch_resume":
        turn["pending"] = {"kind": "navigator_bonus"}
        return
    if character["id"] == "scholar" and not turn["abilityUsed"] and turn["phase"] != "witch_resume":
        _start_scholar(state, turn)
        return
    if character["id"] == "monk" and not turn["incomeTaken"] and turn["phase"] != "witch_resume":
        turn["pending"] = {"kind": "monk_declare"}
        return
    if character["id"] == "prophet" and not turn["abilityUsed"] and turn["phase"] != "witch_resume":
        _start_prophet(state, turn)
        return
    if character["id"] == "witch" and turn["phase"] != "witch_resume" and not turn["abilityUsed"]:
        turn["pending"] = {"kind": "witch_target"}
        return


def _start_scholar(state: dict, turn: dict) -> None:
    drawn = _draw_cards(state, 7)
    if not drawn:
        turn["abilityUsed"] = True
        return
    turn["pending"] = {"kind": "scholar_pick", "cards": drawn}


def _start_prophet(state: dict, turn: dict) -> None:
    player = state["players"][turn["playerIdx"]]
    queue = []
    for index, target in enumerate(state["players"]):
        if index == turn["playerIdx"] or not target["hand"]:
            continue
        card = target["hand"].pop(_rand_int(state, len(target["hand"])))
        player["hand"].append(card)
        _notify_hand_gain(state, turn["playerIdx"], 1, index, "预言家抽取手牌")
        queue.append(index)
    _log(state, f"【预言家】{player['name']} 从 {len(queue)} 位对手处各抽走 1 张建筑牌。", "magic")
    if not queue:
        turn["abilityUsed"] = True
    else:
        turn["pending"] = {"kind": "prophet_give", "targetIdx": queue[0], "queue": queue}


def _record_observation(state: dict, turn: dict, player: dict, character: dict) -> None:
    if turn["phase"] == "witch_resume" or character["id"] in ("navigator", "bishop"):
        return
    if turn["builds"] >= _build_limit(turn) or player["gold"] < 1:
        return
    observations = state["observations"]
    while len(observations) <= turn["playerIdx"]:
        observations.append(None)
    observations[turn["playerIdx"]] = {
        "round": state["round"], "gold": player["gold"],
        "handSize": len(player["hand"]),
        "freeColors": ["green"] if character["id"] == "businessman" else [],
    }


def _end_turn(state: dict) -> dict:
    turn = state.get("turn")
    if not turn:
        return {"ok": False, "error": "没有进行中的回合"}
    player = state["players"][turn["playerIdx"]]
    character = cards.CHAR_MAP[turn["charId"]]
    _record_observation(state, turn, player, character)
    if character["id"] == "alchemist" and turn["spentOnBuild"] > 0:
        player["gold"] += turn["spentOnBuild"]
        via_witch = turn["phase"] == "witch_resume"
        _log(state, f"【炼金术士】{player['name']}" + ("（女巫接管）" if via_witch else "") +
             f" 回收了本回合 {turn['spentOnBuild']} 枚建造花费。", "good")
        _notify(state, "alchemist_refund", {"playerIdx": turn["playerIdx"],
                                            "playerId": player["id"], "playerName": player["name"],
                                            "amount": turn["spentOnBuild"], "viaWitch": via_witch})
    player["played"].append(turn["charId"])
    state["callIdx"] += 1
    _begin_next_call(state)
    return {"ok": True}


def _finish_bewitched_turn(state: dict) -> dict:
    witch_index = state["effects"]["witchBy"]
    if witch_index is None:
        state["callIdx"] += 1
        _begin_next_call(state)
        return {"ok": True}
    entry = state["callQueue"][state["callIdx"]]
    character = cards.CHAR_MAP[entry["charId"]]
    turn = _new_turn(entry, "witch_resume")
    turn["playerIdx"] = witch_index
    turn["takenResources"] = True
    turn["bonusDone"] = character["id"] != "navigator"
    state["turn"] = turn
    _log(state, f"【女巫】{state['players'][witch_index]['name']} 接管『{character['name']}』的剩余行动。", "magic")
    return {"ok": True}


def _detach_museum(state: dict, card: dict) -> None:
    if card.get("museum"):
        state["discard"].extend(item for item in card["museum"] if item)
        card["museum"] = []


def _destroy(state: dict, turn: dict, index: int, action: dict) -> dict:
    target_index = next((i for i, item in enumerate(state["players"])
                         if item["id"] == action.get("target")), -1)
    if target_index < 0:
        return {"ok": False, "error": "无效的目标"}
    player, target = state["players"][index], state["players"][target_index]
    card = next((item for item in target["city"] if item["uid"] == action.get("uid")), None)
    if not card:
        return {"ok": False, "error": "无效的建筑"}
    if len(target["city"]) >= state["config"]["endDistricts"]:
        return {"ok": False, "error": "该玩家已达标，不可摧毁"}
    if target_index != index and _abbot_protected(state, target_index):
        return {"ok": False, "error": "该玩家的城市受到角色保护，不受8号角色能力影响"}
    if not _targetable(card):
        return {"ok": False, "error": "堡垒不可摧毁"}
    cost = _destroy_cost(target, card)
    if cost > player["gold"]:
        return {"ok": False, "error": f"金币不足，摧毁需 {cost} 金"}
    player["gold"] -= cost
    target["city"] = [item for item in target["city"] if item["uid"] != card["uid"]]
    _detach_museum(state, card)
    turn["abilityUsed"] = True
    turn["pending"] = None
    _log(state, f"【领主】{player['name']} 支付 {cost} 金摧毁了 {target['name']} 的『{card['name']}』。", "bad")
    _notify(state, "destroyed", {"playerIdx": target_index, "playerId": target["id"],
                                  "playerName": target["name"], "byName": player["name"],
                                  "cardName": card["name"], "cost": cost, "uid": card["uid"]})
    graveyards = [i for i, item in enumerate(state["players"]) if i != index and item["gold"] >= 1 and
                  any((built.get("purple") or {}).get("effect") == "graveyard" for built in item["city"])]
    if graveyards:
        state["reaction"] = {"kind": "graveyard", "playerIdx": graveyards[0],
                             "queue": graveyards, "card": card, "sourceIdx": target_index,
                             "prompt": f"【墓地】是否支付 1 金将『{card['name']}』收入手牌？"}
        state["pendingDestroy"] = {"card": card}
    else:
        state["discard"].append(card)
    return {"ok": True}


def _seize(state: dict, turn: dict, index: int, action: dict) -> dict:
    target_index = next((i for i, item in enumerate(state["players"])
                         if item["id"] == action.get("target")), -1)
    if target_index < 0:
        return {"ok": False, "error": "无效的目标"}
    player, target = state["players"][index], state["players"][target_index]
    if _abbot_protected(state, target_index):
        return {"ok": False, "error": "该玩家的城市受到角色保护，不受8号角色能力影响"}
    card = next((item for item in target["city"] if item["uid"] == action.get("uid")), None)
    if not card:
        return {"ok": False, "error": "无效的建筑"}
    if card["cost"] > 3:
        return {"ok": False, "error": "只能抢夺费用 3 以下的建筑"}
    if len(target["city"]) >= state["config"]["endDistricts"]:
        return {"ok": False, "error": "该玩家已达标，不可抢夺"}
    if not _targetable(card):
        return {"ok": False, "error": "堡垒不可抢夺"}
    if sum(item["name"] == card["name"] for item in player["city"]) >= _same_name_limit(player):
        return {"ok": False, "error": "你已有同名建筑"}
    if card["cost"] > player["gold"]:
        return {"ok": False, "error": "金币不足"}
    player["gold"] -= card["cost"]
    target["gold"] += card["cost"]
    _notify_gold_gain(state, target_index, card["cost"], index, "元帅抢夺付款")
    target["city"] = [item for item in target["city"] if item["uid"] != card["uid"]]
    _detach_museum(state, card)
    player["city"].append(card)
    turn["abilityUsed"] = True
    turn["pending"] = None
    _log(state, f"【元帅】{player['name']} 支付 {card['cost']} 金给 {target['name']}，抢夺了『{card['name']}』。", "bad")
    _notify(state, "seized", {"playerIdx": target_index, "playerId": target["id"],
                               "playerName": target["name"], "byName": player["name"],
                               "cardName": card["name"], "cost": card["cost"]})
    return {"ok": True}


def _diplomat_swap(state: dict, turn: dict, index: int, action: dict) -> dict:
    player = state["players"][index]
    mine = next((item for item in player["city"] if item["uid"] == turn["pending"]["mineUid"]), None)
    target_index = next((i for i, item in enumerate(state["players"])
                         if item["id"] == action.get("target")), -1)
    if target_index < 0 or target_index == index:
        return {"ok": False, "error": "无效的目标"}
    target = state["players"][target_index]
    if _abbot_protected(state, target_index):
        return {"ok": False, "error": "该玩家的城市受到角色保护，不受8号角色能力影响"}
    theirs = next((item for item in target["city"] if item["uid"] == action.get("uid")), None)
    if not theirs:
        return {"ok": False, "error": "无效的建筑"}
    if not _targetable(theirs):
        return {"ok": False, "error": "堡垒不可交换"}
    if sum(item["name"] == theirs["name"] for item in player["city"]) >= _same_name_limit(player):
        return {"ok": False, "error": "你已有同名建筑"}
    difference = max(0, theirs["cost"] - mine["cost"])
    if difference > player["gold"]:
        return {"ok": False, "error": f"金币不足，需补差价 {difference} 金"}
    player["gold"] -= difference
    target["gold"] += difference
    if difference:
        _notify_gold_gain(state, target_index, difference, index, "外交官补差价")
    target["city"] = [item for item in target["city"] if item["uid"] != theirs["uid"]]
    player["city"] = [item for item in player["city"] if item["uid"] != mine["uid"]]
    _detach_museum(state, theirs)
    _detach_museum(state, mine)
    player["city"].append(theirs)
    target["city"].append(mine)
    turn["abilityUsed"] = True
    turn["pending"] = None
    suffix = f"，补差价 {difference} 金" if difference else ""
    _log(state, f"【外交官】{player['name']} 用『{mine['name']}』换来了 {target['name']} 的『{theirs['name']}』{suffix}。", "bad")
    fields = ("uid", "name", "en", "desc", "color", "cost", "scoreValue")
    _notify(state, "swapped", {"byIdx": index, "byId": player["id"], "byName": player["name"],
                                "playerIdx": target_index, "playerId": target["id"],
                                "playerName": target["name"], "cardName": theirs["name"],
                                "gotName": mine["name"], "cost": difference,
                                "mineCard": {key: mine.get(key) for key in fields},
                                "theirsCard": {key: theirs.get(key) for key in fields}})
    return {"ok": True}


def _graveyard_reaction(state: dict, index: int, action: dict) -> dict:
    reaction = state["reaction"]
    if action.get("type") != "reaction":
        return {"ok": False, "error": "无效的响应"}
    card = state.get("pendingDestroy", {}).get("card") or reaction["card"]
    player = state["players"][index]
    if action.get("use"):
        if player["gold"] < 1:
            return {"ok": False, "error": "金币不足"}
        player["gold"] -= 1
        player["hand"].append(card)
        _notify_hand_gain(state, index, 1, reaction["sourceIdx"], "墓地收回建筑")
        _log(state, f"【墓地】{player['name']} 支付 1 金将『{card['name']}』收入手牌。", "good")
        reaction["queue"] = []
        state["reaction"] = state["pendingDestroy"] = None
        return {"ok": True}
    reaction["queue"].pop(0)
    if reaction["queue"]:
        reaction["playerIdx"] = reaction["queue"][0]
        return {"ok": True}
    state["reaction"] = None
    state["discard"].append(card)
    state["pendingDestroy"] = None
    _log(state, f"『{card['name']}』被放入弃牌堆。")
    return {"ok": True}


def _magistrate_reaction(state: dict, index: int, action: dict) -> dict:
    if action.get("type") != "reaction":
        return {"ok": False, "error": "无效的响应"}
    reaction = state["reaction"]
    turn = state.get("turn")
    target_index = reaction["build"]["targetIdx"]
    target = state["players"][target_index]
    card = next((item for item in target["hand"] if item["uid"] == reaction["build"]["uid"]), None)
    state["reaction"] = None
    if not turn or turn["playerIdx"] != target_index:
        return {"ok": False, "error": "当前不是该玩家的建造时机"}
    if not card:
        return {"ok": False, "error": "待建造的建筑已不在手牌"}
    can_take = bool(action.get("use")) and not any(
        built["name"] == card["name"] for built in state["players"][index]["city"])
    return _build(state, turn, target_index, card, index if can_take else -1)


def _blackmailer_reaction(state: dict, index: int, action: dict) -> dict:
    if action.get("type") != "reaction":
        return {"ok": False, "error": "无效的响应"}
    reaction = state["reaction"]
    turn = state.get("turn")
    target_index = reaction["targetIdx"]
    target = state["players"][target_index]
    owner = state["players"][index]
    threat = state["effects"].get("blackmailer")
    number = reaction["num"]
    state["reaction"] = None
    if not turn or turn["playerIdx"] != target_index:
        return {"ok": False, "error": "当前不是该玩家的回合"}
    turn["pending"] = None
    turn["takenResources"] = False
    if not threat:
        return {"ok": True}
    is_real = threat["signed"] == number
    threat.setdefault("done", []).append(number)
    if not action.get("use"):
        _log(state, f"【勒索者】{owner['name']} 选择不翻开，{target['name']} 的威胁标记本轮作废。", "magic")
        _notify(state, "blackmailer_reveal", {"playerIdx": target_index, "playerId": target["id"],
                                                "playerName": target["name"], "byIdx": index,
                                                "byId": owner["id"], "byName": owner["name"],
                                                "revealed": False, "isReal": False, "amount": 0})
        return {"ok": True}
    threat.setdefault("revealed", []).append({"num": number, "isReal": is_real})
    amount = 0
    if is_real:
        amount = target["gold"]
        target["gold"] = 0
        owner["gold"] += amount
        _log(state, f"【勒索者】翻开威胁标记：『带血的刀』——{owner['name']} 拿走 {target['name']} 的全部 {amount} 枚金币。", "bad")
    else:
        _log(state, f"【勒索者】翻开威胁标记：『玫瑰花』——虚惊一场，{target['name']} 分文未失。", "good")
    _notify(state, "blackmailer_reveal", {"playerIdx": target_index, "playerId": target["id"],
                                            "playerName": target["name"], "byIdx": index,
                                            "byId": owner["id"], "byName": owner["name"],
                                            "fromIdx": target_index if amount > 0 else None,
                                            "toIdx": index if amount > 0 else None,
                                            "revealed": True, "isReal": is_real, "amount": amount})
    return {"ok": True}


def _check_warrant(state: dict, turn: dict, player_index: int, card: dict) -> bool:
    warrant = state["effects"].get("magistrate")
    if (not warrant or warrant["claimed"] or warrant["signed"] != turn["num"] or
            player_index == warrant["playerIdx"]):
        return False
    warrant["claimed"] = True
    magistrate = state["players"][warrant["playerIdx"]]
    if any(item["name"] == card["name"] for item in magistrate["city"]):
        return False
    builder = state["players"][player_index]
    state["reaction"] = {"kind": "magistrate", "playerIdx": warrant["playerIdx"],
                         "queue": [warrant["playerIdx"]],
                         "build": {"uid": card["uid"], "targetIdx": player_index},
                         "card": {"uid": card["uid"], "name": card["name"], "cost": card["cost"]},
                         "prompt": f"【行政官】是否发动逮捕令，没收 {builder['name']} 即将建造的『{card['name']}』？"}
    return True


def _collect_building_tax(state: dict, player_index: int) -> bool:
    """Charge one coin after a build when the builder can still afford it."""
    if "tax_collector" not in state["charDeck"]:
        return False
    collector_index = next((index for index, player in enumerate(state["players"])
                            if "tax_collector" in player["chars"]), -1)
    player = state["players"][player_index]
    if collector_index == player_index or player["gold"] <= 0:
        return False
    player["gold"] -= 1
    state["effects"]["taxCollectorGold"] += 1
    _log(state, f"{player['name']} 缴纳 1 枚建筑税，放入税务官标记。", "magic")
    _notify(state, "tax_paid", {"playerIdx": player_index, "playerId": player["id"],
                                 "playerName": player["name"], "amount": 1})
    return True


def _build(state: dict, turn: dict, player_index: int, card: dict,
           confiscate_index: int = -1) -> dict:
    player = state["players"][player_index]
    player["gold"] -= card["cost"]
    turn["spentOnBuild"] += card["cost"]
    player["hand"] = [held for held in player["hand"] if held["uid"] != card["uid"]]
    built = {**card, "beautified": 0, "builtRound": state["round"],
             "museum": list(card.get("museum") or [])}
    player["city"].append(built)
    turn["builds"] += 1
    if confiscate_index >= 0:
        magistrate = state["players"][confiscate_index]
        player["city"] = [item for item in player["city"] if item["uid"] != built["uid"]]
        player["gold"] += card["cost"]
        _notify_gold_gain(state, player_index, card["cost"], None, "行政官没收退款")
        magistrate["city"].append(built)
        _log(state, f"【行政官】{magistrate['name']} 没收了 {player['name']} 建造的『{card['name']}』。", "bad")
        _notify(state, "magistrate_confiscate", {
            "byIdx": confiscate_index, "byId": magistrate["id"], "byName": magistrate["name"],
            "playerIdx": player_index, "playerId": player["id"], "playerName": player["name"],
            "card": {"uid": card["uid"], "name": card["name"], "cost": card["cost"]}})
    tax_payer_index = confiscate_index if confiscate_index >= 0 else player_index
    _collect_building_tax(state, tax_payer_index)
    _log(state, f"{player['name']} 建造了『{card['name']}』（{card['cost']} 金）。", "build")
    _notify(state, "built", {"playerIdx": player_index, "playerId": player["id"],
                             "playerName": player["name"],
                             "card": {key: built.get(key) for key in (
                                 "uid", "name", "en", "desc", "color", "cost", "scoreValue", "purple")}})
    if len(player["city"]) >= state["config"]["endDistricts"] and state["firstToFinish"] < 0:
        state["firstToFinish"] = player_index
        _log(state, f"* {player['name']} 率先建成第 {state['config']['endDistricts']} 栋建筑，本轮结束后游戏结束！", "sys")
    return {"ok": True}


def _apply_turn_action(state: dict, index: int, action: dict) -> dict:
    turn = state["turn"]
    player = state["players"][index]
    character = cards.CHAR_MAP[turn["charId"]]
    kind = action.get("type")
    pending = turn.get("pending")
    if kind == "take_gold":
        if turn["takenResources"]:
            return {"ok": False, "error": "本回合已领取资源"}
        amount = 2 + ((character.get("goldBonus") or 0) if turn["phase"] != "witch_resume" else 0)
        player["gold"] += amount
        turn["takenResources"] = True
        _log(state, f"{player['name']}（{character['name']}）领取 {amount} 枚金币。")
        _notify_gold_gain(state, index, amount, None, "领取资源")
        if turn["phase"] == "bewitched":
            return _finish_bewitched_turn(state)
        _after_resources(state, turn, player, character)
        return {"ok": True}
    if kind == "take_cards":
        if turn["takenResources"]:
            return {"ok": False, "error": "本回合已领取资源"}
        turn["takenResources"] = True
        special = {(built.get("purple") or {}).get("effect") for built in player["city"]}
        keep_both = "keepBoth" in special
        draw_three = not keep_both and "draw3keep1" in special
        bonus = (character.get("goldBonus") or 0) if turn["phase"] != "witch_resume" else 0
        if bonus:
            player["gold"] += bonus
            _log(state, f"【{character['name']}】{player['name']} 额外获得 {bonus} 枚金币。", "good")
            _notify_gold_gain(state, index, bonus, None, "角色加成")
        drawn = _draw_cards(state, 3 if draw_three else 2)
        if keep_both:
            player["hand"].extend(drawn)
            _notify_hand_gain(state, index, len(drawn), None, "图书馆")
            _log(state, f"{player['name']}（{character['name']}）抽了 2 张建筑牌并全部保留（图书馆）。")
            if turn["phase"] == "bewitched":
                return _finish_bewitched_turn(state)
            _after_resources(state, turn, player, character)
            return {"ok": True}
        if not drawn:
            if turn["phase"] == "bewitched":
                return _finish_bewitched_turn(state)
            _after_resources(state, turn, player, character)
            return {"ok": True}
        turn["pending"] = {"kind": "draw_keep", "cards": drawn, "toBottom": True,
                           "prompt": f"抽取了 {len(drawn)} 张，选择 1 张加入手牌"}
        return {"ok": True}
    if kind == "draw_keep":
        if not pending or pending["kind"] != "draw_keep":
            return {"ok": False, "error": "当前无需选择"}
        card = next((item for item in pending["cards"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "无效的卡牌"}
        player["hand"].append(card)
        _notify_hand_gain(state, index, 1, None, "抽牌保留")
        rest = [item for item in pending["cards"] if item["uid"] != card["uid"]]
        if pending["toBottom"]:
            state["deck"].extend(rest)
        _log(state, f"{player['name']} 抽取 {len(pending['cards'])} 张建筑牌，保留了 1 张" +
             ("（其余放回牌库底）" if pending["toBottom"] else "") + "。")
        turn["pending"] = None
        if turn["phase"] == "bewitched":
            return _finish_bewitched_turn(state)
        _after_resources(state, turn, player, character)
        return {"ok": True}
    if kind == "navigator_bonus":
        if not pending or pending["kind"] != "navigator_bonus":
            return {"ok": False, "error": "当前无需选择"}
        mode = action.get("mode")
        if mode == "gold":
            player["gold"] += 4
            amount = 4
            _log(state, f"【航海家】{player['name']} 额外获得 4 枚金币。", "good")
        elif mode == "cards":
            drawn = _draw_cards(state, 4)
            player["hand"].extend(drawn)
            amount = len(drawn)
            _log(state, f"【航海家】{player['name']} 额外抽取 4 张建筑牌。", "good")
        else:
            return {"ok": False, "error": "无效的航海家奖励"}
        _notify(state, "navigator_bonus", {"playerIdx": index, "playerId": player["id"],
                                           "playerName": player["name"], "mode": mode,
                                           "amount": amount})
        turn["bonusDone"] = turn["abilityUsed"] = True
        turn["pending"] = None
        return {"ok": True}
    if kind == "scholar_pick":
        if not pending or pending["kind"] != "scholar_pick":
            return {"ok": False, "error": "当前无需选择"}
        card = next((item for item in pending["cards"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "无效的卡牌"}
        player["hand"].append(card)
        _notify_hand_gain(state, index, 1, None, "学者选牌")
        rest = [item for item in pending["cards"] if item["uid"] != card["uid"]]
        state["deck"].extend(rest)
        state["deck"] = cards.shuffle(state["deck"], lambda: next_rand(state))
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【学者】{player['name']} 从 {len(pending['cards'])} 张建筑牌中选择了 1 张，其余洗回牌堆。", "good")
        return {"ok": True}
    if kind == "monk_resource":
        if not pending or pending["kind"] != "monk_declare":
            return {"ok": False, "error": "当前无需宣告"}
        count = sum(1 for built in player["city"] if built["color"] == "blue" or
                    (built.get("purple") or {}).get("effect") == "anyColorIncome")
        gold = action.get("gold")
        card_count = action.get("cards")
        if not isinstance(gold, int) or not isinstance(card_count, int) or gold + card_count != count:
            return {"ok": False, "error": "资源组合不正确"}
        player["gold"] += gold
        drawn = _draw_cards(state, card_count)
        player["hand"].extend(drawn)
        _notify_hand_gain(state, index, len(drawn), None, "修士资源")
        _notify_gold_gain(state, index, gold, None, "修士资源")
        turn["incomeTaken"] = True
        turn["pending"] = None
        _log(state, f"【修士】{player['name']} 领取 {gold} 金 + {card_count} 张建筑牌。", "good")
        return {"ok": True}
    if kind == "spy_target":
        target_index = next((i for i, other in enumerate(state["players"])
                             if other["id"] == action.get("target")), -1)
        if not pending or pending["kind"] != "spy_target" or target_index < 0 or target_index == index:
            return {"ok": False, "error": "无效的间谍目标"}
        turn["pending"] = {"kind": "spy_color", "targetIdx": target_index}
        return {"ok": True}
    if kind == "spy_color":
        color = action.get("color")
        if not pending or pending["kind"] != "spy_color" or color not in ("yellow", "blue", "green", "red", "purple"):
            return {"ok": False, "error": "无效的调查类型"}
        target = state["players"][pending["targetIdx"]]
        matching = sum(card["color"] == color for card in target["hand"])
        stolen = min(target["gold"], matching)
        target["gold"] -= stolen
        player["gold"] += stolen
        drawn = _draw_cards(state, matching)
        player["hand"].extend(drawn)
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【间谍】{player['name']} 调查了 {target['name']} 的手牌，获得 {len(drawn)} 张建筑牌并拿走 {stolen} 金。", "magic")
        _notify(state, "spy_result", {"byIdx": index, "byId": player["id"], "byName": player["name"],
                                       "targetIdx": pending["targetIdx"], "targetId": target["id"],
                                       "targetName": target["name"], "color": color,
                                       "matching": matching, "gold": stolen,
                                       "cards": [card["name"] for card in drawn]})
        return {"ok": True}
    if kind == "wizard_target":
        target_index = next((i for i, other in enumerate(state["players"])
                             if other["id"] == action.get("target")), -1)
        if not pending or pending["kind"] != "wizard_target" or target_index < 0 or target_index == index:
            return {"ok": False, "error": "无效的法师目标"}
        target = state["players"][target_index]
        if not target["hand"]:
            turn["pending"] = None
            turn["abilityUsed"] = True
            _log(state, f"【法师】{target['name']} 没有手牌，能力无从发动。")
            return {"ok": True}
        turn["pending"] = {"kind": "wizard_card", "targetIdx": target_index,
                           "cards": list(target["hand"])}
        return {"ok": True}
    if kind == "wizard_card":
        card = next((item for item in pending["cards"] if item["uid"] == action.get("uid")), None) if pending and pending["kind"] == "wizard_card" else None
        if not card:
            return {"ok": False, "error": "无效的法师卡牌"}
        turn["pending"] = {"kind": "wizard_choice", "targetIdx": pending["targetIdx"], "card": card}
        return {"ok": True}
    if kind == "magistrate_signed":
        if not pending or pending["kind"] != "magistrate_declare":
            return {"ok": False, "error": "当前无需选择真逮捕令目标"}
        number = action.get("num")
        legal = [choice["num"] for choice in _char_choices(state, turn, set(), "magistrate_signed")
                 if choice["type"] == "magistrate_signed"]
        if number not in legal:
            return {"ok": False, "error": "真逮捕令目标无效"}
        turn["pending"] = {"kind": "magistrate_second", "used": [number], "signed": number}
        return {"ok": True}
    if kind == "magistrate_char":
        if not pending or pending["kind"] not in ("magistrate_second", "magistrate_third"):
            return {"ok": False, "error": "当前无需分配假逮捕令"}
        used = pending.get("used") or []
        number = action.get("num")
        legal = [choice["num"] for choice in _char_choices(state, turn, set(used), "magistrate_char")
                 if choice["type"] == "magistrate_char"]
        if number not in legal:
            return {"ok": False, "error": "假逮捕令目标必须与真逮捕令和其他目标不同"}
        next_used = used + [number]
        if len(next_used) < 3:
            turn["pending"] = {"kind": "magistrate_third", "used": next_used,
                               "signed": pending["signed"]}
            return {"ok": True}
        state["effects"]["magistrate"] = {"nums": next_used, "signed": pending["signed"],
                                           "playerIdx": index, "claimed": False}
        turn["abilityUsed"] = True
        turn["pending"] = None
        targets = []
        for target_number in next_used:
            char_id = next((char_id for char_id in state["charDeck"]
                            if cards.CHAR_MAP[char_id]["num"] == target_number), None)
            targets.append({"num": target_number, "charId": char_id or "",
                            "name": cards.CHAR_MAP[char_id]["name"] if char_id else "未知角色"})
        text = "、".join(f"{target['num']} 号·{target['name']}" for target in targets)
        _log(state, f"【行政官】{player['name']} 把 3 张逮捕令发给了 {text}（其中只有一张是真的）。", "magic")
        _notify(state, "magistrate_declare", {"byIdx": index, "byId": player["id"],
                                              "byName": player["name"], "nums": next_used,
                                              "targets": [{"num": target["num"], "name": target["name"]}
                                                          for target in targets]})
        return {"ok": True}
    if kind == "blackmailer_char":
        number = action.get("num")
        if not pending or pending["kind"] not in ("blackmailer_declare", "blackmailer_second"):
            return {"ok": False, "error": "当前无需分配威胁标记"}
        if (not isinstance(number, int) or number == turn["num"] or
                pending.get("first") == number):
            return {"ok": False, "error": "威胁目标必须是两个不同角色"}
        if number in _blackmailer_blocked(state):
            return {"ok": False, "error": f"不能把威胁标记放在 {number} 号角色身上（1 号角色 / 被刺杀 / 被施咒 / 已有逮捕令者除外）"}
        if pending["kind"] == "blackmailer_declare":
            turn["pending"] = {"kind": "blackmailer_second", "first": number}
        else:
            turn["pending"] = {"kind": "blackmailer_signed", "nums": [pending["first"], number]}
        return {"ok": True}
    if kind == "blackmailer_signed":
        if not pending or pending["kind"] != "blackmailer_signed":
            return {"ok": False, "error": "当前无需指定真威胁标记"}
        number = action.get("num")
        if number not in pending["nums"]:
            return {"ok": False, "error": "真威胁标记只能放在已选的两个角色之一"}
        return _commit_blackmailer(state, turn, index, pending["nums"], number)
    if kind == "blackmailer_bribe":
        if not pending or pending["kind"] != "blackmailer_threat":
            return {"ok": False, "error": "当前没有勒索威胁"}
        threat = state["effects"].get("blackmailer")
        if not threat:
            return {"ok": False, "error": "当前没有生效的威胁标记"}
        amount = player["gold"] // 2
        player["gold"] -= amount
        threat["nums"] = [number for number in threat["nums"] if number != turn["num"]]
        turn["pending"] = None
        turn["takenResources"] = False
        _log(state, f"【勒索者】{player['name']} 支付 {amount} 金赎回威胁。", "magic")
        return {"ok": True}
    if kind == "blackmailer_refuse":
        if not pending or pending["kind"] != "blackmailer_threat":
            return {"ok": False, "error": "当前没有勒索威胁"}
        threat = state["effects"].get("blackmailer")
        if not threat:
            return {"ok": False, "error": "当前没有生效的威胁标记"}
        owner_index = threat["playerIdx"]
        if owner_index == index:
            threat.setdefault("done", []).append(turn["num"])
            turn["pending"] = None
            turn["takenResources"] = False
            _log(state, f"【勒索者】{player['name']} 放弃使用威胁标记。", "magic")
            return {"ok": True}
        owner = state["players"][owner_index]
        turn["pending"] = None
        state["reaction"] = {"kind": "blackmailer", "playerIdx": owner_index,
                             "targetIdx": index, "num": turn["num"],
                             "prompt": f"【勒索者】是否翻开 {player['name']} 的威胁标记？"}
        _log(state, f"【勒索者】{player['name']} 拒绝支付赎金，等待 {owner['name']} 决定是否翻开威胁标记。", "magic")
        _notify(state, "blackmailer_wait", {"playerIdx": index, "playerId": player["id"],
                                             "playerName": player["name"], "byIdx": owner_index,
                                             "byId": owner["id"], "byName": owner["name"],
                                             "num": turn["num"]})
        return {"ok": True}
    if kind in ("wizard_take", "wizard_build"):
        target = state["players"][pending["targetIdx"]] if pending and pending["kind"] == "wizard_choice" else None
        if not target:
            return {"ok": False, "error": "当前无需选择"}
        card = next((item for item in target["hand"] if item["uid"] == pending["card"]["uid"]), None)
        if not card:
            return {"ok": False, "error": "该卡牌已不在目标手牌中"}
        if kind == "wizard_take":
            target["hand"] = [item for item in target["hand"] if item["uid"] != card["uid"]]
            player["hand"].append(card)
            _notify_hand_gain(state, index, 1, pending["targetIdx"], "法师获得手牌")
            turn["abilityUsed"] = True
            turn["pending"] = None
            _log(state, f"【法师】{player['name']} 从 {target['name']} 处取得 1 张建筑牌。", "magic")
            return {"ok": True}
        if player["gold"] < card["cost"]:
            return {"ok": False, "error": "金币不足"}
        player["gold"] -= card["cost"]
        turn["spentOnBuild"] += card["cost"]
        target["hand"] = [item for item in target["hand"] if item["uid"] != card["uid"]]
        built = {**card, "beautified": 0, "builtRound": state["round"], "museum": []}
        player["city"].append(built)
        _collect_building_tax(state, index)
        if len(player["city"]) >= state["config"]["endDistricts"] and state["firstToFinish"] < 0:
            state["firstToFinish"] = index
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【法师】{player['name']} 从 {target['name']} 处取牌并立即建造了『{card['name']}』。", "build")
        return {"ok": True}
    if kind == "monk_take":
        richest = _richest_other(state, index)
        if richest < 0 or state["players"][richest]["gold"] <= player["gold"]:
            return {"ok": False, "error": "没有比你更富有的玩家"}
        source = state["players"][richest]
        source["gold"] -= 1
        player["gold"] += 1
        turn["monkExtraTaken"] = True
        _log(state, f"【修士】{player['name']} 从 {source['name']} 处拿走 1 枚金币。", "good")
        _notify(state, "monk_take", {"fromIdx": richest, "fromId": source["id"],
                                      "fromName": source["name"], "toIdx": index,
                                      "toId": player["id"], "toName": player["name"], "amount": 1})
        return {"ok": True}
    if kind == "tax_collect":
        if not pending or pending["kind"] != "tax_collect":
            return {"ok": False, "error": "当前无需收税"}
        amount = state["effects"].get("taxCollectorGold") or 0
        player["gold"] += amount
        state["effects"]["taxCollectorGold"] = 0
        if amount > 0:
            _notify(state, "tax_collected", {"playerIdx": index, "playerId": player["id"],
                                              "playerName": player["name"], "amount": amount})
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【税务官】{player['name']} 收取了 {amount} 枚建筑税。", "good")
        return {"ok": True}
    if kind == "emperor_crown":
        if not pending or pending["kind"] != "emperor_crown":
            return {"ok": False, "error": "当前无需选择"}
        target_index = next((i for i, other in enumerate(state["players"])
                             if other["id"] == action.get("target")), -1)
        if target_index < 0 or target_index == index:
            return {"ok": False, "error": "无效的目标玩家"}
        from_index = next((i for i, other in enumerate(state["players"])
                           if other["hasCrown"]), -1)
        from_player = state["players"][from_index] if from_index >= 0 else None
        _set_crown(state, target_index)
        target = state["players"][target_index]
        _notify(state, "crown_transfer", {"fromIdx": from_index,
                                          "fromId": from_player["id"] if from_player else None,
                                          "fromName": from_player["name"] if from_player else None,
                                          "toIdx": target_index, "toId": target["id"],
                                          "toName": target["name"]})
        turn["pending"] = {"kind": "emperor_take", "targetIdx": target_index,
                           "_fromCrownIdx": from_index}
        return {"ok": True}
    if kind == "emperor_take":
        if not pending or pending["kind"] != "emperor_take":
            return {"ok": False, "error": "当前无需选择"}
        target = state["players"][pending["targetIdx"]]
        if action.get("mode") == "gold":
            amount = min(1, target["gold"])
            target["gold"] -= amount
            player["gold"] += amount
            _log(state, f"【皇帝】{player['name']} 从 {target['name']} 处拿取 {amount} 枚金币。", "good")
            if amount:
                _notify(state, "emperor_gold", {"fromIdx": pending["targetIdx"],
                                                "fromId": target["id"], "fromName": target["name"],
                                                "toIdx": index, "toId": player["id"],
                                                "toName": player["name"], "amount": amount})
        elif target["hand"]:
            card = target["hand"].pop(_rand_int(state, len(target["hand"])))
            player["hand"].append(card)
            _log(state, f"【皇帝】{player['name']} 从 {target['name']} 处随机拿取 1 张手牌。", "good")
            _notify(state, "emperor_card", {"fromIdx": pending["targetIdx"],
                                            "fromId": target["id"], "fromName": target["name"],
                                            "toIdx": index, "toId": player["id"],
                                            "toName": player["name"], "amount": 1})
        else:
            _log(state, f"【皇帝】{target['name']} 没有手牌可拿。")
        turn["abilityUsed"] = True
        turn["pending"] = None
        return {"ok": True}
    if kind == "prophet_give":
        if not pending or pending["kind"] != "prophet_give":
            return {"ok": False, "error": "当前无需选择"}
        card = next((item for item in player["hand"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "无效的手牌"}
        player["hand"] = [item for item in player["hand"] if item["uid"] != card["uid"]]
        target = state["players"][pending["targetIdx"]]
        target["hand"].append(card)
        _log(state, f"【预言家】{player['name']} 还给 {target['name']} 一张建筑牌。", "magic")
        _notify_hand_gain(state, pending["targetIdx"], 1, index, "预言家归还手牌")
        rest = list(pending.get("queue") or [])[1:]
        if rest:
            turn["pending"] = {"kind": "prophet_give", "targetIdx": rest[0], "queue": rest}
        else:
            turn["abilityUsed"] = True
            turn["pending"] = None
        return {"ok": True}
    if kind == "choose_district" and pending and pending["kind"] == "artist":
        card = next((item for item in player["city"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "无效的建筑"}
        selected = pending.setdefault("selected", [])
        if action.get("uid") in selected:
            return {"ok": False, "error": "该建筑已被选择"}
        if len(selected) >= 2:
            return {"ok": False, "error": "最多美化 2 栋"}
        if player["gold"] <= len(selected):
            return {"ok": False, "error": "金币不足"}
        selected.append(action["uid"])
        return {"ok": True}
    if kind == "choose_district" and pending and pending["kind"] in ("warlord_destroy", "marshal_seize"):
        return (_destroy(state, turn, index, action) if pending["kind"] == "warlord_destroy"
                else _seize(state, turn, index, action))
    if kind == "choose_district" and pending and pending["kind"] == "diplomat_mine":
        card = next((item for item in player["city"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "无效的建筑"}
        if not _targetable(card):
            return {"ok": False, "error": "堡垒不可被交换"}
        turn["pending"] = {"kind": "diplomat_theirs", "mineUid": action["uid"]}
        return {"ok": True}
    if kind == "choose_district" and pending and pending["kind"] == "diplomat_theirs":
        return _diplomat_swap(state, turn, index, action)
    if kind == "artist_done":
        if not pending or pending["kind"] != "artist":
            return {"ok": False, "error": "当前无需确认"}
        uids = action.get("uids") or []
        if len(uids) > 2:
            return {"ok": False, "error": "最多 2 栋"}
        if player["gold"] < len(uids):
            return {"ok": False, "error": "金币不足"}
        beautified = []
        for uid in uids:
            card = next((item for item in player["city"] if item["uid"] == uid), None)
            if card:
                card["beautified"] = 1
                player["gold"] -= 1
                beautified.append({"uid": card["uid"], "name": card["name"]})
        turn["abilityUsed"] = True
        turn["pending"] = None
        if beautified:
            _notify(state, "beautified", {"playerIdx": index, "playerId": player["id"],
                                          "playerName": player["name"],
                                          "uids": [item["uid"] for item in beautified],
                                          "cards": beautified, "amount": len(beautified)})
        _log(state, f"【艺术家】{player['name']} 美化了 {len(uids)} 栋建筑（各 +1 分）。", "good")
        return {"ok": True}
    if kind == "income":
        if turn["incomeTaken"]:
            return {"ok": False, "error": "本回合已领取收入"}
        income = _income(state, player, turn)
        if not income:
            return {"ok": False, "error": "该角色没有收入能力"}
        turn["incomeTaken"] = True
        if income.get("kind") == "cards":
            drawn = _draw_cards(state, income["n"])
            player["hand"].extend(drawn)
            _notify_hand_gain(state, index, len(drawn), None, "主教宗教建筑收入")
            _log(state, f"【主教】{player['name']} 因 {income['n']} 栋宗教建筑抽取 {len(drawn)} 张建筑牌。", "good")
        else:
            player["gold"] += income["n"]
            if income["n"] > 0:
                _log(state, f"【{character['name']}】{player['name']} 因 {income['n']} 栋" +
                     cards.COLORS[income["color"]]["name"] + f"建筑获得 {income['n']} 枚金币。", "good")
                _notify_gold_gain(state, index, income["n"], None, "角色收入")
        return {"ok": True}
    if kind == "build":
        card = next((item for item in player["hand"] if item["uid"] == action.get("uid")), None)
        if not card:
            return {"ok": False, "error": "手牌中没有这张建筑牌"}
        if character["id"] == "bishop" and card["cost"] > player["gold"]:
            if not _bishop_can_build_without_gold(player, card, turn):
                return {"ok": False, "error": "无法建造该建筑（超出建造限额或已有同名建筑）"}
            amount = card["cost"] - player["gold"]
            if len(player["hand"]) - 1 < amount or not any(
                    payer["gold"] >= amount for payer in state["players"] if payer["id"] != player["id"]):
                return {"ok": False, "error": "没有符合条件的代偿玩家或偿还手牌不足"}
            turn["pending"] = {"kind": "bishop_payer", "uid": card["uid"], "amount": amount}
            return {"ok": True}
        if not _can_build(state, player, card, turn):
            return {"ok": False, "error": "无法建造该建筑（金币不足、超出建造限额或已有同名建筑）"}
        if _check_warrant(state, turn, index, card):
            return {"ok": True}
        return _build(state, turn, index, card)
    if kind in ("lab", "smithy", "museum"):
        flag = {"lab": "usedLab", "smithy": "usedSmithy", "museum": "usedMuseum"}[kind]
        names = {"lab": "实验室", "smithy": "铁匠铺", "museum": "博物馆"}
        if turn[flag]:
            return {"ok": False, "error": f"本回合已使用过{names[kind]}"}
        built = next((item for item in player["city"] if item["uid"] == action.get("uid") and
                      (item.get("purple") or {}).get("effect") == kind), None)
        if not built:
            return {"ok": False, "error": f"你没有{names[kind]}"}
        if kind == "smithy":
            if player["gold"] < 2:
                return {"ok": False, "error": "金币不足"}
            player["gold"] -= 2
            drawn = _draw_cards(state, 3)
            player["hand"].extend(drawn)
            _notify_hand_gain(state, index, len(drawn), None, "铁匠铺")
            turn[flag] = True
            _log(state, player["name"] + " 使用【铁匠铺】支付 2 金抽取 3 张建筑牌。", "good")
            return {"ok": True}
        card_uid = action.get("discardUid" if kind == "lab" else "cardUid")
        if not card_uid:
            return {"ok": False, "error": "需要指定弃掉的卡牌" if kind == "lab" else "需要指定放入的卡牌"}
        card = next((item for item in player["hand"] if item["uid"] == card_uid), None)
        if not card:
            return {"ok": False, "error": "无效的手牌"}
        player["hand"] = [item for item in player["hand"] if item["uid"] != card_uid]
        if kind == "lab":
            state["discard"].append(card)
            player["gold"] += 1
            _log(state, f"{player['name']} 使用【实验室】弃掉『{card['name']}』获得 1 枚金币。", "good")
            _notify_gold_gain(state, index, 1, None, "实验室换取金币")
        else:
            built.setdefault("museum", []).append(card)
            _log(state, player["name"] + " 将一张建筑牌放入【博物馆】。", "good")
        turn[flag] = True
        return {"ok": True}
    if kind == "choose_player" and pending and pending["kind"] == "bishop_payer":
        payer_index = next((i for i, other in enumerate(state["players"])
                            if other["id"] == action.get("target")), -1)
        if payer_index < 0 or payer_index == index or state["players"][payer_index]["gold"] < pending["amount"]:
            return {"ok": False, "error": "无效的代偿玩家"}
        card = next((item for item in player["hand"] if item["uid"] == pending["uid"]), None)
        if not card or not _bishop_can_build_without_gold(player, card, turn):
            return {"ok": False, "error": "建筑状态已改变，无法继续代偿建造"}
        turn["pending"] = {"kind": "bishop_repay", "uid": pending["uid"],
                           "payerIdx": payer_index, "targetIdx": payer_index,
                           "amount": pending["amount"]}
        return {"ok": True}
    if kind == "choose_player" and pending and pending["kind"] == "magician_swap":
        target_index = next((i for i, other in enumerate(state["players"])
                             if other["id"] == action.get("target")), -1)
        if target_index < 0 or target_index == index:
            return {"ok": False, "error": "无效的目标玩家"}
        target = state["players"][target_index]
        player["hand"], target["hand"] = target["hand"], player["hand"]
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【魔术师】{player['name']} 与 {target['name']} 交换了全部手牌。", "magic")
        _notify(state, "magician_swap", {"byIdx": index, "byId": player["id"],
                                         "byName": player["name"], "playerIdx": target_index,
                                         "playerId": target["id"], "playerName": target["name"]})
        return {"ok": True}
    if kind == "choose_cards" and pending and pending["kind"] == "bishop_repay":
        uids = action.get("uids") or []
        if len(uids) != pending["amount"] or len(set(uids)) != len(uids):
            return {"ok": False, "error": f"必须选择恰好 {pending['amount']} 张手牌"}
        card = next((item for item in player["hand"] if item["uid"] == pending["uid"]), None)
        payer = state["players"][pending["payerIdx"]]
        if not card or payer["gold"] < pending["amount"] or any(
                uid == pending["uid"] or not any(item["uid"] == uid for item in player["hand"])
                for uid in uids):
            return {"ok": False, "error": "建筑、代付玩家或偿还手牌状态已改变"}
        repaid = [next(item for item in player["hand"] if item["uid"] == uid) for uid in uids]
        payer["gold"] -= pending["amount"]
        player["gold"] += pending["amount"]
        _notify_gold_gain(state, index, pending["amount"], pending["payerIdx"], "主教代付")
        player["hand"] = [item for item in player["hand"] if item["uid"] not in uids]
        payer["hand"].extend(repaid)
        turn["pending"] = None
        _log(state, f"【主教】{player['name']} 请 {payer['name']} 代付 {pending['amount']} 金，并交给对方 {pending['amount']} 张手牌。", "good")
        _notify_hand_gain(state, pending["payerIdx"], len(repaid), index, "主教偿还代付")
        if _check_warrant(state, turn, index, card):
            return {"ok": True}
        return _build(state, turn, index, card)
    if kind == "choose_cards" and pending and pending["kind"] == "magician_redraw":
        mode = action.get("mode")
        if mode in ("use", "skip"):
            cursor = pending.get("cursor") or 0
            card = player["hand"][cursor] if cursor < len(player["hand"]) else None
            if not card or action.get("uid") != card["uid"]:
                return {"ok": False, "error": "魔术师当前手牌已改变"}
            if mode == "use":
                pending.setdefault("selected", []).append(card["uid"])
            pending["cursor"] = cursor + 1
            if pending["cursor"] < len(player["hand"]):
                return {"ok": True}
            uids = pending.get("selected") or []
        else:
            uids = action.get("uids") or []
        dropped = []
        for uid in uids:
            card = next((item for item in player["hand"] if item["uid"] == uid), None)
            if card:
                player["hand"].remove(card)
                dropped.append(card)
        state["deck"].extend(dropped)
        drawn = _draw_cards(state, len(dropped))
        player["hand"].extend(drawn)
        _notify_hand_gain(state, index, len(drawn), None, "魔术师重抽")
        turn["abilityUsed"] = True
        turn["pending"] = None
        _log(state, f"【魔术师】{player['name']} 弃掉 {len(dropped)} 张并重抽 {len(drawn)} 张。", "magic")
        return {"ok": True}
    if kind == "magician_mode":
        if not pending or pending["kind"] != "magician_choice":
            return {"ok": False, "error": "当前无需选择"}
        if action.get("mode") == "swap":
            if len(state["players"]) <= 1:
                turn["pending"] = None
                turn["abilityUsed"] = True
            else:
                turn["pending"] = {"kind": "magician_swap"}
        else:
            turn["pending"] = {"kind": "magician_redraw", "selected": [], "cursor": 0}
        return {"ok": True}
    if kind == "pending_back" and pending and pending["kind"] in ("magician_swap", "magician_redraw"):
        if action.get("to") == "magician_choice":
            turn["pending"] = {"kind": "magician_choice"}
            _log(state, player["name"] + " 退回到【魔术师】能力选择。")
            return {"ok": True}
    if kind == "pending_back" and pending and pending["kind"] == "emperor_take":
        if action.get("to") == "emperor_crown":
            previous = pending.get("_fromCrownIdx")
            if previous is None or previous < 0 or previous >= len(state["players"]):
                _log(state, player["name"] + " 退回到【皇帝】选择皇冠对象（无法定位原皇冠持有者）。")
            else:
                _set_crown(state, previous)
                _log(state, "【皇帝】" + player["name"] + " 收回皇冠，转回 " +
                     state["players"][previous]["name"] + "。")
            turn["pending"] = {"kind": "emperor_crown"}
            return {"ok": True}
    if kind == "pending_back" and pending and pending["kind"] == "diplomat_theirs":
        if action.get("to") == "diplomat_mine":
            turn["pending"] = {"kind": "diplomat_mine"}
            _log(state, player["name"] + " 退回到【外交官】选择要交出的建筑。")
            return {"ok": True}
    if kind == "pending_back" and pending and pending["kind"] == "wizard_choice":
        if action.get("to") == "wizard_card":
            target = state["players"][pending["targetIdx"]]
            if not target["hand"]:
                return {"ok": False, "error": "目标玩家已经没有手牌"}
            turn["pending"] = {"kind": "wizard_card", "targetIdx": pending["targetIdx"],
                               "cards": list(target["hand"])}
            _log(state, player["name"] + " 退回到【法师】重新选择目标手牌。")
            return {"ok": True}
    if kind == "ability":
        if turn["abilityUsed"]:
            return {"ok": False, "error": "本回合已使用过能力"}
        if character["id"] in ("assassin", "thief", "witch"):
            turn["pending"] = {"kind": character["id"]}
            if character["id"] == "witch":
                turn["pending"]["kind"] = "witch_target"
            return {"ok": True}
        if character["id"] == "magician":
            turn["pending"] = {"kind": "magician_choice"}
            return {"ok": True}
        if character["id"] == "navigator":
            if turn["bonusDone"]:
                return {"ok": False, "error": "本回合已领取过航海家奖励"}
            turn["pending"] = {"kind": "navigator_bonus"}
            return {"ok": True}
        if character["id"] == "scholar":
            _start_scholar(state, turn)
            return {"ok": True}
        if character["id"] == "tax_collector":
            turn["pending"] = {"kind": "tax_collect"}
            return {"ok": True}
        if character["id"] == "emperor":
            turn["pending"] = {"kind": "emperor_crown"}
            return {"ok": True}
        if character["id"] == "artist":
            turn["pending"] = {"kind": "artist", "selected": []}
            return {"ok": True}
        if character["id"] == "prophet":
            _start_prophet(state, turn)
            return {"ok": True}
        if character["id"] == "spy":
            turn["pending"] = {"kind": "spy_target"}
            return {"ok": True}
        if character["id"] == "wizard":
            turn["pending"] = {"kind": "wizard_target"}
            return {"ok": True}
        if character["id"] == "magistrate":
            turn["pending"] = {"kind": "magistrate_declare", "used": []}
            return {"ok": True}
        if character["id"] == "blackmailer":
            valid = _blackmailer_valid(state, turn)
            if not valid:
                turn["abilityUsed"] = True
                _log(state, "【勒索者】没有可以放置威胁标记的目标，能力作废。")
                return {"ok": True}
            if len(valid) == 1:
                return _commit_blackmailer(state, turn, index, [valid[0]], valid[0])
            turn["pending"] = {"kind": "blackmailer_declare"}
            return {"ok": True}
        if character["id"] in ("warlord", "marshal", "diplomat"):
            kinds = {"warlord": "warlord_destroy", "marshal": "marshal_seize",
                     "diplomat": "diplomat_mine"}
            turn["pending"] = {"kind": kinds[character["id"]]}
            return {"ok": True}
        raise NotImplementedError("Python 角色主动能力尚未迁移：" + character["id"])
    if kind == "choose_char":
        if not pending:
            return {"ok": False, "error": "当前无需选择角色"}
        if pending["kind"] not in ("assassin", "thief", "witch_target"):
            raise NotImplementedError("Python 角色选择能力尚未迁移：" + pending["kind"])
        number = action.get("num")
        if number not in [choice["num"] for choice in _char_choices(state, turn, {1}) if choice["type"] == "choose_char"]:
            return {"ok": False, "error": "无效的角色编号"}
        target_id = next((character_id for character_id in state["charDeck"]
                          if cards.CHAR_MAP[character_id]["num"] == number), None)
        target_name = cards.CHAR_MAP[target_id]["name"] if target_id else "未知角色"
        target_text = f"{number} 号角色『{target_name}』"
        if pending["kind"] == "assassin":
            state["effects"]["assassinated"] = number
            notice_kind = "assassin_declare"
            _log(state, f"【刺客】{player['name']} 宣布刺杀 {target_text}。", "bad")
        elif pending["kind"] == "thief":
            state["effects"]["thief"] = number
            state["effects"]["thiefBy"] = index
            notice_kind = "thief_declare"
            _log(state, f"【盗贼】{player['name']} 宣布偷窃 {target_text}。", "bad")
        else:
            state["effects"]["bewitched"] = number
            state["effects"]["witchBy"] = index
            turn["abilityUsed"] = True
            turn["pending"] = None
            _log(state, f"【女巫】{player['name']} 对 {number} 号角色施咒，结束自己的回合。", "magic")
            _notify(state, "witch_declare", {"num": number, "byIdx": index,
                                               "byId": player["id"], "byName": player["name"]})
            return _end_turn(state)
        _notify(state, notice_kind, {"num": number, "charId": target_id or "",
                                     "charName": target_name, "byIdx": index,
                                     "byId": player["id"], "byName": player["name"]})
        turn["abilityUsed"] = True
        turn["pending"] = None
        return {"ok": True}
    if kind == "ability_skip":
        turn["pending"] = None
        turn["abilityUsed"] = True
        _log(state, f"{player['name']} 放弃使用『{character['name']}』的能力。")
        return {"ok": True}
    if kind == "end_turn":
        if pending:
            return {"ok": False, "error": "请先完成当前选择"}
        return _end_turn(state)
    raise NotImplementedError("Python 行动类型尚未迁移：" + str(kind))


def apply_action(state: dict, player_id: str, action: dict) -> dict:
    player_index = next((index for index, player in enumerate(state["players"])
                         if player["id"] == player_id), -1)
    if player_index < 0:
        return {"ok": False, "error": "玩家不存在"}
    if state["phase"] == "draft":
        draft = state["draft"]
        step = draft["steps"][draft["stepIdx"]] if draft["stepIdx"] < len(draft["steps"]) else None
        if not step:
            return {"ok": False, "error": "选角已结束"}
        if step["player"] != player_index:
            return {"ok": False, "error": "还没轮到你选角"}
        kind = action.get("type")
        character_id = action.get("charId")
        if kind == "draft_pick":
            if draft["sub"] != "pick":
                return {"ok": False, "error": "当前应弃置角色牌"}
            pool = draft["pool"] + draft["faceDown"] if step.get("fromFaceDown") else draft["pool"]
            if character_id not in pool:
                return {"ok": False, "error": "无效的角色牌"}
            if character_id in draft["pool"]:
                draft["pool"].remove(character_id)
            else:
                draft["faceDown"].remove(character_id)
            state["players"][player_index]["chars"].append(character_id)
            _log(state, state["players"][player_index]["name"] + " 选择了一张角色牌。")
            _advance_draft(state)
            return {"ok": True}
        if kind == "draft_discard":
            if draft["sub"] != "discard":
                return {"ok": False, "error": "当前应选择角色牌"}
            character = cards.CHAR_MAP.get(character_id)
            if character and character["num"] == 4:
                return {"ok": False, "error": "4 号角色不可被弃置"}
            if character_id not in draft["pool"]:
                return {"ok": False, "error": "无效的角色牌"}
            draft["pool"].remove(character_id)
            draft["faceDown"].append(character_id)
            _log(state, state["players"][player_index]["name"] + " 暗置弃掉一张角色牌。")
            _advance_draft(state)
            return {"ok": True}
        return {"ok": False, "error": "未知的选角行动"}
    if state["phase"] == "gameover":
        return {"ok": False, "error": "游戏已结束"}
    if state["phase"] != "action":
        return {"ok": False, "error": "当前无可执行的行动"}
    if state.get("reaction"):
        reaction = state["reaction"]
        if reaction["playerIdx"] != player_index:
            return {"ok": False, "error": "不是你的响应时机"}
        if reaction["kind"] == "magistrate":
            return _magistrate_reaction(state, player_index, action)
        if reaction["kind"] == "blackmailer":
            return _blackmailer_reaction(state, player_index, action)
        if reaction["kind"] == "graveyard":
            return _graveyard_reaction(state, player_index, action)
        raise NotImplementedError("Python 响应行动尚未迁移")
    confirmation = state.get("roundConfirm")
    if confirmation:
        if action.get("type") != "confirm_round":
            return {"ok": False, "error": "请先确认本轮战果"}
        if confirmation["confirmed"][player_index]:
            return {"ok": False, "error": "你已确认过"}
        confirmation["confirmed"][player_index] = True
        _log(state, state["players"][player_index]["name"] + " 已确认本轮战果。")
        if all(confirmation["confirmed"]):
            state["roundConfirm"] = None
            start_round(state)
        return {"ok": True}
    turn = state.get("turn")
    if not turn:
        return {"ok": False, "error": "当前无可执行的行动"}
    if turn["playerIdx"] != player_index:
        return {"ok": False, "error": "不是你的回合"}
    return _apply_turn_action(state, player_index, action)
