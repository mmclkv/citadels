"""Test-only Python reference for native hidden-information sampling."""
from __future__ import annotations

import copy
import math
import random

from python_backend.cards import CHAR_MAP


def _shuffle(values: list, rng) -> list:
    result = list(values)
    for index in range(len(result) - 1, 0, -1):
        other = min(index, max(0, int(rng() * (index + 1))))
        result[index], result[other] = result[other], result[index]
    return result


def _pinned_uids(state: dict, viewer_index: int) -> set[str]:
    uids: set[str] = set()
    turn = state.get("turn") or {}
    pending = turn.get("pending") or {}
    if turn and pending and turn.get("playerIdx") == viewer_index:
        card = pending.get("card")
        if isinstance(card, dict) and card.get("uid"):
            uids.add(card["uid"])
        uids.update(card["uid"] for card in pending.get("cards", [])
                    if isinstance(card, dict) and card.get("uid"))
    for key in ("reaction", "pendingDestroy"):
        card = (state.get(key) or {}).get("card")
        if isinstance(card, dict) and card.get("uid"):
            uids.add(card["uid"])
    return uids


def _redistribute(piles: list[tuple[list, set[str] | None]], rng) -> None:
    sizes = []
    source = []
    for items, pinned in piles:
        free = [item for item in items if not pinned or item.get("uid") not in pinned]
        sizes.append(len(free))
        source.extend(free)
    mixed = _shuffle(source, rng)
    offset = 0
    for (items, pinned), size in zip(piles, sizes):
        replacement = iter(mixed[offset:offset + size])
        offset += size
        items[:] = [item if pinned and item.get("uid") in pinned else next(replacement)
                    for item in items]


def _character_piles(state: dict, viewer_index: int) -> list[tuple[list, list[int]]]:
    piles: list[tuple[list, list[int]]] = []
    for player_index, player in enumerate(state["players"]):
        if player_index == viewer_index:
            continue
        played = set(player.get("played") or [])
        slots = [index for index, char_id in enumerate(player.get("chars") or [])
                 if char_id not in played]
        if slots:
            piles.append((player["chars"], slots))
    draft = state.get("draft")
    if draft:
        step = (draft.get("steps") or [])[draft.get("stepIdx", 0):draft.get("stepIdx", 0) + 1]
        current_step = step[0] if step else None
        face_down_visible = bool(current_step and current_step.get("player") == viewer_index and
                                 current_step.get("fromFaceDown") and draft.get("sub") == "pick")
        if not face_down_visible:
            piles.append((draft.setdefault("faceDown", []), list(range(len(draft.get("faceDown", []))))))
        if current_step and current_step.get("player") != viewer_index:
            pool = draft.get("pool")
            if isinstance(pool, list):
                piles.append((pool, list(range(len(pool)))))
    return piles


def _shuffle_character_piles(piles: list[tuple[list, list[int]]], rng) -> None:
    cards = [items[index] for items, slots in piles for index in slots]
    shuffled = _shuffle(cards, rng)
    offset = 0
    for items, slots in piles:
        for slot, char_id in zip(slots, shuffled[offset:offset + len(slots)]):
            items[slot] = char_id
        offset += len(slots)


def _rebuild_call_queue(state: dict) -> None:
    queue = state.get("callQueue")
    if not isinstance(queue, list) or not queue:
        return
    keep_through = min(state.get("callIdx") or 0, len(queue) - 1)
    preserved = queue[:keep_through + 1]
    queued_roles = {item.get("charId") for item in preserved if isinstance(item, dict)}
    rest = []
    for player_index, player in enumerate(state["players"]):
        played = set(player.get("played") or [])
        for char_id in player.get("chars") or []:
            info = CHAR_MAP.get(char_id)
            if info and char_id not in played and char_id not in queued_roles:
                rest.append({"charId": char_id, "num": info["num"], "playerIdx": player_index})
    rest.sort(key=lambda item: item["num"])
    state["callQueue"] = preserved + rest


def _reguess_signed(effect: dict | None, viewer_index: int, candidates: list,
                    rng) -> None:
    if not effect or effect.get("playerIdx") == viewer_index:
        return
    options = candidates or effect.get("nums") or []
    if options:
        effect["signed"] = options[min(len(options) - 1, int(rng() * len(options)))]


def determinize(state: dict, player_id: str, rng=None) -> dict:
    """Return a determinized clone, preserving all facts visible to ``player_id``.

    ``rng`` can be a zero-argument float source for reproducible tests.
    """
    rng = rng or random.random
    clone = copy.deepcopy(state)
    viewer_index = next((i for i, player in enumerate(clone.get("players", []))
                         if player.get("id") == player_id), -1)
    if viewer_index < 0:
        return clone
    pinned = _pinned_uids(clone, viewer_index)
    district_piles: list[tuple[list, set[str] | None]] = []
    for index, player in enumerate(clone["players"]):
        if index == viewer_index:
            continue
        player.setdefault("hand", [])
        district_piles.append((player["hand"], pinned))
        for card in player.get("city") or []:
            museum = card.get("museum")
            if isinstance(museum, list) and museum:
                district_piles.append((museum, pinned))
    clone.setdefault("deck", [])
    clone.setdefault("discard", [])
    district_piles.extend(((clone["deck"], pinned), (clone["discard"], pinned)))
    turn = clone.get("turn") or {}
    pending = turn.get("pending") or {}
    if isinstance(pending.get("cards"), list) and turn.get("playerIdx") != viewer_index:
        district_piles.append((pending["cards"], pinned))
    _redistribute(district_piles, rng)
    _shuffle_character_piles(_character_piles(clone, viewer_index), rng)
    _rebuild_call_queue(clone)

    magistrate = (clone.get("effects") or {}).get("magistrate")
    if magistrate and not magistrate.get("claimed"):
        _reguess_signed(magistrate, viewer_index, magistrate.get("nums") or [], rng)
    blackmailer = (clone.get("effects") or {}).get("blackmailer")
    if blackmailer and not any(isinstance(row, dict) and row.get("isReal")
                               for row in blackmailer.get("revealed") or []):
        open_nums = [number for number in blackmailer.get("nums") or []
                     if number not in (blackmailer.get("done") or [])]
        _reguess_signed(blackmailer, viewer_index, open_nums, rng)
    pending = (clone.get("turn") or {}).get("pending") or {}
    if pending.get("kind") == "blackmailer_threat":
        pending["signed"] = rng() < 0.5
    clone["rngState"] = math.floor(rng() * 0x100000000) & 0xFFFFFFFF
    return clone
