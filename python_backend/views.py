"""Per-player public game views. Hidden cards and unrevealed roles stay server-side."""

from __future__ import annotations

from .cards import CHAR_MAP


def _role(character_id: str, include_english: bool = False) -> dict:
    character = CHAR_MAP[character_id]
    result = {"id": character_id, "num": character["num"],
              "name": character["name"]}
    if include_english:
        result["en"] = character["en"]
    result["desc"] = character["desc"]
    return result


def _public_character_numbers(state: dict, player_index: int, viewer_index: int) -> list[int]:
    player = state["players"][player_index]
    if player_index == viewer_index:
        return [CHAR_MAP[character_id]["num"] for character_id in player["chars"]]
    result = []
    turn = state.get("turn")
    if state["phase"] == "action" and turn and turn["playerIdx"] == player_index:
        result.append(CHAR_MAP[turn["charId"]]["num"])
    result.extend(CHAR_MAP[character_id]["num"] for character_id in player["played"])
    return result


def _threat_mark(state: dict, player_index: int, viewer_index: int) -> dict | None:
    threat = state["effects"].get("blackmailer")
    if not threat:
        return None
    known = _public_character_numbers(state, player_index, viewer_index)
    revealed = [item for item in threat.get("revealed", []) if item["num"] in known]
    if revealed:
        last = revealed[-1]
        return {"num": last["num"], "revealed": True, "isReal": bool(last["isReal"])}
    for number in threat.get("nums", []):
        if number in known and number not in threat.get("done", []):
            return {"num": number, "revealed": False, "isReal": None}
    return None


def _warrant_mark(state: dict, player_index: int, viewer_index: int) -> dict | None:
    warrant = state["effects"].get("magistrate")
    if not warrant:
        return None
    known = _public_character_numbers(state, player_index, viewer_index)
    for number in warrant.get("nums", []):
        if number in known:
            return {"num": number}
    return None


def _card_public(card: dict) -> dict:
    return {"uid": card["uid"], "name": card["name"], "en": card["en"],
            "color": card["color"], "cost": card["cost"],
            "scoreValue": card.get("scoreValue") or card.get("cost", 0),
            "beautified": card.get("beautified") or 0,
            "museumCount": len(card.get("museum") or []), "builtRound": card.get("builtRound") or 0,
            "purpleEffect": (card.get("purple") or {}).get("effect") or "",
            "desc": card.get("desc") or ""}


def _hand_card_public(card: dict, buildable_uids: set[str]) -> dict:
    return {"uid": card["uid"], "name": card["name"], "en": card["en"],
            "color": card["color"], "cost": card["cost"],
            "scoreValue": card.get("scoreValue") or card.get("cost", 0),
            "purpleEffect": (card.get("purple") or {}).get("effect") or "",
            "desc": card.get("desc") or "",
            "canBuild": card.get("uid") in buildable_uids}


PENDING_PROMPTS = {
    "assassin": "选择要刺杀的角色", "thief": "选择要偷窃的角色",
    "witch_target": "选择要施咒的角色", "magician_choice": "选择魔术师的能力",
    "magician_swap": "选择交换手牌的对象", "magician_redraw": "选择要弃掉的手牌",
    "warlord_destroy": "选择要摧毁的建筑", "marshal_seize": "选择要抢夺的建筑",
    "diplomat_mine": "选择自己的建筑", "diplomat_theirs": "选择要换取的建筑",
    "artist": "选择要美化的建筑", "navigator_bonus": "选择额外奖励",
    "monk_declare": "宣告资源组合", "abbot_declare": "宣告住持资源组合",
    "tax_collect": "收取建筑税", "magistrate_declare": "分配逮捕令",
    "magistrate_second": "分配逮捕令", "magistrate_third": "分配逮捕令",
    "magistrate_signed": "指定真逮捕令目标", "bishop_payer": "选择主教建筑的代偿玩家",
    "bishop_repay": "选择偿还代偿的手牌",
    "emperor_crown": "选择皇冠归属", "emperor_take": "选择拿取金币或手牌",
    "prophet_give": "选择归还的手牌",
    "spy_target": "选择间谍调查对象", "spy_color": "选择间谍调查类型",
    "wizard_target": "选择法师查看对象", "wizard_card": "选择法师取得的牌",
    "wizard_choice": "选择法师牌的去向",
    "blackmailer_declare": "分配威胁标记", "blackmailer_second": "分配威胁标记",
    "blackmailer_signed": "指定真威胁标记目标", "blackmailer_threat": "处理勒索威胁",
}


