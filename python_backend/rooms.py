"""In-memory room and seat lifecycle, independent of network transport."""

from __future__ import annotations

import secrets
import string
import time

ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _int_at_least(value, default: int, low: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        number = default
    return max(low, number)


def _seat_mcts(value: dict | None, fallback: dict | None = None) -> dict:
    value = value or {}
    fallback = fallback or {}
    return {"simulations": _int_at_least(value.get("simulations", fallback.get("mctsSimulations")), 500, 0),
            "maxDepth": _int_at_least(value.get("maxDepth", fallback.get("mctsMaxDepth")), 700, 0),
            "particles": _int_at_least(value.get("particles", fallback.get("mctsParticles")), 4, 1)}


def _seat_heuristic_mcts(value: dict | None = None) -> dict:
    value = value or {}
    defaults = {"simulations": (128, 1), "particles": (8, 1), "maxDepth": (32, 1),
                "timeBudgetMs": (200, 0), "criticalTimeBudgetMs": (400, 0),
                "cPuct": (1.4, 0), "rolloutSteps": (8, 0), "rollouts": (1, 1),
                "maxTreeNodes": (4096, 1)}
    result = {key: _int_at_least(value.get(key), default, minimum)
              for key, (default, minimum) in defaults.items() if key != "cPuct"}
    try:
        result["cPuct"] = max(0.0, float(value.get("cPuct", 1.4)))
    except (TypeError, ValueError, OverflowError):
        result["cPuct"] = 1.4
    result["reuseTree"] = value.get("reuseTree") is not False
    return result


def _identity(prefix: str) -> str:
    return prefix + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(6))


def _empty_seat() -> dict:
    return {"id": None, "name": "", "isBot": False, "taken": False,
            "disconnected": False, "left": False}


def _human_seat(name: str) -> dict:
    return {"id": _identity("p"), "name": name, "resumeToken": secrets.token_hex(24),
            "isBot": False, "taken": True, "disconnected": False, "left": False}


def _bot_seat(index: int, config: dict) -> dict:
    bot_type = config.get("botType") or "npc"
    bot_level = config.get("botLevel") or "normal"
    if bot_type in ("npc-easy", "npc-normal", "npc-hard"):
        bot_type, bot_level = "npc", bot_type[4:]
    if bot_type not in ("npc", "agent", "neural"):
        bot_type = "npc"
    if bot_level not in ("easy", "normal", "hard"):
        bot_level = "normal"
    return {"id": _identity("b"), "name": f"电脑 {index}", "isBot": True,
            "botType": bot_type, "botLevel": bot_level,
            "mcts": _seat_mcts(config.get("mcts"), config),
            "heuristicMcts": _seat_heuristic_mcts(config.get("heuristicMcts")),
            "taken": True, "disconnected": False, "left": False}


def lobby_view(room: dict) -> dict:
    return {"roomId": room["id"], "roomName": room["name"], "phase": "lobby",
            "you": None, "seats": [
                {"index": index, "id": seat["id"], "name": seat["name"],
                 "isBot": bool(seat["isBot"]), "botType": seat.get("botType") or "npc",
                 "botLevel": seat.get("botLevel") or "normal", "mcts": seat.get("mcts"),
                 "heuristicMcts": seat.get("heuristicMcts"),
                 "taken": bool(seat["taken"]),
                 "connected": bool(seat["isBot"] or not seat.get("disconnected") and not seat.get("left")),
                 "disconnected": bool(seat.get("disconnected")), "left": bool(seat.get("left"))}
                for index, seat in enumerate(room["seats"])],
            "config": room["config"], "voiceReady": False}


