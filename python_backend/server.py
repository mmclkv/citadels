"""Standalone stdlib HTTP/WebSocket transport for the Python game server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import copy
import gzip
import hashlib
import hmac
import io
import ipaddress
import json
import mimetypes
import os
import random
import re
import secrets
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import cards
from .rooms import RoomRegistry, _bot_seat, _empty_seat, _seat_mcts, lobby_view, public_room
from .views import sanitize
from .agent import AgentClient, AgentError, config_from_env
from .voice import VoiceService
from .neural import NeuralPolicy
from .training_runtime import TrainingManager
from .model_contract import MODEL_CONTRACTS
from .frp import FrpManager
from .codex_gateway import CodexGateway, detect_codex
from .native_worker_manager import NativeWorkerManager

ROOT = Path(__file__).resolve().parents[1]
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_HEADER_BYTES = 16384
MAX_FRAME_BYTES = 1_048_576
MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024
_ENTITY_V6_CONTRACT = MODEL_CONTRACTS["entity-v6"]
STATE_ENCODING_VERSION = _ENTITY_V6_CONTRACT["state"]
ACTION_ENCODING_VERSION = _ENTITY_V6_CONTRACT["action"]


def _encoding_compatible(state_version: int | None, action_version: int | None) -> bool:
    return (state_version, action_version) == (STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION)


def _append_game_log(state: dict, message: str, kind: str = "info") -> None:
    log = state.setdefault("log", [])
    log.append({"i": len(log), "text": message, "type": kind, "round": state.get("round", 0)})
    if len(log) > 400:
        del log[:-400]


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _positive_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
        return result if result > 0 else None
    except (TypeError, ValueError, OverflowError):
        return None


def platform_name() -> str:
    if os.name == "nt":
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def _is_loopback_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address | None) -> bool:
    return bool(address and (address.is_loopback or
                             (isinstance(address, ipaddress.IPv6Address) and
                              address.ipv4_mapped and address.ipv4_mapped.is_loopback)))


def _gunzip_limited(data: bytes, limit: int = 1_073_741_824) -> bytes:
    chunks = []
    total = 0
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
        while chunk := stream.read(min(1024 * 1024, limit + 1 - total)):
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise ValueError("解压后的存档超过 1 GiB，拒绝处理")
    return b"".join(chunks)


async def _http_response(writer: asyncio.StreamWriter, code: int, body: bytes,
                         content_type: str = "application/json; charset=utf-8",
                         headers: dict[str, str] | None = None) -> None:
    reason = {200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
              405: "Method Not Allowed", 401: "Unauthorized", 413: "Payload Too Large",
              429: "Too Many Requests",
              426: "Upgrade Required", 501: "Not Implemented", 503: "Service Unavailable",
              204: "No Content"}.get(code, "Error")
    header = (f"HTTP/1.1 {code} {reason}\r\nContent-Type: {content_type}\r\n"
              f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
              "X-Content-Type-Options: nosniff\r\n" +
              "".join(f"{key}: {value}\r\n" for key, value in (headers or {}).items()) +
              "Connection: close\r\n\r\n")
    writer.write(header.encode("ascii") + body)
    await writer.drain()


def _static_path(url_path: str) -> Path | None:
    try:
        decoded = unquote(url_path, errors="strict")
    except UnicodeDecodeError:
        return None
    if decoded == "/":
        decoded = "/index.html"
    if decoded.startswith("/src/"):
        # cards.js is browser presentation metadata; the JavaScript rules and
        # NPC implementations are no longer client assets or the live backend.
        if decoded != "/src/cards.js":
            return None
        base, relative = ROOT / "src", decoded[5:]
    elif decoded.startswith("/images/"):
        base, relative = ROOT / "images", decoded[8:]
    else:
        base, relative = ROOT / "public", decoded.lstrip("/")
    if ("\\" in relative or any(part.startswith(".") for part in relative.split("/"))
            or not relative or relative.endswith("/")):
        return None
    candidate = (base / relative).resolve()
    if not candidate.is_relative_to(base.resolve()):
        return None
    return candidate


async def _read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    header = await reader.readexactly(2)
    first, second = header
    if not first & 0x80:
        raise ValueError("不支持分片 WebSocket 帧")
    opcode = first & 0x0F
    if opcode not in (1, 8, 9, 10):
        raise ValueError("不支持的 WebSocket 帧类型")
    if not second & 0x80:
        raise ValueError("浏览器 WebSocket 帧必须加掩码")
    size = second & 0x7F
    if size == 126:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", await reader.readexactly(8))[0]
    if size > MAX_FRAME_BYTES:
        raise ValueError("WebSocket 消息过大")
    mask = await reader.readexactly(4)
    body = await reader.readexactly(size)
    return opcode, bytes(byte ^ mask[index % 4] for index, byte in enumerate(body))


async def _write_frame(writer: asyncio.StreamWriter, opcode: int, body: bytes) -> None:
    size = len(body)
    if size < 126:
        prefix = bytes((0x80 | opcode, size))
    elif size < 65536:
        prefix = bytes((0x80 | opcode, 126)) + struct.pack("!H", size)
    else:
        prefix = bytes((0x80 | opcode, 127)) + struct.pack("!Q", size)
    writer.write(prefix + body)
    await writer.drain()


class Client:
    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        self.id: str | None = None
        self.name = "玩家"
        self.room_id: str | None = None
        self.last_seen = time.monotonic()
        self.send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await _write_frame(self.writer, 1, _json_bytes(payload))


class PythonServer:
    def __init__(self, native_worker_manager: NativeWorkerManager | None = None) -> None:
        self.rooms = RoomRegistry()
        self.clients: set[Client] = set()
        external_agent_requested = any(os.environ.get(key) for key in
            ("CITADELS_AGENT_BASE_URL", "CITADELS_AGENT_MODEL", "CITADELS_AGENT_API_KEY"))
        self.local_codex = detect_codex()
        self.use_local_codex = (not external_agent_requested and
                                os.environ.get("CITADELS_DISABLE_LOCAL_CODEX") != "1" and
                                self.local_codex["available"])
        agent_env = dict(os.environ)
        if self.use_local_codex:
            agent_env.update({"CITADELS_AGENT_BASE_URL": "http://127.0.0.1:8787/api/codex/v1",
                              "CITADELS_AGENT_MODEL": os.environ.get("CITADELS_CODEX_MODEL") or "codex-cli",
                              "CITADELS_AGENT_API_KEY": "",
                              "CITADELS_AGENT_TIMEOUT_MS": os.environ.get("CITADELS_AGENT_TIMEOUT_MS", "150000")})
        self.agent = AgentClient(config_from_env(agent_env))
        self.codex_gateway = CodexGateway()
        self.training_data_dir = ROOT / "training-data"
        self.neural = NeuralPolicy(worker=native_worker_manager.worker if native_worker_manager else None)
        self.native_worker_manager = native_worker_manager
        self._native_action_lock = asyncio.Lock()
        self.training = TrainingManager(self.training_data_dir,
            native_worker=native_worker_manager.worker if native_worker_manager else None,
            game_worker=native_worker_manager.game_worker if native_worker_manager else None)
        self.frp = FrpManager(int(os.environ.get("PORT") or 8787), ROOT, self._log_startup)
        self.voice = VoiceService()
        self.voice_token_hits: dict[str, tuple[int, float]] = {}
        self.started_at = time.time()
        self.port: int | None = None
        self.listening = False
        self.logs: list[dict] = []
        self.console_origins = [origin.strip() for origin in os.environ.get(
            "CITADELS_CONSOLE_ORIGINS", "https://mmclkv.github.io").split(",") if origin.strip()]
        self.admin_credentials = self._load_admin_credentials()

    def _log_startup(self, message: str, level: str = "info") -> None:
        self.logs.append({"at": int(time.time() * 1000), "level": level, "text": str(message)[:1000]})
        self.logs = self.logs[-200:]

    def _agent_status(self) -> dict:
        status = self.agent.status()
        if self.use_local_codex:
            status.update({"provider": "local-codex", "version": self.local_codex["version"],
                           "message": "已连接本机 Codex（复用当前电脑保存的登录）"})
        elif not any(os.environ.get(key) for key in
                     ("CITADELS_AGENT_BASE_URL", "CITADELS_AGENT_MODEL", "CITADELS_AGENT_API_KEY")):
            status.update({"configured": False, "provider": "none",
                           "message": "未找到 Codex CLI；请先安装并登录 Codex，或配置外部模型服务"})
        else:
            status["provider"] = "external"
        return status

    def _load_admin_credentials(self) -> tuple[str, str]:
        username = (os.environ.get("CITADELS_ADMIN_USERNAME") or "").strip()
        password = os.environ.get("CITADELS_ADMIN_PASSWORD") or ""
        if username and password:
            return username, password
        configured_file = os.environ.get("CITADELS_ADMIN_FILE")
        if configured_file:
            credential_path = Path(configured_file)
        elif os.environ.get("CITADELS_ADMIN_DIR"):
            credential_path = Path(os.environ["CITADELS_ADMIN_DIR"]) / "server-admin.json"
        elif os.name == "nt":
            credential_path = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Citadels" / "server-admin.json"
        else:
            credential_path = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "citadels" / "server-admin.json"
        try:
            saved = json.loads(credential_path.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and isinstance(saved.get("username"), str) and saved.get("username") and \
                    isinstance(saved.get("password"), str) and saved.get("password"):
                return saved["username"], saved["password"]
        except (OSError, UnicodeError, json.JSONDecodeError):
            pass
        generated = {"username": "admin", "password": secrets.token_urlsafe(32),
                     "createdAt": datetime.now(timezone.utc).isoformat()}
        try:
            credential_path.parent.mkdir(parents=True, exist_ok=True)
            with credential_path.open("x", encoding="utf-8") as stream:
                json.dump(generated, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
            if os.name != "nt":
                credential_path.chmod(0o600)
        except FileExistsError:
            try:
                saved = json.loads(credential_path.read_text(encoding="utf-8"))
                if saved.get("username") and saved.get("password"):
                    return str(saved["username"]), str(saved["password"])
            except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
                pass
            raise RuntimeError("无法读取已存在的服务器控制台管理员凭据")
        except OSError as exc:
            raise RuntimeError("无法创建服务器控制台管理员凭据：" + str(exc)) from exc
        self.logs.append({"at": int(time.time() * 1000), "level": "info",
                          "text": "已生成服务器控制台管理员凭据，保存在 " + str(credential_path)})
        self.logs.append({"at": int(time.time() * 1000), "level": "info",
                          "text": "服务器控制台管理员账号：admin（密码只写入本机配置文件，不写入运行日志）"})
        return generated["username"], generated["password"]

    def _console_cors(self, headers: dict[str, str]) -> dict[str, str]:
        origin = headers.get("origin", "")
        if origin not in self.console_origins:
            return {}
        return {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600", "Vary": "Origin"}

    @staticmethod
    def _basic_credentials(headers: dict[str, str]) -> tuple[str, str] | None:
        authorization = headers.get("authorization", "")
        if not re.match(r"^Basic\s+", authorization, re.IGNORECASE):
            return None
        try:
            decoded = base64.b64decode(re.sub(r"^Basic\s+", "", authorization,
                                              flags=re.IGNORECASE), validate=True).decode("utf-8")
        except (ValueError, UnicodeError):
            return None
        if ":" not in decoded:
            return None
        return tuple(decoded.split(":", 1))

    def _admin_authenticated(self, headers: dict[str, str]) -> bool:
        if not self.admin_credentials:
            return False
        candidate = self._basic_credentials(headers)
        if not candidate:
            return False
        return (hmac.compare_digest(candidate[0].encode("utf-8"), self.admin_credentials[0].encode("utf-8"))
                and hmac.compare_digest(candidate[1].encode("utf-8"), self.admin_credentials[1].encode("utf-8")))

    def _voice_throttled(self, remote_ip: str) -> bool:
        now = time.time()
        if len(self.voice_token_hits) > 200:
            self.voice_token_hits = {key: item for key, item in self.voice_token_hits.items()
                                     if now <= item[1]}
        count, reset_at = self.voice_token_hits.get(remote_ip, (0, now + 60))
        if now > reset_at:
            count, reset_at = 0, now + 60
        if count >= 30:
            return True
        self.voice_token_hits[remote_ip] = (count + 1, reset_at)
        return False

    def _checkpoint_list(self) -> list[dict]:
        try:
            files = sorted((path for path in self.training_data_dir.iterdir()
                            if path.is_file() and re.fullmatch(
                                r"checkpoint-[A-Za-z0-9_-]+\.json\.gz", path.name)),
                           key=lambda path: path.name, reverse=True)
            return [{"name": path.name, "bytes": path.stat().st_size,
                     "mtimeMs": path.stat().st_mtime_ns // 1_000_000}
                    for path in files[:40]]
        except OSError:
            return []

    def _checkpoint_config(self, name: str) -> dict:
        if (not re.fullmatch(r"checkpoint-[A-Za-z0-9_-]+\.json\.gz", name)
                or Path(name).name != name):
            raise ValueError("存档名不合法，请刷新页面后重新选择")
        path = self.training_data_dir / name
        try:
            if path.stat().st_size > MAX_CHECKPOINT_BYTES:
                raise ValueError("存档超过 256 MB，拒绝读取")
            raw = _gunzip_limited(path.read_bytes())
            payload = json.loads(raw.decode("utf-8"))
        except FileNotFoundError as exc:
            raise ValueError("存档不存在，请刷新页面后重新选择") from exc
        except (OSError, EOFError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("存档无法解析（可能已损坏或不是本项目的 checkpoint）：" + str(exc)) from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("config"), dict):
            raise ValueError("该存档没有记录训练配置（可能是早期版本产物），无法读取参数")
        encoding = payload.get("encoding") or {}
        model = payload.get("model") or {}
        state_version = _positive_int(encoding.get("state")) or _positive_int(model.get("encodingVersion"))
        action_version = _positive_int(encoding.get("action"))
        return {"name": name, "game": _positive_int(payload.get("game")) or 0,
                "createdAt": payload.get("createdAt") or "", "config": payload["config"],
                "encodingVersion": state_version, "actionEncodingVersion": action_version,
                "encodingCompatible": _encoding_compatible(state_version, action_version)}

    def _import_checkpoint(self, original_name: str, body: bytes) -> dict:
        if not body:
            raise ValueError("选中的文件是空的")
        if len(body) > MAX_CHECKPOINT_BYTES:
            raise ValueError("文件超过 256 MB，不像是本项目的权重存档")
        try:
            payload = json.loads(_gunzip_limited(body).decode("utf-8"))
        except (OSError, EOFError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("无法解析：需要本项目导出的 .json.gz 存档：" + str(exc)) from exc
        if not isinstance(payload, dict) or not payload.get("model"):
            raise ValueError("文件里没有模型权重（缺少 model 字段），无法用于继续训练")
        raw_stem = Path(original_name.replace("\\", "/")).name
        stem = re.sub(r"\.json\.gz$", "", raw_stem, flags=re.IGNORECASE)
        stem = re.sub(r"\.gz$", "", stem, flags=re.IGNORECASE)
        stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:60]
        if not stem or stem == "checkpoint-":
            stem = "imported-" + time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        if not stem.startswith("checkpoint-"):
            stem = "checkpoint-" + stem
        self.training_data_dir.mkdir(parents=True, exist_ok=True)
        candidate = stem + ".json.gz"
        suffix = 2
        while (self.training_data_dir / candidate).exists():
            candidate = f"{stem}-{suffix}.json.gz"
            suffix += 1
        (self.training_data_dir / candidate).write_bytes(body)
        result = self._checkpoint_metadata(candidate, payload)
        result["renamed"] = candidate != raw_stem
        return result

    @staticmethod
    def _checkpoint_metadata(name: str, payload: dict) -> dict:
        encoding = payload.get("encoding") or {}
        model = payload.get("model") or {}
        state_version = _positive_int(encoding.get("state")) or _positive_int(model.get("encodingVersion"))
        action_version = _positive_int(encoding.get("action"))
        return {"name": name, "game": _positive_int(payload.get("game")) or 0,
                "createdAt": payload.get("createdAt") or "",
                "encodingVersion": state_version, "actionEncodingVersion": action_version,
                "encodingCompatible": _encoding_compatible(state_version, action_version)}

    def _state_for(self, room: dict, player_id: str | None) -> dict:
        if not room["state"]:
            view = lobby_view(room)
            view["voiceReady"] = self.voice.configured
            return view
        manager = self.native_worker_manager
        native_live = bool(manager and manager.running)
        if not native_live:
            raise RuntimeError("C++ 游戏引擎不可用，无法生成游戏视图")
        view = sanitize(room["state"], player_id,
                        legal_actions=[])
        view.update({"roomId": room["id"], "roomName": room["name"],
                     "hostId": room["seats"][0]["id"], "agentStatus": room.get("agentStatus"),
                     "voiceReady": self.voice.configured,
                     "voiceEnabled": room["config"].get("voice") is not False})
        if player_id:
            # The synchronous sanitizer cannot query the worker. Its async caller
            # fills this field from C++ before sending the view to a client.
            view["available"] = None
        else:
            view["available"] = None
        for player in view["players"]:
            seat = next((seat for seat in room["seats"] if seat["id"] == player["id"]), None)
            connected = any(client.id == player["id"] and client.room_id == room["id"]
                            for client in self.clients)
            player["connected"] = connected or bool(seat and seat["isBot"])
            player["disconnected"] = bool(seat and seat.get("disconnected"))
            player["left"] = bool(seat and seat.get("left"))
            if player["disconnected"] or player["left"]:
                player["isBot"] = False
        return view

    async def _state_for_client(self, room: dict, player_id: str | None) -> dict:
        """Build a client view, sourcing actionable choices from the native rules."""
        view = self._state_for(room, player_id)
        manager = self.native_worker_manager
        worker = manager.game_worker if manager and manager.running else None
        if not worker:
            if room.get("state"):
                raise RuntimeError("C++ 游戏引擎不可用，无法准备客户端游戏状态")
            return view
        if not player_id or not room.get("state"):
            return view
        # Always query native here: some action/reaction states are deliberately
        # not implemented in the Python presentation shim anymore.
        view["available"] = await self._bot_available_actions(room["state"], player_id)
        build_uids = {action.get("uid") for action in view["available"].get("actions", [])
                      if action.get("type") == "build"}
        for player in view.get("players", []):
            if player.get("id") == player_id:
                for card in player.get("hand", []):
                    card["canBuild"] = card.get("uid") in build_uids
        return view

    async def _apply_game_action(self, room: dict, player_id: str, action: dict) -> dict:
        """Apply live rules through the authoritative C++ game engine."""
        manager = self.native_worker_manager
        worker = manager.game_worker if manager and manager.running else None
        if worker is None:
            return {"ok": False, "error": "C++ 游戏引擎不可用，拒绝处理游戏行动"}
        async with self._native_action_lock:
            current = room.get("state")
            if not current:
                return {"ok": False, "error": "尚未开局"}
            try:
                native_state = await asyncio.to_thread(
                    worker.apply, game_id=str(room["id"]), player_id=player_id, action=action)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
            # A restart can replace the room state while the worker is processing.
            if room.get("state") is not current:
                return {"ok": False, "error": "房间状态已变化，请刷新后重试"}
            retained = {key: current[key] for key in
                        ("roomId", "config", "createdAt", "log", "notices", "noticeSeq", "witchResume")
                        if key in current}
            old_players = {player.get("id"): player for player in current.get("players", [])}
            for player in native_state.get("players", []):
                old = old_players.get(player.get("id"), {})
                if "mcts" in old:
                    player["mcts"] = old["mcts"]
                for key in ("disconnected", "left"):
                    if key in old:
                        player[key] = old[key]
            merged = {**retained, **native_state}
            self._append_gain_notices(current, merged, action)
            self._append_crown_transfer_notice(current, merged, action)
            self._append_marshal_seize_notice(current, merged, action)
            self._append_role_ability_notice(current, merged, player_id, action)
            self._append_magistrate_declare_notice(current, merged, player_id, action)
            self._append_role_effect_detail_notice(current, merged, player_id, action)
            state_log = merged.setdefault("log", [])
            actor = old_players.get(player_id, {})
            action_text = self._game_action_log_text(current, action, merged)
            state_log.append({"i": len(state_log),
                              "text": f"{actor.get('name') or player_id}：{action_text}",
                              "type": "info", "round": merged.get("round", 0)})
            for effect_player, effect_text in self._turn_effect_log_entries(current, merged):
                state_log.append({"i": len(state_log),
                                  "text": f"{effect_player}：{effect_text}",
                                  "type": "info", "round": merged.get("round", 0)})
            if len(state_log) > 400:
                del state_log[:-400]
            current.clear()
            current.update(merged)
            return {"ok": True}

    async def _broadcast_state(self, room: dict) -> None:
        for client in list(self.clients):
            if client.room_id == room["id"] and client.id:
                try:
                    state = await self._state_for_client(room, client.id)
                    await client.send({"t": "state", "state": state})
                except (ConnectionError, OSError):
                    pass

    async def _send_room_notice(self, room: dict, notice: dict, excluded_id: str | None = None) -> None:
        payload = {"t": "roomNotice", "notice": notice}
        for client in list(self.clients):
            if client.room_id == room["id"] and client.id and client.id != excluded_id:
                try:
                    await client.send(payload)
                except (ConnectionError, OSError):
                    pass

    def _bot_actor(self, state: dict) -> str | None:
        confirmation = state.get("roundConfirm")
        if confirmation:
            for index, confirmed in enumerate(confirmation["confirmed"]):
                player = state["players"][index]
                if not confirmed and player.get("isBot"):
                    return player["id"]
            return None
        if state["phase"] == "draft":
            draft = state["draft"]
            step = draft["steps"][draft["stepIdx"]] if draft["stepIdx"] < len(draft["steps"]) else None
            return state["players"][step["player"]]["id"] if step else None
        if state["phase"] == "action":
            reaction = state.get("reaction")
            if reaction:
                return state["players"][reaction["playerIdx"]]["id"]
            turn = state.get("turn")
            return state["players"][turn["playerIdx"]]["id"] if turn else None
        return None

    async def _bot_available_actions(self, state: dict, player_id: str) -> dict:
        manager = self.native_worker_manager
        worker = manager.game_worker if manager and manager.running else None
        if worker is None:
            raise RuntimeError("C++ 游戏引擎不可用，无法查询合法动作")
        native = await asyncio.to_thread(worker.legal_actions, game_id=str(state["roomId"]), player_id=player_id)
        actions = [self._native_action_view(state, action) for action in native["actions"]]
        prompt = self._native_prompt(state, player_id, actions)
        return {"phase": native["phase"], "actions": actions, "prompt": prompt}

    @staticmethod
    def _native_action_view(state: dict, action: dict) -> dict:
        rendered = dict(action)
        kind = action.get("type", "action")
        players = state.get("players", [])
        by_id = {player.get("id"): player for player in players}
        cards_by_uid = {card.get("uid"): card for player in players
                        for card in [*(player.get("hand") or []), *(player.get("city") or [])]}
        turn = state.get("turn") or {}
        role_id = turn.get("charId")
        turn_phase = turn.get("phase")
        labels = {"take_gold": "拿取金币", "take_cards": "抽取建筑牌", "income": "领取收入",
                  "end_turn": "结束回合", "confirm_round": "确认本轮战果", "build": "建造",
                  "ability": "发动角色能力", "ability_skip": "跳过", "artist_done": "完成美化",
                  "blackmailer_bribe": "支付贿金", "blackmailer_refuse": "拒绝支付贿金",
                  "choose_cards": "确认选择", "choose_player": "选择玩家",
                  "choose_district": "选择建筑", "choose_char": "选择角色", "draft_pick": "选取角色",
                  "draft_discard": "弃置角色", "reaction": "响应", "lab": "使用实验室",
                  "museum": "使用博物馆", "smithy": "使用铁匠铺", "pending_back": "返回上一步",
                  "magician_mode": "选择魔术师能力", "wizard_target": "选择查看对象",
                  "wizard_take": "取得1张手牌", "wizard_build": "建造", "wizard_card": "选择卡牌",
                  "draw_keep": "保留建筑牌", "scholar_pick": "选择建筑牌", "prophet_give": "归还手牌",
                  "emperor_take": "选择资源", "emperor_crown": "移交皇冠", "tax_collect": "收取建筑税",
                  "spy_target": "调查玩家", "spy_color": "选择调查类型", "navigator_bonus": "选择奖励",
                  "magistrate_signed": "指定真逮捕令角色", "magistrate_char": "选择逮捕令候选角色",
                  "blackmailer_signed": "指定真威胁目标角色", "blackmailer_char": "选择威胁标记角色",
                  "abbot_resource": "分配住持资源", "monk_resource": "分配僧侣资源",
                  "monk_take": "从最富有玩家处拿取1枚金币"}
        if kind in ("draft_pick", "draft_discard"):
            role = cards.CHAR_MAP.get(action.get("charId") or "", {})
            label = ("选取 " if kind == "draft_pick" else "弃置 ") + role.get("name", action.get("charId", "角色"))
        elif kind == "reaction":
            label = "发动" if action.get("use") else "不发动"
        elif kind in ("build", "wizard_build"):
            district = cards_by_uid.get(action.get("uid"), {})
            if not district and kind == "wizard_build":
                district = (turn.get("pending") or {}).get("card") or {}
            cost = district.get("cost")
            cost_label = f"（造价 {cost} 金币）" if isinstance(cost, int) else ""
            label = f"建造『{district.get('name') or action.get('name') or '建筑'}』{cost_label}"
        elif kind == "take_gold":
            amount = 2 + int(role_id == "merchant" and turn_phase != "witch_resume")
            detail = "，建筑师额外抽2张建筑牌" if role_id == "architect" and turn_phase != "witch_resume" else ""
            label = f"拿取金币（{amount} 枚{detail}）"
        elif kind == "take_cards":
            active = players[turn.get("playerIdx", -1)] if isinstance(turn.get("playerIdx"), int) and 0 <= turn.get("playerIdx", -1) < len(players) else {}
            city = active.get("city") or []
            effects = {card.get("purpleEffect") or (card.get("purple") or {}).get("effect") for card in city}
            amount = 3 if "draw3keep1" in effects else 2
            detail = "，保留1张" if amount == 3 else "，全部保留" if "keepBoth" in effects else ""
            if role_id == "architect" and turn_phase != "witch_resume":
                detail += "，建筑师额外抽2张"
            if role_id == "merchant" and turn_phase != "witch_resume":
                detail += "，另得1金币"
            label = f"抽取建筑牌（{amount} 张{detail}）"
        elif kind == "income":
            active = players[turn.get("playerIdx", -1)] if isinstance(turn.get("playerIdx"), int) and 0 <= turn.get("playerIdx", -1) < len(players) else {}
            city = active.get("city") or []
            if role_id == "bishop":
                amount = sum(1 for card in city if card.get("color") == "blue" or
                             (card.get("purpleEffect") or (card.get("purple") or {}).get("effect")) == "anyColorIncome")
                label = f"领取收入（抽取 {amount} 张建筑牌）"
            else:
                colors = {"king": "yellow", "emperor": "yellow", "abbot": "blue",
                          "merchant": "green", "businessman": "green", "warlord": "red",
                          "diplomat": "red", "marshal": "red"}
                color = colors.get(role_id)
                amount = sum(1 for card in city if card.get("color") == color or
                             (card.get("purpleEffect") or (card.get("purple") or {}).get("effect")) == "anyColorIncome") if color else 0
                label = f"领取收入（{amount} 金币）"
        elif kind in ("lab", "museum"):
            district = cards_by_uid.get(action.get("secondaryUid") or
                                        action.get("discardUid") or action.get("cardUid"), {})
            label = f"{labels[kind]}：{district.get('name', '选择手牌')}"
        elif kind in ("choose_player", "emperor_crown", "spy_target", "wizard_target"):
            target = by_id.get(action.get("target"), {})
            seat = target.get("seat")
            seat_label = f"座位 {seat + 1} · " if isinstance(seat, int) else ""
            label = seat_label + target.get("name", labels[kind])
        elif kind in ("choose_char", "magistrate_signed", "magistrate_char",
                      "blackmailer_signed", "blackmailer_char"):
            try:
                number = int(action.get("num", action.get("name")))
            except (TypeError, ValueError):
                number = 0
            role = next((item for item in cards.CHAR_MAP.values() if item.get("num") == number), {})
            label = f"{number}号 · {role.get('name', '角色')}" if number else labels.get(kind, kind)
            if kind == "magistrate_signed":
                label = "真逮捕令 · " + label
            elif kind == "magistrate_char":
                label = "逮捕令候选 · " + label
            elif kind == "blackmailer_signed":
                label = "真威胁目标 · " + label
            elif kind == "blackmailer_char":
                label = "威胁标记候选 · " + label
        elif kind in ("abbot_resource", "monk_resource"):
            label = f"金币 {action.get('gold', 0)} · 建筑牌 {action.get('cards', 0)}"
        elif kind == "spy_color":
            color_names = {"yellow": "黄色", "blue": "蓝色", "green": "绿色",
                           "red": "红色", "purple": "紫色"}
            label = color_names.get(action.get("color"), labels[kind])
        elif kind == "navigator_bonus":
            mode = action.get("name") or action.get("mode")
            label = {"gold": "拿取金币（4 枚）", "cards": "抽取建筑牌（4 张）"}.get(mode, labels[kind])
        elif kind == "choose_district":
            target = by_id.get(action.get("target"), {})
            district = cards_by_uid.get(action.get("uid"), {})
            label = f"座位 {target.get('seat', 0) + 1} · {target.get('name', '玩家')}：{district.get('name', '选择建筑')}"
        elif kind == "choose_cards" and (action.get("mode") or action.get("name")) in ("skip", "use"):
            label = "保留这张手牌" if (action.get("mode") or action.get("name")) == "skip" else "弃掉这张手牌"
        elif kind in ("draw_keep", "scholar_pick"):
            district = cards_by_uid.get(action.get("uid"), {})
            label = district.get("name", labels[kind])
        elif kind in ("emperor_take", "magician_mode"):
            label = {"gold": "拿取1枚金币", "card": "取得1张手牌", "swap": "交换手牌", "redraw": "弃牌重抽"}.get(
                action.get("mode") or action.get("name"), labels[kind])
        else:
            label = labels.get(kind, kind.replace("_", " "))
        rendered["label"] = label
        return rendered

    @staticmethod
    def _append_gain_notices(previous: dict, updated: dict, action: dict) -> None:
        """Restore public gain events consumed by the browser's coin/card flights."""
        old_players = previous.get("players") or []
        new_players = updated.get("players") or []
        size = min(len(old_players), len(new_players))
        gold_delta = [int((new_players[i].get("gold") or 0)) -
                      int((old_players[i].get("gold") or 0)) for i in range(size)]
        hand_delta = [len(new_players[i].get("hand") or []) -
                      len(old_players[i].get("hand") or []) for i in range(size)]

        def source_for(deltas: list[int], recipient: int) -> int | None:
            sources = [i for i, delta in enumerate(deltas) if delta < 0 and i != recipient]
            return sources[0] if len(sources) == 1 else None

        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = int(updated.get("noticeSeq") or previous.get("noticeSeq") or 0)

        def append(kind: str, player_idx: int, amount: int, from_idx: int | None = None) -> None:
            nonlocal seq
            if amount <= 0:
                return
            seq += 1
            notice = {"seq": seq, "kind": kind, "playerIdx": player_idx, "amount": amount}
            if from_idx is not None:
                notice["fromIdx"] = from_idx
            if kind == "hand_gain":
                notice["why"] = "获得手牌"
            notices.append(notice)

        for i, amount in enumerate(gold_delta):
            if amount > 0:
                append("got_gold", i, amount, source_for(gold_delta, i))
        for i, amount in enumerate(hand_delta):
            if amount > 0:
                append("hand_gain", i, amount, source_for(hand_delta, i))

        # The Magician redraw replaces cards one-for-one, so a player can gain
        # new cards with no net hand-size change. Emit the final redraw animation.
        old_turn = previous.get("turn") or {}
        pending = old_turn.get("pending") or {}
        mode = action.get("mode") or action.get("name")
        new_pending = ((updated.get("turn") or {}).get("pending") or {}).get("kind")
        if (action.get("type") == "choose_cards" and pending.get("kind") == "magician_redraw" and
                mode in ("skip", "use") and new_pending != "magician_redraw"):
            player_idx = int(old_turn.get("playerIdx", 0))
            amount = len(pending.get("selected") or []) + int(mode == "use")
            if amount and (player_idx >= size or hand_delta[player_idx] <= 0):
                append("hand_gain", player_idx, amount)

        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _append_crown_transfer_notice(previous: dict, updated: dict,
                                     action: dict) -> None:
        """Emit the public animation event when the Emperor hands off the crown."""
        if action.get("type") != "emperor_crown":
            return
        old_turn = previous.get("turn") or {}
        from_idx = old_turn.get("playerIdx")
        target_id = action.get("target")
        to_idx = PythonServer._player_index(previous, target_id)
        players = updated.get("players") or []
        if (not isinstance(from_idx, int) or to_idx is None or
                not (0 <= from_idx < len(players)) or not (0 <= to_idx < len(players)) or
                not players[to_idx].get("hasCrown")):
            return
        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = max(int(updated.get("noticeSeq") or 0),
                  int(previous.get("noticeSeq") or 0)) + 1
        notices.append({"seq": seq, "kind": "crown_transfer",
                        "fromIdx": from_idx, "toIdx": to_idx})
        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _append_marshal_seize_notice(previous: dict, updated: dict,
                                     action: dict) -> None:
        """Emit a public event for the Marshal's building-transfer animation."""
        pending = ((previous.get("turn") or {}).get("pending") or {})
        if action.get("type") != "choose_district" or pending.get("kind") != "marshal_seize":
            return
        old_players = previous.get("players") or []
        new_players = updated.get("players") or []
        from_idx = PythonServer._player_index(previous, action.get("target"))
        to_idx = (previous.get("turn") or {}).get("playerIdx")
        if (from_idx is None or not isinstance(to_idx, int) or
                not (0 <= from_idx < len(old_players)) or not (0 <= to_idx < len(new_players))):
            return
        card = next((item for item in old_players[from_idx].get("city") or []
                     if item.get("uid") == action.get("uid")), None)
        arrived = any(item.get("uid") == action.get("uid")
                      for item in new_players[to_idx].get("city") or [])
        if not card or not arrived:
            return
        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = max(int(updated.get("noticeSeq") or 0),
                  int(previous.get("noticeSeq") or 0)) + 1
        notices.append({
            "seq": seq, "kind": "seized", "playerIdx": from_idx, "byIdx": to_idx,
            "playerId": old_players[from_idx].get("id"),
            "byId": old_players[to_idx].get("id"),
            "playerName": old_players[from_idx].get("name") or "玩家",
            "byName": old_players[to_idx].get("name") or "元帅",
            "cardUid": card.get("uid"), "cardName": card.get("name") or "建筑",
            "cost": card.get("cost", 0),
        })
        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _append_role_ability_notice(previous: dict, updated: dict,
                                    player_id: str, action: dict) -> None:
        """Recreate the public ability popup omitted by the native engine protocol."""
        if action.get("type") != "ability":
            return
        turn = previous.get("turn") or {}
        role_id = turn.get("charId")
        if not isinstance(role_id, str):
            return
        role = cards.CHAR_MAP.get(role_id or "", {})
        if not role:
            return
        # These abilities resolve through a later target/choice action. Their
        # informative popup is emitted at that point, once the object is known.
        if role_id in {"assassin", "witch", "magistrate", "thief", "spy",
                       "blackmailer", "magician", "wizard", "emperor", "bishop",
                       "diplomat", "warlord", "marshal"}:
            return
        players = previous.get("players") or []
        player_idx = next((i for i, player in enumerate(players)
                           if player.get("id") == player_id), None)
        if player_idx is None:
            return
        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = max(int(updated.get("noticeSeq") or 0), int(previous.get("noticeSeq") or 0)) + 1
        notices.append({"seq": seq, "kind": "role_effect", "playerIdx": player_idx,
                        "playerName": players[player_idx].get("name") or "玩家",
                        "roleName": role.get("name") or "角色",
                        "description": role.get("desc") or "发动了角色能力。"})
        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _player_label(state: dict, index: int | None) -> str:
        players = state.get("players") or []
        if not isinstance(index, int) or not 0 <= index < len(players):
            return "其他玩家"
        player = players[index]
        seat = player.get("seat", index)
        seat_label = f"座位{seat + 1}·" if isinstance(seat, int) else ""
        return f"{seat_label}{player.get('name') or '玩家'}"

    @staticmethod
    def _player_index(state: dict, player_id: str | None) -> int | None:
        return next((i for i, player in enumerate(state.get("players") or [])
                     if player.get("id") == player_id), None)

    @classmethod
    def _append_role_effect_detail_notice(cls, previous: dict, updated: dict,
                                          player_id: str, action: dict) -> None:
        """Announce targeted role effects after their public target is committed."""
        kind = action.get("type")
        turn = previous.get("turn") or {}
        pending = turn.get("pending") or {}
        role_id = turn.get("charId")
        if not isinstance(role_id, str):
            role_id = None
        role = cards.CHAR_MAP.get(role_id or "", {})
        description = None
        if kind in ("assassin_declare", "thief_declare", "witch_declare"):
            try:
                number = int(action.get("num", action.get("name")))
            except (TypeError, ValueError):
                number = 0
            target = next((item for item in cards.CHAR_MAP.values()
                           if item.get("num") == number), {})
            target_name = f"{number}号【{target.get('name') or '角色'}】"
            effects = {
                "assassin_declare": f"刺杀目标为{target_name}，该角色本轮被叫到时跳过整个回合。",
                "thief_declare": f"偷窃目标为{target_name}，该角色本轮被叫到并公开时交出全部金币。",
                "witch_declare": f"施咒目标为{target_name}，该角色本轮只能领取资源，随后由女巫接管剩余行动。",
            }
            description = effects[kind]
            role_id = {"assassin_declare": "assassin", "thief_declare": "thief",
                       "witch_declare": "witch"}[kind]
            role = cards.CHAR_MAP[role_id]
        elif kind == "spy_color" and role_id == "spy":
            target_idx = pending.get("targetIdx")
            color = action.get("color")
            color_names = {"yellow": "皇家（黄色）", "blue": "宗教（蓝色）",
                           "green": "商业（绿色）", "red": "军事（红色）",
                           "purple": "独特（紫色）"}
            actor_idx = cls._player_index(previous, player_id)
            old_players, new_players = previous.get("players") or [], updated.get("players") or []
            gold = cards_gained = 0
            if actor_idx is not None and actor_idx < len(new_players) and actor_idx < len(old_players):
                gold = max(0, int(new_players[actor_idx].get("gold") or 0) -
                           int(old_players[actor_idx].get("gold") or 0))
                cards_gained = max(0, len(new_players[actor_idx].get("hand") or []) -
                                   len(old_players[actor_idx].get("hand") or []))
            target_label = cls._player_label(previous, target_idx)
            description = (f"调查对象：{target_label}；建筑类型：{color_names.get(color, '指定类型')}。"
                           f"间谍实际获得 {gold} 枚金币和 {cards_gained} 张建筑牌（不公开牌面）。")
        elif kind == "emperor_crown" and role_id == "emperor":
            target_idx = cls._player_index(previous, action.get("target"))
            description = f"皇冠移交对象：{cls._player_label(previous, target_idx)}。随后皇帝从新皇冠持有者处取得1枚金币或1张建筑牌。"
        elif kind == "emperor_take" and role_id == "emperor":
            target_idx = pending.get("targetIdx")
            mode = action.get("mode") or action.get("name")
            resource = "1枚金币" if mode == "gold" else "1张建筑牌"
            description = f"皇帝从新皇冠持有者{cls._player_label(previous, target_idx)}处取得了{resource}。"
        elif kind == "wizard_target" and role_id == "wizard":
            target_idx = cls._player_index(previous, action.get("target"))
            description = f"法师选择查看{cls._player_label(previous, target_idx)}的手牌；具体牌面仅对法师可见。"
        elif kind == "choose_player" and pending.get("kind") in ("magician_swap", "bishop_payer"):
            target_idx = cls._player_index(previous, action.get("target"))
            target_label = cls._player_label(previous, target_idx)
            if pending.get("kind") == "magician_swap":
                description = f"魔术师选择与{target_label}交换全部手牌。"
                role_id = "magician"
            else:
                description = f"主教指定{target_label}为建筑费用差额的代付者。"
                role_id = "bishop"
            role = cards.CHAR_MAP[role_id]
        elif kind == "choose_district" and pending.get("kind") in (
                "diplomat_mine", "diplomat_theirs", "warlord_destroy", "marshal_seize"):
            target_idx = cls._player_index(previous, action.get("target"))
            target_label = cls._player_label(previous, target_idx)
            district = next((card for player in previous.get("players", [])
                             for card in [*(player.get("hand") or []), *(player.get("city") or [])]
                             if card.get("uid") == action.get("uid")), {})
            district_name = district.get("name") or "所选建筑"
            mode = pending.get("kind")
            if mode == "diplomat_theirs":
                description = f"外交官选择从{target_label}处交换『{district_name}』。"
                role_id = "diplomat"
            elif mode == "diplomat_mine":
                description = f"外交官选择自己的建筑『{district_name}』作为交换筹码。"
                role_id = "diplomat"
            elif mode == "warlord_destroy":
                description = f"领主选择摧毁{target_label}的建筑『{district_name}』。"
                role_id = "warlord"
            else:
                description = f"元帅选择从{target_label}处抢夺建筑『{district_name}』。"
                role_id = "marshal"
            role = cards.CHAR_MAP[role_id]
        elif kind == "choose_char" and pending.get("kind") in (
                "assassin", "thief", "witch_target"):
            try:
                number = int(action.get("num", action.get("name")))
            except (TypeError, ValueError):
                number = 0
            target = next((item for item in cards.CHAR_MAP.values()
                           if item.get("num") == number), {})
            target_name = f"{number}号【{target.get('name') or '角色'}】"
            pending_role = pending.get("kind")
            if pending_role == "assassin":
                role_id = "assassin"
                description = f"刺客宣告刺杀目标：{target_name}；该角色本轮被叫到时跳过整个回合。"
            elif pending_role == "thief":
                role_id = "thief"
                description = f"盗贼宣告偷窃目标：{target_name}；该角色本轮被叫到并公开时交出全部金币。"
            else:
                role_id = "witch"
                description = f"女巫宣告施咒目标：{target_name}；该角色本轮只能领取资源，随后由女巫接管剩余行动。"
            role = cards.CHAR_MAP[role_id]
        elif kind == "blackmailer_signed" and role_id == "blackmailer":
            targets = PythonServer._magistrate_targets(pending.get("nums") or [])
            if len(targets) == 2:
                names = "、".join(f"{item['num']}号【{item['name']}】" for item in targets)
                description = f"勒索者把两个威胁标记分配给{names}；真威胁标记对应的目标暂不公开。"
        if not description:
            return
        actor_idx = cls._player_index(previous, player_id)
        if actor_idx is None:
            return
        players = previous.get("players") or []
        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = max(int(updated.get("noticeSeq") or 0),
                  int(previous.get("noticeSeq") or 0)) + 1
        notices.append({"seq": seq, "kind": "role_effect_detail",
                        "playerIdx": actor_idx,
                        "playerName": players[actor_idx].get("name") or "玩家",
                        "roleName": role.get("name") or "角色",
                        "description": description})
        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _magistrate_targets(nums: list) -> list[dict]:
        targets = []
        for value in nums:
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            character = next((item for item in cards.CHAR_MAP.values()
                              if item.get("num") == number), {})
            targets.append({"num": number,
                            "name": character.get("name") or f"{number}号角色"})
        return targets

    @classmethod
    def _append_magistrate_declare_notice(cls, previous: dict, updated: dict,
                                          player_id: str, action: dict) -> None:
        """Announce all public warrant targets only after the third choice is committed."""
        if action.get("type") != "magistrate_char":
            return
        old_effect = (previous.get("effects") or {}).get("magistrate")
        warrant = (updated.get("effects") or {}).get("magistrate")
        if not warrant or warrant == old_effect:
            return
        nums = warrant.get("nums") or []
        targets = cls._magistrate_targets(nums)
        if len(targets) != 3:
            return
        players = previous.get("players") or []
        player_idx = next((i for i, player in enumerate(players)
                           if player.get("id") == player_id), None)
        if player_idx is None:
            return
        notices = updated.setdefault("notices", list(previous.get("notices") or []))
        seq = max(int(updated.get("noticeSeq") or 0),
                  int(previous.get("noticeSeq") or 0)) + 1
        notices.append({"seq": seq, "kind": "magistrate_declare",
                        "byId": player_id, "byIdx": player_idx,
                        "byName": players[player_idx].get("name") or "行政官",
                        "targets": targets, "nums": [target["num"] for target in targets]})
        updated["noticeSeq"] = seq
        updated["notices"] = notices[-12:]

    @staticmethod
    def _turn_effect_log_entries(previous: dict, updated: dict) -> list[tuple[str, str]]:
        """Describe assassination skips and the thief transfer as called roles resolve."""
        old_idx = previous.get("callIdx")
        new_idx = updated.get("callIdx")
        queue = previous.get("callQueue") or []
        players = previous.get("players") or []
        if (not isinstance(old_idx, int) or not isinstance(new_idx, int) or
                new_idx <= old_idx or not isinstance(queue, list)):
            return []
        effects = previous.get("effects") or {}
        assassinated = effects.get("assassinated")
        thief_target = effects.get("thief")
        thief_idx = effects.get("thiefBy")
        entries: list[tuple[str, str]] = []
        for queue_idx in range(max(0, old_idx + 1), min(new_idx + 1, len(queue))):
            entry = queue[queue_idx]
            number = entry.get("num")
            player_idx = entry.get("playerIdx")
            if not isinstance(player_idx, int) or not 0 <= player_idx < len(players):
                continue
            player_name = players[player_idx].get("name") or "玩家"
            role = cards.CHAR_MAP.get(entry.get("charId") or {}, {})
            role_name = role.get("name") or f"{number}号角色"
            if number == assassinated:
                entries.append((player_name,
                                f"被刺杀效果生效：{number}号【{role_name}】被叫到，跳过本轮（未领取资源、建造或发动能力）。"))
                continue
            if number == thief_target and isinstance(thief_idx, int) and 0 <= thief_idx < len(players):
                old_gold = int((previous.get("players") or [])[player_idx].get("gold") or 0)
                new_players = updated.get("players") or []
                new_gold = int(new_players[player_idx].get("gold") or 0) if player_idx < len(new_players) else old_gold
                amount = max(0, old_gold - new_gold)
                thief_name = players[thief_idx].get("name") or "盗贼"
                if amount:
                    entries.append((player_name,
                                    f"盗贼效果结算：你被叫到时交出全部 {amount} 枚金币，转给{thief_name}。"))
                else:
                    entries.append((player_name,
                                    f"盗贼效果结算：你被叫到时身上没有金币，因此未发生转移；盗贼是{thief_name}。"))
        return entries

    @staticmethod
    def _game_action_log_text(state: dict, action: dict,
                              updated: dict | None = None) -> str:
        """Readable public log text; never expose hidden cards or secret role marks."""
        kind = action.get("type", "")
        turn = state.get("turn") or {}
        pending = turn.get("pending") or {}
        if kind == "tax_collect":
            amount = max(0, int((state.get("effects") or {}).get("taxCollectorGold") or 0))
            return f"税务官收取了{amount}枚建筑税"
        if kind in ("draft_pick", "draft_discard"):
            return "选取了一个角色" if kind == "draft_pick" else "弃置了一个角色"
        if kind in ("assassin_declare", "thief_declare", "witch_declare"):
            role_names = {"assassin_declare": "刺客", "thief_declare": "盗贼",
                          "witch_declare": "女巫"}
            try:
                number = int(action.get("num", action.get("name")))
            except (TypeError, ValueError):
                number = 0
            character = next((item for item in cards.CHAR_MAP.values()
                              if item.get("num") == number), {})
            target = f"{number}号·{character.get('name', '角色')}" if number else "目标角色"
            verb = {"assassin_declare": "宣布刺杀", "thief_declare": "宣布偷窃",
                    "witch_declare": "施咒"}[kind]
            outcome = {"assassin_declare": "该角色本轮被叫到时将跳过整个回合",
                       "thief_declare": "该角色本轮被叫到并公开时将把全部金币交给盗贼",
                       "witch_declare": "该角色本轮被叫到时只能领取资源，随后由女巫接管剩余行动"}[kind]
            return f"【{role_names[kind]}】{verb}{target}；{outcome}。"
        if kind == "choose_char" and pending.get("kind") in (
                "assassin", "thief", "witch_target"):
            try:
                number = int(action.get("num", action.get("name")))
            except (TypeError, ValueError):
                number = 0
            character = next((item for item in cards.CHAR_MAP.values()
                              if item.get("num") == number), {})
            target = f"{number}号·{character.get('name') or '角色'}"
            if pending["kind"] == "assassin":
                return f"【刺客】宣布刺杀{target}；该角色本轮被叫到时跳过整个回合。"
            if pending["kind"] == "thief":
                return f"【盗贼】宣布偷窃{target}；该角色本轮被叫到并公开时交出全部金币。"
            return f"【女巫】对{target}施咒；该角色本轮只能领取资源，随后由女巫接管剩余行动。"
        if kind in ("magistrate_signed", "magistrate_char"):
            warrant = ((updated or {}).get("effects") or {}).get("magistrate")
            if (kind == "magistrate_char" and warrant and
                    warrant != (state.get("effects") or {}).get("magistrate")):
                targets = PythonServer._magistrate_targets(warrant.get("nums") or [])
                if len(targets) == 3:
                    names = "、".join(f"{item['num']}号·{item['name']}" for item in targets)
                    return f"为{names}布置了逮捕令（真逮捕令的目标暂不公开）。"
            return "布置了行政官逮捕令"
        if kind in ("blackmailer_signed", "blackmailer_char"):
            return "布置了勒索威胁标记"
        if kind in ("wizard_target", "wizard_card", "wizard_take"):
            if kind == "wizard_target":
                target_idx = PythonServer._player_index(state, action.get("target"))
                return f"法师选择查看{PythonServer._player_label(state, target_idx)}的手牌（牌面不公开）"
            if kind == "wizard_card":
                return "法师从查看的手牌中选定一张建筑牌"
            return "法师取得了1张建筑牌"
        if kind == "spy_target":
            target_idx = PythonServer._player_index(state, action.get("target"))
            return f"间谍选择调查对象：{PythonServer._player_label(state, target_idx)}"
        if kind == "spy_color":
            pending_target = pending.get("targetIdx")
            target_name = PythonServer._player_label(state, pending_target)
            color_names = {"yellow": "皇家（黄色）", "blue": "宗教（蓝色）",
                           "green": "商业（绿色）", "red": "军事（红色）",
                           "purple": "独特（紫色）"}
            actor_idx = (state.get("turn") or {}).get("playerIdx")
            old_players = state.get("players") or []
            new_players = (updated or {}).get("players") or []
            gold = cards_gained = 0
            if actor_idx is not None and actor_idx < len(old_players) and actor_idx < len(new_players):
                gold = max(0, int(new_players[actor_idx].get("gold") or 0) -
                           int(old_players[actor_idx].get("gold") or 0))
                cards_gained = max(0, len(new_players[actor_idx].get("hand") or []) -
                                   len(old_players[actor_idx].get("hand") or []))
            return (f"间谍调查{target_name}的{color_names.get(action.get('color'), '指定类型')}建筑牌；"
                    f"实际获得{gold}枚金币、{cards_gained}张建筑牌（牌面不公开）")
        if kind == "emperor_crown":
            target_idx = PythonServer._player_index(state, action.get("target"))
            return f"皇帝将皇冠交给{PythonServer._player_label(state, target_idx)}"
        if kind == "emperor_take":
            target_idx = pending.get("targetIdx")
            resource = "1枚金币" if action.get("mode") == "gold" else "1张建筑牌"
            return f"皇帝从新皇冠持有者{PythonServer._player_label(state, target_idx)}处取得{resource}"
        if kind == "choose_player" and pending.get("kind") in ("magician_swap", "bishop_payer"):
            target_idx = PythonServer._player_index(state, action.get("target"))
            target = PythonServer._player_label(state, target_idx)
            if pending.get("kind") == "magician_swap":
                return f"魔术师选择与{target}交换全部手牌"
            amount = int(pending.get("amount") or 0)
            return f"主教指定{target}代付建筑费用差额（{amount}金币）"
        if kind == "choose_district" and pending.get("kind") in (
                "diplomat_mine", "diplomat_theirs", "warlord_destroy", "marshal_seize"):
            target_idx = PythonServer._player_index(state, action.get("target"))
            target = PythonServer._player_label(state, target_idx)
            district = next((card for player in state.get("players", [])
                             for card in [*(player.get("hand") or []), *(player.get("city") or [])]
                             if card.get("uid") == action.get("uid")), {})
            name = district.get("name") or "所选建筑"
            mode = pending.get("kind")
            return {
                "diplomat_mine": f"外交官选择自己的建筑『{name}』作为交换筹码",
                "diplomat_theirs": f"外交官从{target}处交换建筑『{name}』",
                "warlord_destroy": f"领主摧毁了{target}的建筑『{name}』",
                "marshal_seize": f"元帅从{target}处抢得建筑『{name}』",
            }[mode]
        if kind in ("draw_keep", "scholar_pick"):
            return "保留了1张建筑牌" if kind == "draw_keep" else "选取了1张建筑牌"
        if kind == "prophet_give":
            return "归还了1张手牌"
        if kind == "choose_cards":
            mode = action.get("mode") or action.get("name")
            if mode in ("skip", "use"):
                return "保留了当前手牌" if mode == "skip" else "弃掉当前手牌"
            uids = action.get("uids") or action.get("selectedUids") or []
            count = len(uids) if isinstance(uids, list) else 0
            if pending.get("kind") == "bishop_repay":
                return f"选择了{count}张手牌偿还主教代偿"
            if pending.get("kind") == "magician_redraw":
                return f"弃掉了{count}张手牌并重抽"
            return f"选择了{count}张手牌"
        if kind == "ability":
            role = cards.CHAR_MAP.get(turn.get("charId") or {}, {})
            role_name = role.get("name") or turn.get("charName") or "角色"
            description = role.get("desc")
            return f"发动了【{role_name}】能力：{description}" if description else f"发动了【{role_name}】能力"
        if kind == "spy_target":
            return "选择了调查对象"
        if kind == "lab":
            return "使用了实验室"
        if kind == "museum":
            return "使用了博物馆"
        return PythonServer._native_action_view(state, action).get("label", "进行了行动")

    @staticmethod
    def _native_prompt(state: dict, player_id: str, actions: list[dict]) -> str:
        if state.get("reaction"):
            return state["reaction"].get("prompt") or "请选择是否响应"
        if state.get("roundConfirm"):
            confirmation = state["roundConfirm"]
            done = sum(bool(value) for value in confirmation.get("confirmed", []))
            return f"第 {confirmation.get('round', state.get('round', 0))} 轮结束（已确认 {done}/{len(state.get('players', []))}）"
        if state.get("phase") == "draft":
            current_id = (state.get("draft") or {}).get("currentPlayer")
            if current_id and current_id != player_id:
                current = next((item for item in state.get("players", []) if item.get("id") == current_id), {})
                return f"等待 {current.get('name', '其他玩家')} 选择角色…"
            return "选择角色" if actions else "等待其他玩家选择角色…"
        turn = state.get("turn") or {}
        active_id = turn.get("playerId")
        if active_id is None and isinstance(turn.get("playerIdx"), int):
            players = state.get("players", [])
            index = turn["playerIdx"]
            active_id = players[index].get("id") if 0 <= index < len(players) else None
        if active_id and active_id != player_id:
            active = next((item for item in state.get("players", []) if item.get("id") == active_id), {})
            return f"等待 {active.get('name', '其他玩家')} 行动…"
        pending = turn.get("pending") or {}
        prompts = {"assassin": "选择要刺杀的角色", "thief": "选择要偷窃的角色",
                   "witch_target": "选择要施咒的角色", "wizard_target": "选择要查看的玩家",
                   "spy_target": "选择要调查的玩家", "spy_color": "选择要调查的建筑颜色",
                   "wizard_card": "选择要取得的建筑牌",
                   "draw_keep": "选择要保留的建筑牌", "scholar_pick": "选择一张建筑牌",
                   "bishop_payer": "选择承担主教代偿的玩家",
                   "bishop_repay": "选择偿还代偿的手牌", "magician_choice": "选择魔术师能力",
                   "magician_swap": "选择交换手牌的玩家", "magician_redraw": "选择要弃掉的手牌",
                   "emperor_crown": "选择接收皇冠的玩家", "emperor_take": "选择拿取金币或手牌",
                   "magistrate_declare": "指定真逮捕令角色",
                   "magistrate_second": "选择逮捕令候选角色",
                   "magistrate_third": "选择逮捕令候选角色",
                   "blackmailer_declare": "选择威胁标记角色",
                   "blackmailer_second": "选择第二个威胁标记角色",
                   "blackmailer_signed": "指定真威胁目标角色",
                   "abbot_declare": "分配住持的金币与建筑牌",
                   "monk_declare": "分配僧侣的金币与建筑牌",
                   "navigator_bonus": "选择额外奖励",
                   "artist": "选择要美化的建筑", "warlord_destroy": "选择要摧毁的建筑",
                   "marshal_seize": "选择要抢夺的建筑", "diplomat_mine": "选择自己的建筑",
                   "diplomat_theirs": "选择对方的建筑"}
        return prompts.get(pending.get("kind"), "请选择行动")

    def _schedule_bot(self, room: dict) -> None:
        old_task = room.get("botTask")
        if old_task and not old_task.done():
            return
        state = room.get("state")
        actor_id = self._bot_actor(state) if state else None
        actor = next((p for p in state["players"] if p["id"] == actor_id), None) if actor_id else None
        if not actor or not actor.get("isBot") or actor.get("botType", "npc") not in ("npc", "agent", "neural"):
            return

        async def run_turns() -> None:
            while room.get("state") is state and state["phase"] != "gameover":
                actor_id_now = self._bot_actor(state)
                actor_now = next((p for p in state["players"] if p["id"] == actor_id_now), None)
                if (not actor_now or not actor_now.get("isBot") or
                        actor_now.get("botType", "npc") not in ("npc", "agent", "neural")):
                    break
                if ((room.get("agentStatus") or {}).get("state") == "error" and
                        room["agentStatus"].get("playerId") == actor_now["id"] and
                        not state.get("roundConfirm")):
                    break
                await asyncio.sleep(max(0, int(room["config"].get("botPace") or 0)) / 1000)
                available = await self._bot_available_actions(state, actor_now["id"])
                if state.get("roundConfirm"):
                    action = next((item for item in available.get("actions", [])
                                   if item.get("type") == "confirm_round" and
                                   not item.get("disabled")), None)
                elif actor_now.get("botType", "npc") == "agent":
                    if not self._agent_status()["configured"]:
                        room["agentStatus"] = {"playerId": actor_now["id"], "state": "error",
                                                "model": self._agent_status().get("model", ""),
                                                "message": self._agent_status()["message"]}
                        await self._broadcast_state(room)
                        break
                    room["agentStatus"] = {"playerId": actor_now["id"], "state": "thinking",
                                            "model": self._agent_status()["model"]}
                    await self._broadcast_state(room)
                    before = copy.deepcopy(state)
                    try:
                        decision = await asyncio.to_thread(self.agent.decide, state,
                                                           actor_now["id"], available)
                    except AgentError as exc:
                        if room.get("state") is state and state == before:
                            room["agentStatus"] = {"playerId": actor_now["id"], "state": "error",
                                                    "model": self._agent_status()["model"],
                                                    "message": str(exc)}
                            await self._broadcast_state(room)
                        break
                    if room.get("state") is not state or state != before:
                        continue
                    action = decision["action"]
                elif actor_now.get("botType", "npc") == "neural":
                    status = self.neural.status()
                    if not status["configured"]:
                        room["agentStatus"] = {"playerId": actor_now["id"], "state": "error",
                                                "model": status["checkpoint"], "message": status["message"]}
                        await self._broadcast_state(room)
                        break
                    try:
                        mcts_config = dict(actor_now.get("mcts") or {})
                        mcts_config["belief"] = room["config"].get("mctsBelief") is not False
                        action = await asyncio.to_thread(self.neural.decide, state, actor_now["id"],
                                                         available, mcts_config)
                    except Exception as exc:
                        room["agentStatus"] = {"playerId": actor_now["id"], "state": "error",
                                                "model": status["checkpoint"], "message": str(exc)}
                        await self._broadcast_state(room)
                        break
                else:
                    worker = (self.native_worker_manager.game_worker
                              if self.native_worker_manager and self.native_worker_manager.running else None)
                    if worker is None:
                        raise RuntimeError("NPC 策略需要运行中的 C++ MCTS worker")
                    action = await asyncio.to_thread(
                        worker.decide_npc, game_id=str(room["id"]), player_id=actor_now["id"],
                        seed=secrets.randbits(32))
                if action is None:
                    break
                result = await self._apply_game_action(room, actor_now["id"], action)
                if not result.get("ok"):
                    if actor_now.get("botType") in ("agent", "neural"):
                        room["agentStatus"] = {"playerId": actor_now["id"], "state": "error",
                                                "model": self._agent_status()["model"],
                                                "message": "模型行动未通过游戏规则校验"}
                        await self._broadcast_state(room)
                        break
                    fallback = next((item for item in available.get("actions", [])
                                     if not item.get("disabled")), None)
                    if not fallback or not (await self._apply_game_action(room, actor_now["id"], fallback)).get("ok"):
                        break
                room["agentStatus"] = None
                await self._broadcast_state(room)

        room["botTask"] = asyncio.create_task(run_turns())

    async def _handle_message(self, client: Client, message: dict) -> None:
        kind = message.get("t")
        if kind == "hello":
            client.id = client.id or "p" + secrets.token_hex(3)
            client.name = str(message.get("name") or "玩家")
            resumed = self.rooms.resume_room(str(message.get("resumeToken") or ""),
                                             str(message.get("roomId") or "").upper())
            if resumed:
                room, seat = resumed
                seat["disconnected"] = seat["left"] = False
                client.id, client.name, client.room_id = seat["id"], seat["name"], room["id"]
                if room["state"]:
                    player = next((p for p in room["state"]["players"] if p["id"] == seat["id"]), None)
                    if player:
                        player["isBot"] = False
            await client.send({"t": "hello", "youId": client.id, "resumed": bool(resumed)})
            if resumed:
                await client.send({"t": "joined", "roomId": room["id"], "youId": client.id,
                                   "resumeToken": seat["resumeToken"],
                                   "state": await self._state_for_client(room, client.id)})
                await self._broadcast_state(room)
                self._schedule_bot(room)
            else:
                await client.send({"t": "rooms", "rooms": [public_room(room)
                                                          for room in self.rooms.rooms.values()]})
            return
        if kind == "heartbeat":
            await client.send({"t": "heartbeat", "ts": message.get("ts") or int(time.time() * 1000)})
            return
        if kind == "listRooms":
            await client.send({"t": "rooms", "rooms": [public_room(room)
                                                       for room in self.rooms.rooms.values()]})
            return
        if kind == "createRoom":
            config = message.get("config") or {}
            if not isinstance(config, dict):
                raise ValueError("房间配置必须是对象")
            if config.get("botType") == "neural":
                status = self.neural.status()
                if not status["configured"]:
                    raise ValueError(status["message"])
            if config.get("botType") == "agent" and not self._agent_status()["configured"]:
                raise ValueError(self._agent_status()["message"])
            room = self.rooms.create_room(str(message.get("name") or client.name or "房主"), config)
            seat = room["seats"][0]
            client.id, client.name, client.room_id = seat["id"], seat["name"], room["id"]
            await client.send({"t": "joined", "roomId": room["id"], "youId": client.id,
                               "resumeToken": seat["resumeToken"],
                               "state": await self._state_for_client(room, client.id)})
            await self._broadcast_state(room)
            return
        if kind == "joinRoom":
            room, seat = self.rooms.join_room(str(message.get("roomId") or "").upper(),
                                              str(message.get("name") or client.name or "玩家"))
            client.id, client.name, client.room_id = seat["id"], seat["name"], room["id"]
            await client.send({"t": "joined", "roomId": room["id"], "youId": client.id,
                               "resumeToken": seat["resumeToken"],
                               "state": await self._state_for_client(room, client.id)})
            await self._broadcast_state(room)
            return
        room = self.rooms.rooms.get(client.room_id or "")
        if not room or not client.id:
            raise ValueError("尚未加入房间")
        if kind == "botDebugSubscribe":
            await client.send({"t": "botDebugHistory", "entries": room["botDebug"]})
            return
        if kind == "leaveRoom":
            seat = next((seat for seat in room["seats"] if seat["id"] == client.id), None)
            if seat:
                state = room["state"]
                if state:
                    seat["left"] = True
                    seat["disconnected"] = False
                    player = next((p for p in state["players"]
                                   if p["id"] == seat["id"]), None)
                    if player and state["phase"] != "gameover":
                        player["isBot"] = True
                    if state["phase"] != "gameover":
                        _append_game_log(state, seat["name"] + " 已离开对局，由电脑托管。", "sys")
                    await self._send_room_notice(room, {"kind": "player_left", "playerId": seat["id"],
                                                        "playerName": seat["name"]}, client.id)
                else:
                    leaving_name = seat["name"]
                    seat.update(_empty_seat())
                    await self._send_room_notice(room, {"kind": "player_left",
                                                        "playerName": leaving_name}, client.id)
            client.room_id = None
            if not any(seat["taken"] and not seat["isBot"] for seat in room["seats"]):
                task = room.get("botTask")
                if task and not task.done():
                    task.cancel()
                self.rooms.rooms.pop(room["id"], None)
            else:
                await self._broadcast_state(room)
                self._schedule_bot(room)
            await client.send({"t": "rooms", "rooms": [public_room(item)
                                                       for item in self.rooms.rooms.values()]})
            return
        if kind == "config":
            if room["state"]:
                raise ValueError("无法修改")
            if room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可修改配置")
            updates = message.get("config") or {}
            if not isinstance(updates, dict):
                raise ValueError("房间配置必须是对象")
            if updates.get("botType") == "neural":
                status = self.neural.status()
                if not status["configured"]:
                    raise ValueError(status["message"])
            if updates.get("botType") == "agent" and not self._agent_status()["configured"]:
                raise ValueError(self._agent_status()["message"])
            for key in ("endDistricts", "charSetMode", "botType", "botLevel"):
                if updates.get(key):
                    room["config"][key] = updates[key]
            if updates.get("botPace"):
                room["config"]["botPace"] = int(updates["botPace"])
            for key in ("mctsSimulations", "mctsMaxDepth", "mctsParticles"):
                if key in updates and updates[key] is not None:
                    try:
                        value = int(float(updates[key]))
                    except (TypeError, ValueError, OverflowError):
                        raise ValueError("MCTS 配置必须是数字")
                    room["config"][key] = max(1 if key == "mctsParticles" else 0, value)
            if "mctsBelief" in updates:
                room["config"]["mctsBelief"] = updates["mctsBelief"] is not False
            if "voice" in updates:
                room["config"]["voice"] = updates["voice"] is not False
            if updates.get("playerCount"):
                total = max(2, min(8, int(updates["playerCount"])))
                room["config"]["playerCount"] = total
                while len(room["seats"]) < total:
                    room["seats"].append(_empty_seat())
                while len(room["seats"]) > total and not room["seats"][-1]["taken"]:
                    room["seats"].pop()
            await self._broadcast_state(room)
            return
        if kind == "shuffleSeats":
            if room["state"]:
                raise ValueError("只能在开局前打乱座位")
            if room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可打乱座位")
            tail = room["seats"][1:]
            random.SystemRandom().shuffle(tail)
            room["seats"][1:] = tail
            await self._broadcast_state(room)
            return
        if kind == "setSeat":
            if room["state"]:
                raise ValueError("无法修改")
            if room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可修改座位")
            index = message.get("index")
            if not isinstance(index, int) or index <= 0 or index >= len(room["seats"]):
                raise ValueError("无效的座位")
            if message.get("kind") == "bot":
                if message.get("botType") == "neural":
                    status = self.neural.status()
                    if not status["configured"]:
                        raise ValueError(status["message"])
                if message.get("botType") == "agent" and not self._agent_status()["configured"]:
                    raise ValueError(self._agent_status()["message"])
                previous = room["seats"][index]
                bot_config = {**room["config"],
                              "mcts": message.get("mcts") or previous.get("mcts"),
                              "botType": message.get("botType") or room["config"].get("botType"),
                              "botLevel": message.get("botLevel") or room["config"].get("botLevel")}
                room["seats"][index] = _bot_seat(index, bot_config)
                room["seats"][index]["mcts"] = _seat_mcts(bot_config["mcts"], room["config"])
            elif message.get("kind") == "open":
                room["seats"][index] = _empty_seat()
            else:
                raise ValueError("无效的座位类型")
            await self._broadcast_state(room)
            return
        if kind == "startGame":
            if room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可开始游戏")
            uses_agent = (any(seat["taken"] and seat["isBot"] and seat.get("botType") == "agent"
                              for seat in room["seats"]) or
                          (len([seat for seat in room["seats"] if seat["taken"]]) <
                           room["config"]["playerCount"] and room["config"].get("botType") == "agent"))
            if uses_agent and not self._agent_status()["configured"]:
                raise ValueError(self._agent_status()["message"])
            if (room["config"].get("botType") == "neural" or
                    any(seat.get("botType") == "neural" for seat in room["seats"])):
                status = self.neural.status()
                if not status["configured"]:
                    raise ValueError(status["message"])
            if self.native_worker_manager and self.native_worker_manager.running:
                start_room, seats = self.rooms.prepare_start_room(room["id"])
                config = start_room["config"]
                native_state = await asyncio.to_thread(
                    self.native_worker_manager.game_worker.create_game,
                    {"seed": secrets.randbits(32), "endDistricts": config["endDistricts"],
                     "charSetMode": config["charSetMode"], "initialCrownSeat": 0,
                     "startingHand": 4, "startingGold": 2,
                     "seats": [{key: seat.get(key) for key in
                                ("id", "name", "isBot", "botType", "botLevel")} for seat in seats],
                     "catalog": cards._catalog}, str(room["id"]))
                for player in native_state["players"]:
                    seat = next(item for item in seats if item["id"] == player["id"])
                    player["botLevel"] = seat.get("botLevel") or "normal"
                    player["mcts"] = seat.get("mcts")
                native_state.update({"roomId": room["id"],
                                     "config": {**config, "playerCount": len(seats),
                                                 "initialCrownSeat": 0, "startingHand": 4,
                                                 "startingGold": 2},
                                     "createdAt": int(time.time() * 1000),
                                     "log": [{"i": 0, "text": "游戏开始，进入选角阶段。",
                                              "type": "sys", "round": native_state["round"]}],
                                     "notices": [], "noticeSeq": 0, "witchResume": None})
                self.rooms.finish_start_room(room["id"], native_state)
            else:
                raise RuntimeError("C++ 游戏引擎不可用，无法开始游戏")
            await self._broadcast_state(room)
            self._schedule_bot(room)
            return
        if kind == "agentControl":
            if not room["state"] or room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可控制 Agent")
            status = room.get("agentStatus") or {}
            if status.get("state") != "error":
                return
            actor = next((p for p in room["state"]["players"]
                          if p["id"] == status.get("playerId")), None)
            if not actor or not actor.get("isBot") or message.get("mode") not in ("retry", "npc"):
                return
            task = room.get("botTask")
            if task and not task.done():
                task.cancel()
            room["botTask"] = None
            room["agentStatus"] = None
            if message["mode"] == "npc":
                actor["botType"] = "npc"
                seat = next((s for s in room["seats"] if s["id"] == actor["id"]), None)
                if seat:
                    seat["botType"] = "npc"
                _append_game_log(room["state"], actor["name"] + " 已由房主切换为普通电脑。", "sys")
            await self._broadcast_state(room)
            self._schedule_bot(room)
            return
        if kind == "action":
            if not room["state"]:
                raise ValueError("尚未开局")
            action = message.get("action") or {}
            if not isinstance(action, dict):
                raise ValueError("行动必须是对象")
            result = await self._apply_game_action(room, client.id, action)
            if not result["ok"]:
                raise ValueError(result["error"])
            await self._broadcast_state(room)
            self._schedule_bot(room)
            return
        if kind == "restart":
            if room["seats"][0]["id"] != client.id:
                raise ValueError("仅房主可重开游戏")
            task = room.get("botTask")
            if task and not task.done():
                task.cancel()
            room["botTask"] = None
            room["state"] = None
            await self._broadcast_state(room)
            return
        if kind == "setPace":
            pace = message.get("pace")
            if isinstance(pace, (int, float)) and 60 <= pace <= 6000:
                room["config"]["botPace"] = round(pace)
            return
        if kind == "chat":
            if not room["state"] or room["state"]["phase"] == "gameover":
                raise ValueError("仅可在进行中的对局内发言")
            seat = next((seat for seat in room["seats"] if seat["id"] == client.id and seat["taken"]
                         and not seat["isBot"] and not seat.get("left")), None)
            if not seat:
                raise ValueError("没有可发言的真人座位")
            now = time.monotonic()
            if getattr(client, "last_chat", 0) and now - client.last_chat < 0.6:
                raise ValueError("发言太快了，请稍后再试")
            content = re.sub(r"\s{2,}", " ", re.sub(r"[\r\n\t]+", " ",
                             str(message.get("text") or "").strip()))[:120]
            if not content:
                return
            client.last_chat = now
            payload = {"t": "chat", "playerId": seat["id"], "playerName": seat["name"],
                       "text": content, "sentAt": int(time.time() * 1000)}
            for other in list(self.clients):
                if other.room_id == room["id"]:
                    await other.send(payload)
            return
        raise NotImplementedError("Python 服务端消息尚未迁移：" + str(kind))

    async def _websocket(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                         headers: dict[str, str]) -> None:
        key = headers.get("sec-websocket-key")
        if not key or headers.get("sec-websocket-version") != "13":
            await _http_response(writer, 400, _json_bytes({"error": "无效的 WebSocket 握手"}))
            return
        try:
            if len(base64.b64decode(key, validate=True)) != 16:
                raise ValueError
        except ValueError:
            await _http_response(writer, 400, _json_bytes({"error": "无效的 WebSocket 密钥"}))
            return
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode("ascii"))
        await writer.drain()
        client = Client(writer)
        self.clients.add(client)
        try:
            while True:
                opcode, body = await _read_frame(reader)
                client.last_seen = time.monotonic()
                if opcode == 8:
                    break
                if opcode == 9:
                    async with client.send_lock:
                        await _write_frame(writer, 10, body)
                    continue
                if opcode == 10:
                    continue
                try:
                    message = json.loads(body.decode("utf-8"))
                    if not isinstance(message, dict):
                        raise ValueError("消息必须是 JSON 对象")
                    await self._handle_message(client, message)
                except (ValueError, KeyError, TypeError, UnicodeError, NotImplementedError) as exc:
                    await client.send({"t": "error", "error": str(exc)})
        except (asyncio.IncompleteReadError, ConnectionError, OSError, ValueError):
            pass
        finally:
            self.clients.discard(client)
            room = self.rooms.rooms.get(client.room_id or "")
            if room and client.id and not any(
                    other.id == client.id and other.room_id == room["id"] for other in self.clients):
                seat = next((seat for seat in room["seats"] if seat["id"] == client.id), None)
                if seat:
                    seat["disconnected"] = True
                    seat["left"] = False
                    if room["state"] and room["state"]["phase"] != "gameover":
                        player = next((p for p in room["state"]["players"]
                                       if p["id"] == seat["id"]), None)
                        if player:
                            player["isBot"] = True
                        _append_game_log(room["state"], seat["name"] + " 已断连，由电脑托管。", "sys")
                    await self._send_room_notice(room, {"kind": "player_disconnected",
                                                        "playerId": seat["id"],
                                                        "playerName": seat["name"]}, client.id)
                    await self._broadcast_state(room)
                    self._schedule_bot(room)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            if len(raw) > MAX_HEADER_BYTES:
                await _http_response(writer, 413, _json_bytes({"error": "请求头过大"}))
                return
            lines = raw.decode("iso-8859-1").split("\r\n")
            method, target, _ = lines[0].split(" ", 2)
            headers = {}
            for line in lines[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.lower()] = value.strip()
            if headers.get("upgrade", "").lower() == "websocket":
                await self._websocket(reader, writer, headers)
                return
            route = urlsplit(target).path
            if await self.codex_gateway.handle(reader, writer, method, route, headers):
                return
            if route == "/api/server/status" and method == "OPTIONS":
                cors = self._console_cors(headers)
                if not cors:
                    await _http_response(writer, 403, _json_bytes({"error": "未允许的控制台来源"}))
                    return
                await _http_response(writer, 204, b"", headers=cors)
                return
            if route == "/api/server/status" and method == "GET":
                cors = self._console_cors(headers)
                peer = writer.get_extra_info("peername")
                try:
                    remote_ip = ipaddress.ip_address(peer[0]) if peer else None
                except ValueError:
                    remote_ip = None
                loopback = _is_loopback_ip(remote_ip)
                tls = bool(writer.get_extra_info("ssl_object")) or (
                    os.environ.get("CITADELS_TRUST_PROXY_TLS") == "1" and
                    headers.get("x-forwarded-proto", "").lower() == "https")
                if not loopback and not tls:
                    await _http_response(writer, 400,
                                         _json_bytes({"error": "公网访问服务器控制台必须使用 HTTPS"}),
                                         headers=cors)
                    return
                if not self._admin_authenticated(headers):
                    await _http_response(writer, 401, _json_bytes({"error": "需要管理员账号密码"}),
                                         headers={**cors, "WWW-Authenticate":
                                                  'Basic realm="Citadels server console", charset="UTF-8"'})
                    return
                now = time.time()
                training = self.training.status()
                payload = {"startedAt": datetime.fromtimestamp(self.started_at, timezone.utc)
                           .isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                           "uptimeSeconds": int(max(0, now - self.started_at)),
                           "pid": os.getpid(), "platform": platform_name(), "port": self.port,
                           "listening": self.listening, "backend": "python",
                           "rooms": len(self.rooms.rooms),
                           "clients": len(self.clients),
                           "nativeWorker": bool(self.native_worker_manager and
                                                self.native_worker_manager.running),
                           "memory": {"rss": None}, "training": training,
                           "agent": {key: self._agent_status().get(key) for key in
                                     ("configured", "provider", "message")},
                           "neural": self.neural.status(),
                           "voice": {key: self.voice.status().get(key)
                                     for key in ("configured", "message")},
                           "logs": self.logs[-200:]}
                await _http_response(writer, 200, _json_bytes(payload), headers=cors)
                return
            if route == "/api/voice/token":
                cors = {"Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                        "Access-Control-Max-Age": "600"}
                if method == "OPTIONS":
                    await _http_response(writer, 204, b"", headers=cors)
                    return
                if method != "POST":
                    await _http_response(writer, 405, _json_bytes({"error": "请使用 POST"}), headers=cors)
                    return
                if not self.voice.configured:
                    await _http_response(writer, 503, _json_bytes({"error": self.voice.status()["message"]}),
                                         headers=cors)
                    return
                peer = writer.get_extra_info("peername")
                try:
                    remote_ip = ipaddress.ip_address(peer[0]) if peer else None
                except ValueError:
                    remote_ip = None
                ip_key = str(remote_ip) if remote_ip else "unknown"
                if self._voice_throttled(ip_key):
                    await _http_response(writer, 429, _json_bytes({"error": "请求过于频繁，请稍后再试"}),
                                         headers=cors)
                    return
                try:
                    length = int(headers.get("content-length", "-1"))
                except ValueError:
                    length = -1
                if length < 0 or length > 64 * 1024:
                    await _http_response(writer, 400, _json_bytes({"error": "请求内容长度无效"}), headers=cors)
                    return
                try:
                    raw = await reader.readexactly(length)
                    body = json.loads(raw.decode("utf-8"))
                    if not isinstance(body, dict):
                        raise ValueError("请求内容必须是 JSON 对象")
                except (asyncio.IncompleteReadError, UnicodeError, json.JSONDecodeError, ValueError):
                    await _http_response(writer, 400, _json_bytes({"error": "请求 JSON 无效"}), headers=cors)
                    return
                room_id = str(body.get("roomId") or "").upper()
                resumed = self.rooms.resume_room(str(body.get("resumeToken") or ""), room_id)
                if not resumed:
                    await _http_response(writer, 403,
                                         _json_bytes({"error": "无法验证房间身份，请刷新页面后重试"}),
                                         headers=cors)
                    return
                room, seat = resumed
                if seat["isBot"]:
                    await _http_response(writer, 403,
                                         _json_bytes({"error": "电脑座位不能加入语音"}), headers=cors)
                    return
                if room["config"].get("voice") is False:
                    await _http_response(writer, 403,
                                         _json_bytes({"error": "房主已关闭本房间的语音"}), headers=cors)
                    return
                try:
                    token = self.voice.token_for(room["id"], seat["id"], seat["name"])
                    await _http_response(writer, 200, _json_bytes(token), headers=cors)
                except ValueError as exc:
                    await _http_response(writer, 400, _json_bytes({"error": str(exc)}), headers=cors)
                return
            if route == "/api/training/checkpoint/upload" and method == "POST":
                peer = writer.get_extra_info("peername")
                try:
                    remote_ip = ipaddress.ip_address(peer[0]) if peer else None
                except ValueError:
                    remote_ip = None
                if not _is_loopback_ip(remote_ip):
                    await _http_response(writer, 403, _json_bytes({"error": "权重只能从服务器本机上传"}))
                    return
                try:
                    length = int(headers.get("content-length", "-1"))
                except ValueError:
                    length = -1
                if length <= 0:
                    await _http_response(writer, 400, _json_bytes({"error": "上传内容长度无效"}))
                    return
                if length > MAX_CHECKPOINT_BYTES:
                    await _http_response(writer, 413, _json_bytes({"error": "文件超过 256 MB，不像是本项目的权重存档"}))
                    return
                try:
                    body = await reader.readexactly(length)
                    name = parse_qs(urlsplit(target).query).get("name", [""])[0]
                    result = self._import_checkpoint(name, body)
                    await _http_response(writer, 200, _json_bytes(result))
                except (ValueError, OSError) as exc:
                    await _http_response(writer, 400, _json_bytes({"error": str(exc)}))
                return
            if route in ("/api/training/start", "/api/training/stop"):
                if method != "POST":
                    await _http_response(writer, 405, _json_bytes({"error": "请使用 POST"}))
                    return
                peer = writer.get_extra_info("peername")
                try:
                    remote_ip = ipaddress.ip_address(peer[0]) if peer else None
                except ValueError:
                    remote_ip = None
                if not _is_loopback_ip(remote_ip):
                    await _http_response(writer, 403, _json_bytes({"error": "训练只能从服务器本机启动或停止"}))
                    return
                if route == "/api/training/stop":
                    await _http_response(writer, 200, _json_bytes(self.training.stop()))
                    return
                try:
                    length = int(headers.get("content-length", "-1"))
                    if length < 0 or length > 64 * 1024:
                        raise ValueError("训练配置长度无效")
                    body = json.loads((await reader.readexactly(length)).decode("utf-8"))
                    if not isinstance(body, dict):
                        raise ValueError("训练配置必须是 JSON 对象")
                    result = self.training.start(body)
                    await _http_response(writer, 200, _json_bytes(result))
                except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
                    await _http_response(writer, 400, _json_bytes({"error": str(exc)}))
                return
            if method != "GET":
                await _http_response(writer, 405, _json_bytes({"error": "请使用 GET"}))
                return
            if route == "/api/agent/status":
                await _http_response(writer, 200, _json_bytes(self._agent_status()), headers={
                    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"})
                return
            if route == "/api/neural/status":
                await _http_response(writer, 200, _json_bytes(self.neural.status()), headers={
                    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"})
                return
            if route == "/api/voice/status":
                status = self.voice.status()
                await _http_response(writer, 200, _json_bytes({"configured": status["configured"],
                                                               "message": status["message"]}),
                                     headers={"Access-Control-Allow-Origin": "*"})
                return
            if route == "/api/server/startup":
                await _http_response(writer, 200, _json_bytes({
                    "logs": self.logs[-100:],
                    "worker": {"path": "", "exists": False, "running": False,
                               "backend": "python", "message": "Python 后端不使用独立 C++ 搜索进程"},
                    "frp": self.frp.status(), "autoBuildNativeWorker": False,
                    "engine": "python", "listening": self.listening, "port": self.port}))
                return
            if route == "/api/training/status":
                await _http_response(writer, 200, _json_bytes(self.training.status()))
                return
            if route == "/api/training/checkpoint":
                name = parse_qs(urlsplit(target).query).get("name", [""])[0]
                try:
                    result = self._checkpoint_config(name)
                    await _http_response(writer, 200, _json_bytes(result))
                except ValueError as exc:
                    await _http_response(writer, 400, _json_bytes({"error": str(exc)}))
                return
            if route == "/api/rooms":
                await _http_response(writer, 200, _json_bytes({"rooms": [
                    public_room(room) for room in self.rooms.rooms.values()]}))
                return
            if route.startswith("/api/"):
                await _http_response(writer, 501, _json_bytes({"error": "Python 接口尚未迁移：" + route}))
                return
            candidate = _static_path(route)
            if candidate is None:
                await _http_response(writer, 403, b"forbidden", "text/plain; charset=utf-8")
                return
            if not candidate.is_file():
                await _http_response(writer, 404, b"404", "text/plain; charset=utf-8")
                return
            # Python's Windows MIME database commonly labels JavaScript as
            # text/plain. With nosniff enabled browsers then refuse to execute
            # the app bundle, leaving every UI control inert.
            mime = {".js": "application/javascript", ".mjs": "application/javascript",
                    ".css": "text/css", ".json": "application/json"}.get(
                        candidate.suffix.lower()) or mimetypes.guess_type(candidate.name)[0] \
                or "application/octet-stream"
            if mime.startswith("text/") or mime in ("application/javascript", "application/json"):
                mime += "; charset=utf-8"
            await _http_response(writer, 200, candidate.read_bytes(), mime)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError,
                asyncio.TimeoutError, UnicodeError, ValueError):
            try:
                await _http_response(writer, 400, _json_bytes({"error": "无效的 HTTP 请求"}))
            except (ConnectionError, OSError):
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                # Clients commonly disconnect immediately after receiving a
                # response (health probes, browsers, reverse proxies). Some
                # asyncio transports surface that race from wait_closed() as
                # BrokenPipeError; it must not escape the connection callback.
                pass


async def serve(host: str, port: int) -> None:
    native_worker = NativeWorkerManager(lambda message: print(message, flush=True))
    await asyncio.to_thread(native_worker.start)
    try:
        app = PythonServer(native_worker)
        server = await asyncio.start_server(app.handle, host, port, limit=MAX_HEADER_BYTES)
        app.listening = True
        app.port = server.sockets[0].getsockname()[1] if server.sockets else port
        app.frp.port = app.port
        if app.use_local_codex:
            agent_env = dict(os.environ)
            agent_env.update({"CITADELS_AGENT_BASE_URL": f"http://127.0.0.1:{app.port}/api/codex/v1",
                              "CITADELS_AGENT_MODEL": os.environ.get("CITADELS_CODEX_MODEL") or "codex-cli",
                              "CITADELS_AGENT_API_KEY": "",
                              "CITADELS_AGENT_TIMEOUT_MS": os.environ.get("CITADELS_AGENT_TIMEOUT_MS", "150000")})
            app.agent = AgentClient(config_from_env(agent_env))
        try:
            await app.frp.start()
        except Exception as exc:
            app._log_startup("[frp] 启动失败：" + str(exc), "error")
        addresses = ", ".join(str(socket.getsockname()) for socket in server.sockets or [])
        print("Python Citadels 服务器已启动：" + addresses)
        async with server:
            await server.serve_forever()
    finally:
        if "app" in locals():
            app.listening = False
            await app.frp.close()
        await asyncio.to_thread(native_worker.close)


def parse_server_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Citadels Python game server")
    try:
        default_port = int(os.environ.get("PORT", "8788"))
    except ValueError:
        parser.error("环境变量 PORT 必须是 1～65535 的整数")
    parser.add_argument("port", nargs="?", type=int, default=default_port)
    parser.add_argument("--host", default=os.environ.get(
        "CITADELS_HOST", os.environ.get("HOST", "127.0.0.1")))
    args = parser.parse_args(argv)
    allow_ephemeral = os.environ.get("CITADELS_ALLOW_EPHEMERAL_PORT") == "1"
    minimum_port = 0 if allow_ephemeral else 1
    if not minimum_port <= args.port <= 65535:
        parser.error("端口必须在 " + str(minimum_port) + "～65535 之间")
    if not args.host or any(char.isspace() for char in args.host):
        parser.error("监听地址不能为空或包含空白字符")
    return args


def main() -> None:
    args = parse_server_args()
    asyncio.run(serve(args.host, args.port))


if __name__ == "__main__":
    main()