def _small_card(card: dict) -> dict:
    return {key: card[key] for key in ("uid", "name", "en", "color", "cost", "desc")}


def _pending_public(pending: dict, is_actor: bool) -> dict:
    kind = pending["kind"]
    if kind in ("draw_keep", "scholar_pick", "wizard_card"):
        result = {"kind": kind, "targetIdx": pending.get("targetIdx"),
                  "count": len(pending.get("cards") or []),
                  "cards": [_small_card(card) for card in pending.get("cards", [])] if is_actor else []}
        if kind == "wizard_card":
            result["prompt"] = PENDING_PROMPTS.get(kind, "")
        elif "prompt" in pending:
            result["prompt"] = pending["prompt"]
        if kind != "wizard_card":
            result["fromCrownIdx"] = pending.get("_fromCrownIdx")
        return result
    if kind == "wizard_choice":
        return {"kind": kind, "prompt": PENDING_PROMPTS.get(kind, ""),
                "targetIdx": pending.get("targetIdx"),
                "card": _small_card(pending["card"]) if is_actor and pending.get("card") else None}
    if kind == "artist":
        return {"kind": kind, "targetIdx": pending.get("targetIdx"),
                "fromCrownIdx": pending.get("_fromCrownIdx"),
                "selected": list(pending.get("selected") or [])}
    if kind == "magician_redraw":
        return {"kind": kind, "cursor": (pending.get("cursor") or 0) if is_actor else 0,
                "selected": list(pending.get("selected") or []) if is_actor else []}
    if kind == "bishop_repay":
        return {"kind": kind, "targetIdx": pending.get("payerIdx") if is_actor else None,
                "amount": pending["amount"] if is_actor else 0,
                "uid": pending["uid"] if is_actor else ""}
    if kind == "bishop_payer":
        return {"kind": kind, "prompt": PENDING_PROMPTS[kind], "targetIdx": None,
                "amount": pending["amount"] if is_actor else 0,
                "uid": pending["uid"] if is_actor else ""}
    return {"kind": kind, "prompt": PENDING_PROMPTS.get(kind, ""),
            "targetIdx": pending.get("targetIdx"), "fromCrownIdx": pending.get("_fromCrownIdx")}


def _notice_for_viewer(notice: dict, viewer_index: int) -> dict:
    if (notice["kind"] == "noble_draw" and notice.get("playerIdx") == viewer_index or
            notice["kind"] == "spy_result" and notice.get("byIdx") == viewer_index):
        return notice.copy()
    if notice["kind"] not in ("noble_draw", "spy_result"):
        return notice.copy()
    return {key: value for key, value in notice.items()
            if key not in ("cardNames", "matching", "cards")}