def public_room(room: dict) -> dict:
    return {"id": room["id"], "name": room["name"],
            "phase": room["state"]["phase"] if room["state"] else "lobby",
            "seats": [{"name": seat["name"], "isBot": bool(seat["isBot"]),
                       "botType": seat.get("botType") or "npc", "botLevel": seat.get("botLevel"),
                       "mcts": seat.get("mcts"), "heuristicMcts": seat.get("heuristicMcts"),
                       "taken": bool(seat["taken"]), "id": seat["id"],
                       "connected": bool(seat["isBot"] or not seat.get("disconnected") and not seat.get("left")),
                       "disconnected": bool(seat.get("disconnected")), "left": bool(seat.get("left"))}
                      for seat in room["seats"]],
            "config": room["config"], "playerCount": len(room["seats"])}


class RoomRegistry:
    def __init__(self) -> None:
        self.rooms: dict[str, dict] = {}

    def create_room(self, host_name: str, config: dict | None = None) -> dict:
        config = config or {}
        total = max(2, min(8, int(config.get("playerCount") or 4)))
        bots = max(0, min(total - 1, int(config.get("bots") or 0)))
        room_id = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(4))
        while room_id in self.rooms:
            room_id = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(4))
        seat_config = {**config, "botType": config.get("botType") or "npc",
                       "botLevel": config.get("botLevel") or "normal"}
        seats = [_human_seat(host_name or "房主")]
        seats.extend(_bot_seat(index, seat_config) for index in range(1, bots + 1))
        seats.extend(_empty_seat() for _ in range(total - len(seats)))
        room = {
            "id": room_id, "name": (host_name or "房主") + " 的房间", "seats": seats,
            "config": {"playerCount": total, "endDistricts": config.get("endDistricts") or 8,
                       "charSetMode": config.get("charSetMode") or "base",
                       "botLevel": seat_config["botLevel"], "botType": seat_config["botType"],
                       "botPace": config.get("botPace") or 430,
                       "mctsSimulations": _int_at_least(config.get("mctsSimulations"), 500, 0),
                       "mctsMaxDepth": _int_at_least(config.get("mctsMaxDepth"), 700, 0),
                       "mctsParticles": _int_at_least(config.get("mctsParticles"), 4, 1),
                       "mctsBelief": config.get("mctsBelief") is not False,
                       "voice": config.get("voice") is not False},
            "state": None, "createdAt": int(time.time() * 1000),
            "botDebug": [], "closed": False,
        }
        self.rooms[room_id] = room
        return room

    def join_room(self, room_id: str, name: str) -> tuple[dict, dict]:
        room = self.rooms.get(room_id)
        if not room:
            raise ValueError("房间不存在")
        if room["state"] and room["state"]["phase"] != "gameover":
            seat = next((seat for seat in room["seats"]
                         if seat["name"] == (name or "玩家") and not seat["isBot"]
                         and not seat.get("left")), None)
            if seat:
                return room, seat
            raise ValueError("该房间已开局")
        for index, seat in enumerate(room["seats"]):
            if not seat["taken"]:
                room["seats"][index] = _human_seat(name or "玩家")
                return room, room["seats"][index]
        raise ValueError("房间已满")

    def resume_room(self, token: str, room_id: str | None = None) -> tuple[dict, dict] | None:
        if not token:
            return None
        search = [self.rooms[room_id]] if room_id and room_id in self.rooms else self.rooms.values()
        for room in search:
            for seat in room["seats"]:
                if seat["taken"] and seat.get("resumeToken") and secrets.compare_digest(seat["resumeToken"], token):
                    return room, seat
        return None

    def prepare_start_room(self, room_id: str) -> tuple[dict, list[dict]]:
        room = self.rooms[room_id]
        if room["state"]:
            raise ValueError("该房间已开局")
        # Match JS startRoom: compact occupied seats first, then append NPC fills.
        seats = [seat for seat in room["seats"] if seat["taken"]]
        bot_index = 1
        target_count = max(2, room["config"]["playerCount"])
        while len(seats) < target_count:
            seats.append(_bot_seat(bot_index, room["config"]))
            bot_index += 1
        room["seats"] = seats
        return room, seats

    def finish_start_room(self, room_id: str, state: dict) -> dict:
        room = self.rooms[room_id]
        if room["state"]:
            raise ValueError("该房间已开局")
        room["state"] = state
        return state