def sanitize(state: dict, player_id: str | None,
             legal_actions: list[dict] | None = None) -> dict:
    viewer_index = next((index for index, player in enumerate(state["players"])
                         if player["id"] == player_id), -1)
    players = []
    turn = state.get("turn")
    buildable_uids = {action.get("uid") for action in (legal_actions or [])
                      if action.get("type") == "build" and action.get("uid")}
    for index, player in enumerate(state["players"]):
        revealed_id = (player["chars"][0] if index == viewer_index and player["chars"] else
                       turn["charId"] if state["phase"] == "action" and turn and
                       turn["playerIdx"] == index else
                       player["played"][0] if player["played"] else None)
        row = {"id": player["id"], "name": player["name"], "seat": player["seat"],
               "isBot": player["isBot"], "botType": player["botType"], "gold": player["gold"],
               "city": [_card_public(card) for card in player["city"]],
               "cityCount": len(player["city"]), "handCount": len(player["hand"]),
               "hasCrown": player["hasCrown"], "connected": player["connected"],
               "played": list(player["played"]),
               "threat": _threat_mark(state, index, viewer_index),
               "warrant": _warrant_mark(state, index, viewer_index),
               "hasChosen": bool(player["chars"]),
               "draftComplete": state["phase"] != "draft" or len(player["chars"]) >= (
                   2 if len(state["players"]) <= 3 else 1),
               "revealedCharId": revealed_id,
               "revealedCharNum": CHAR_MAP[revealed_id]["num"] if revealed_id else None}
        if index == viewer_index:
            row["hand"] = [_hand_card_public(card, buildable_uids) for card in player["hand"]]
            row["chars"] = [{**_role(character_id),
                             "played": character_id in player["played"]}
                            for character_id in player["chars"]]
        else:
            row["chars"] = [{**_role(character_id), "played": True}
                            for character_id in player["played"]]
        players.append(row)
    effects = state["effects"]
    threat = effects.get("blackmailer")
    warrant = effects.get("magistrate")
    draft = state.get("draft")
    scores = state.get("scores") or []
    result = {
        "roomId": state["roomId"], "phase": state["phase"], "round": state["round"],
        "config": state["config"], "you": player_id if viewer_index >= 0 else None,
        "endDistricts": state["config"]["endDistricts"], "players": players,
        "deckCount": len(state["deck"]), "discardCount": len(state["discard"]),
        "callIdx": state.get("callIdx") or 0, "turnsCompleted": state.get("turnsCompleted") or 0,
        "charDeck": [_role(character_id, True) for character_id in state["charDeck"]],
        "effects": {"assassinated": effects["assassinated"], "thief": effects["thief"],
                    "bewitched": effects["bewitched"],
                    "taxCollectorGold": effects.get("taxCollectorGold") or 0,
                    "blackmailer": {"nums": list(threat.get("nums") or []),
                                    "playerIdx": threat["playerIdx"],
                                    "revealed": [{"num": item["num"], "isReal": bool(item["isReal"])}
                                                 for item in threat.get("revealed") or []],
                                    "done": list(threat.get("done") or [])} if threat else None,
                    "magistrate": {"nums": list(warrant.get("nums") or []),
                                   "playerIdx": warrant["playerIdx"]} if warrant else None},
        "firstToFinish": state["firstToFinish"], "log": state["log"][-120:],
        "notices": [_notice_for_viewer(notice, viewer_index) for notice in state["notices"][-12:]],
        "scores": scores, "winner": state["winner"],
        "removed": {"faceUp": [{key: _role(character_id)[key] for key in ("id", "num", "name")}
                               for character_id in draft["faceUp"]] if draft else [],
                    "faceDownCount": len(draft["faceDown"]) if draft else 0},
        "roundConfirm": {"round": state["roundConfirm"]["round"],
                         "confirmed": list(state["roundConfirm"]["confirmed"])}
        if state.get("roundConfirm") else None,
    }
    if state["phase"] == "draft" and draft:
        step = draft["steps"][draft["stepIdx"]] if draft["stepIdx"] < len(draft["steps"]) else None
        result["draft"] = {"stepIdx": draft["stepIdx"], "totalSteps": len(draft["steps"]),
                           "currentPlayer": state["players"][step["player"]]["id"] if step else None,
                           "sub": draft["sub"],
                           "faceUp": [_role(character_id) for character_id in draft["faceUp"]],
                           "faceDownCount": len(draft["faceDown"]), "poolCount": len(draft["pool"]),
                           "pool": [_role(character_id) for character_id in draft["pool"]]
                           if step and step["player"] == viewer_index else []}
    if turn:
        character = CHAR_MAP[turn["charId"]]
        turn_view = {"playerIdx": turn["playerIdx"],
                     "playerId": state["players"][turn["playerIdx"]]["id"],
                     "charId": turn["charId"], "charName": character["name"],
                     "charNum": turn["num"], "phase": turn["phase"],
                     "takenResources": turn["takenResources"], "incomeTaken": turn["incomeTaken"],
                     "abilityUsed": turn["abilityUsed"], "spentOnBuild": turn["spentOnBuild"],
                     "usedLab": turn["usedLab"], "usedSmithy": turn["usedSmithy"],
                     "usedMuseum": turn["usedMuseum"], "bonusDone": turn["bonusDone"],
                     "buildLimit": turn.get("buildLimit", 0), "builds": turn["builds"],
                     "pending": _pending_public(turn["pending"], turn["playerIdx"] == viewer_index)
                     if turn.get("pending") else None}
        if "monkExtraTaken" in turn:
            turn_view["monkExtraTaken"] = turn["monkExtraTaken"]
        result["turn"] = turn_view
    if state.get("reaction"):
        reaction = state["reaction"]
        result["reaction"] = {"kind": reaction.get("kind") or "graveyard",
                              "playerIdx": reaction["playerIdx"],
                              "playerId": state["players"][reaction["playerIdx"]]["id"],
                              "targetIdx": reaction.get("targetIdx"), "prompt": reaction["prompt"]}
    return result
