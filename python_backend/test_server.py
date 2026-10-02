"""Transport-level checks: real HTTP requests and masked WebSocket frames."""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import os
import struct
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.server import Client, PythonServer, _static_path, parse_server_args  # noqa: E402
from python_backend.rooms import RoomRegistry  # noqa: E402
from test.python_game_reference import (apply_action, create_game, get_available_actions,
                                        start_game)  # noqa: E402
from python_backend.training_runtime import TrainingManager  # noqa: E402
from python_backend.voice import VoiceService  # noqa: E402
from python_backend.codex_gateway import CodexGateway  # noqa: E402


class _ReferenceRulesWorker:
    """Test double for the C++ worker API, backed by the test reference rules."""

    def __init__(self):
        self.npc_decisions = 0

    def create_game(self, new_game: dict) -> dict:
        state = create_game({key: new_game[key] for key in
                             ("seed", "endDistricts", "charSetMode", "seats")})
        result = start_game(state)
        if not result.get("ok"):
            raise ValueError(result.get("error"))
        return state

    @staticmethod
    def legal_actions(*, state: dict, player_id: str) -> dict:
        result = get_available_actions(state, player_id)
        return {"phase": state["phase"], **result}

    def decide_npc(self, *, state: dict, player_id: str, seed: int = 1) -> dict | None:
        del seed
        if self.npc_decisions >= 2:
            return None
        self.npc_decisions += 1
        actions = get_available_actions(state, player_id).get("actions") or []
        return actions[0] if actions else None

    @staticmethod
    def apply(*, state: dict, player_id: str, action: dict) -> dict:
        result = apply_action(state, player_id, action)
        if not result.get("ok"):
            raise ValueError(result.get("error"))
        return state


class _ReferenceWorkerManager:
    running = True

    def __init__(self):
        self.worker = _ReferenceRulesWorker()


def _start_reference_room(rooms: RoomRegistry, room_id: str) -> dict:
    room, seats = rooms.prepare_start_room(room_id)
    state = _ReferenceRulesWorker().create_game({
        "seed": room["config"].get("seed", 71),
        "endDistricts": room["config"]["endDistricts"],
        "charSetMode": room["config"]["charSetMode"], "seats": seats})
    state.update({"roomId": room_id, "config": room["config"], "createdAt": 0,
                  "log": [], "notices": [], "noticeSeq": 0, "witchResume": None})
    return rooms.finish_start_room(room_id, state)


class ServerArgumentTests(unittest.TestCase):
    def test_deployment_environment_defaults_and_cli_precedence(self) -> None:
        with mock.patch.dict(os.environ, {"PORT": "9123", "HOST": "0.0.0.0",
                                          "CITADELS_HOST": "192.0.2.10"}, clear=True):
            args = parse_server_args([])
            self.assertEqual((args.host, args.port), ("192.0.2.10", 9123))
            args = parse_server_args(["9456", "--host", "127.0.0.1"])
            self.assertEqual((args.host, args.port), ("127.0.0.1", 9456))

    def test_default_remains_loopback_and_invalid_port_is_rejected(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual((parse_server_args([]).host, parse_server_args([]).port),
                             ("127.0.0.1", 8788))
            with self.assertRaises(SystemExit):
                parse_server_args(["70000"])


async def _request(port: int, path: str, method: str = "GET", body: bytes = b"",
                   extra_headers: dict[str, str] | None = None,
                   content_type: str = "application/gzip",
                   response_headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    headers = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
    headers += "".join(f"{key}: {value}\r\n" for key, value in (extra_headers or {}).items())
    if body:
        headers += f"Content-Length: {len(body)}\r\nContent-Type: {content_type}\r\n"
    writer.write(headers.encode("ascii") + b"\r\n" + body)
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    header, body = raw.split(b"\r\n\r\n", 1)
    if response_headers is not None:
        for line in header.split(b"\r\n")[1:]:
            if b":" in line:
                key, value = line.split(b":", 1)
                response_headers[key.decode("ascii").lower()] = value.decode("latin-1").strip()
    return int(header.split(b" ")[1]), body


async def _open_ws(port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(bytes(range(16))).decode("ascii")
    writer.write(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                  f"Sec-WebSocket-Key: {key}\r\n\r\n").encode("ascii"))
    await writer.drain()
    response = await reader.readuntil(b"\r\n\r\n")
    assert response.startswith(b"HTTP/1.1 101"), response
    return reader, writer


async def _send_json(writer: asyncio.StreamWriter, payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    mask = bytes((1, 2, 3, 4))
    header = bytes((0x81, 0x80 | len(data))) if len(data) < 126 else (
        bytes((0x81, 0x80 | 126)) + struct.pack("!H", len(data)))
    writer.write(header + mask + bytes(byte ^ mask[index % 4]
                                       for index, byte in enumerate(data)))
    await writer.drain()


async def _recv_json(reader: asyncio.StreamReader) -> dict:
    first, second = await reader.readexactly(2)
    assert first == 0x81
    size = second & 0x7F
    if size == 126:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", await reader.readexactly(8))[0]
    return json.loads((await reader.readexactly(size)).decode("utf-8"))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.admin_temp = tempfile.TemporaryDirectory()
        previous_admin_file = os.environ.get("CITADELS_ADMIN_FILE")
        os.environ["CITADELS_ADMIN_FILE"] = str(Path(self.admin_temp.name) / "server-admin.json")
        self.app = PythonServer(_ReferenceWorkerManager())
        # HTTP training tests exercise the real runtime independently from the
        # reference-rule test double used for room transport coverage.
        self.app.training = TrainingManager(native_worker=None)
        if previous_admin_file is None:
            os.environ.pop("CITADELS_ADMIN_FILE", None)
        else:
            os.environ["CITADELS_ADMIN_FILE"] = previous_admin_file
        self.listener = await asyncio.start_server(self.app.handle, "127.0.0.1", 0)
        self.port = self.listener.sockets[0].getsockname()[1]

    async def asyncTearDown(self) -> None:
        self.listener.close()
        await self.listener.wait_closed()
        self.admin_temp.cleanup()

    async def test_live_rules_fail_closed_without_native_worker(self):
        app = PythonServer()
        result = await app._apply_game_action({"state": {}}, "p0", {"type": "end_turn"})
        self.assertFalse(result["ok"])
        self.assertIn("拒绝处理游戏行动", result["error"])
        room = app.rooms.create_room("Host", {"playerCount": 2})
        self.assertFalse(hasattr(app.rooms, "start_room"))

    async def test_http_static_and_python_api(self) -> None:
        code, body = await _request(self.port, "/api/rooms")
        self.assertEqual((code, json.loads(body)), (200, {"rooms": []}))
        code, body = await _request(self.port, "/")
        self.assertEqual(code, 200)
        self.assertIn(b"<html", body.lower())
        code, body = await _request(self.port, "/training.html")
        self.assertEqual(code, 200)
        self.assertIn(b'class="fixed-setting">C++ ISMCTS', body)
        self.assertNotIn(b'id="mcts-engine"', body)
        self.assertNotIn(b'id="neural-network-framework"', body)
        for path, expected_type in (("/app.js", "application/javascript; charset=utf-8"),
                                    ("/src/cards.js", "application/javascript; charset=utf-8"),
                                    ("/style.css", "text/css; charset=utf-8")):
            headers: dict[str, str] = {}
            code, body = await _request(self.port, path, response_headers=headers)
            self.assertEqual(code, 200, path)
            self.assertTrue(body)
            self.assertEqual(headers.get("content-type"), expected_type, path)
        for retired_client_asset in ("/src/engine.js", "/src/ai.js"):
            code, _ = await _request(self.port, retired_client_asset)
            self.assertEqual(code, 403, retired_client_asset)
        code, body = await _request(self.port, "/api/training/status")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["state"], "idle")
        with mock.patch.object(self.app.training, "start", return_value={
                "running": True, "state": "preparing", "config": {"mctsSimulations": 2}}) as start:
            code, body = await _request(self.port, "/api/training/start", "POST",
                                        json.dumps({"mctsSimulations": 2}).encode("utf-8"),
                                        content_type="application/json")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["config"]["mctsSimulations"], 2)
        start.assert_called_once_with({"mctsSimulations": 2})
        code, _ = await _request(self.port, "/api/training/stop", "POST")
        self.assertEqual(code, 200)
        for path, required in (("/api/agent/status", {"configured", "model", "message"}),
                               ("/api/neural/status", {"configured", "checkpoint", "tta", "mcts"}),
                               ("/api/voice/status", {"configured", "message"}),
                               ("/api/server/startup", {"logs", "worker", "frp", "engine"})):
            headers: dict[str, str] = {}
            code, body = await _request(self.port, path, response_headers=headers)
            self.assertEqual(code, 200, path)
            self.assertTrue(required.issubset(json.loads(body)), path)
            if path in ("/api/agent/status", "/api/neural/status"):
                self.assertEqual(headers.get("access-control-allow-origin"), "*")
                self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertIsNone(_static_path("/src/../python_backend/server.py"))
        self.assertIsNone(_static_path("/%2e%2e/python_backend/server.py"))

    async def test_admin_server_status_auth_and_console_cors(self) -> None:
        self.app.admin_credentials = ("admin", "correct horse battery staple")
        self.app.console_origins = ["https://console.example"]
        code, body = await _request(self.port, "/api/server/status")
        self.assertEqual(code, 401)
        self.assertIn("需要管理员", json.loads(body)["error"])
        auth = base64.b64encode(b"admin:correct horse battery staple").decode("ascii")
        code, body = await _request(self.port, "/api/server/status", extra_headers={
            "Authorization": "Basic " + auth})
        self.assertEqual(code, 200)
        status = json.loads(body)
        self.assertIn("training", status)
        self.assertIn("rooms", status)
        self.assertEqual(status["backend"], "python")
        self.assertNotIn("correct horse", body.decode("utf-8"))
        code, _ = await _request(self.port, "/api/server/status", "OPTIONS", extra_headers={
            "Origin": "https://console.example", "Access-Control-Request-Method": "GET"})
        self.assertEqual(code, 204)
        code, body = await _request(self.port, "/api/server/status", "OPTIONS", extra_headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
        self.assertEqual(code, 403)

    async def test_startup_endpoint_reports_configured_frp_without_starting_it(self) -> None:
        self.app.frp.env = {"CITADELS_FRP_ENABLED": "1", "CITADELS_FRP_SERVER_ADDR": "relay.example",
                            "CITADELS_FRP_TOKEN": "private-token", "CITADELS_FRP_DOMAIN": "game.example"}
        code, body = await _request(self.port, "/api/server/startup")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload["worker"]["backend"], "python")
        self.assertEqual(payload["frp"], {"enabled": True, "configured": True, "running": False,
            "type": "http", "domain": "game.example", "remotePort": None})
        self.assertNotIn("private-token", body.decode("utf-8"))

    async def test_loopback_codex_gateway_protocol_and_input_validation(self) -> None:
        calls = []
        async def fake_runner(prompt):
            calls.append(prompt)
            return {"actionIndex": 2, "cardUids": ["district-1"]}
        self.app.codex_gateway = CodexGateway(fake_runner, model_name="test-codex")
        payload = {"model": "ignored", "messages": [
            {"role": "system", "content": "follow policy"},
            {"role": "user", "content": "choose"}]}
        code, body = await _request(self.port, "/api/codex/v1/chat/completions", "POST",
            json.dumps(payload).encode(), content_type="application/json")
        self.assertEqual(code, 200, body)
        response = json.loads(body)
        self.assertEqual(response["model"], "test-codex")
        self.assertEqual(json.loads(response["choices"][0]["message"]["content"]),
                         {"actionIndex": 2, "cardUids": ["district-1"]})
        self.assertIn("MESSAGES_JSON:", calls[0])

        code, body = await _request(self.port, "/api/codex/v1/chat/completions", "POST",
            json.dumps({"messages": [{"role": "developer", "content": "unsafe"}]}).encode(),
            content_type="application/json")
        self.assertEqual(code, 400)
        self.assertIn("messages 格式无效", json.loads(body)["error"]["message"])
        self.assertEqual(len(calls), 1)

        code, _ = await _request(self.port, "/api/codex/v1/chat/completions", "POST", b"{}",
                                 content_type="text/plain")
        self.assertEqual(code, 415)

    async def test_checkpoint_upload_list_and_config_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.app.training_data_dir = Path(temp)
            self.app.training.data_dir = Path(temp)
            payload = {"game": 1234, "createdAt": "2026-10-01T00:00:00Z",
                       "config": {"profile": "large", "learningRate": 0.0003},
                       "model": {"encodingVersion": 11},
                       "encoding": {"state": 11, "action": 8}}
            blob = gzip.compress(json.dumps(payload).encode("utf-8"))
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=checkpoint-test.json.gz",
                                        "POST", blob)
            imported = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(imported["name"], "checkpoint-test.json.gz")
            self.assertTrue(imported["encodingCompatible"])

            code, body = await _request(self.port, "/api/training/status")
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["checkpoints"][0]["name"], imported["name"])
            code, body = await _request(self.port, "/api/training/checkpoint?name=" + imported["name"])
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["config"], payload["config"])

            code, body = await _request(self.port,
                                        "/api/training/checkpoint?name=..%2Fpython_backend%2Fserver.py")
            self.assertEqual(code, 400)
            self.assertIn("不合法", json.loads(body)["error"])

            # Uploading the same basename must not overwrite a checkpoint already
            # present in training-data; malformed payloads must leave no file behind.
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=checkpoint-test.json.gz",
                                        "POST", blob)
            duplicate = json.loads(body)
            self.assertEqual(code, 200)
            self.assertNotEqual(duplicate["name"], imported["name"])
            self.assertTrue(duplicate["renamed"])
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=broken.json.gz",
                                        "POST", b"not gzip")
            self.assertEqual(code, 400)
            self.assertIn("无法解析", json.loads(body)["error"])
            self.assertFalse((Path(temp) / "checkpoint-broken.json.gz").exists())

            # Listing filters unrelated files while accepting the versioned names
            # produced by Python's checkpoint writer.
            (Path(temp) / "unrelated.json.gz").write_bytes(b"junk")
            code, body = await _request(self.port, "/api/training/status")
            listed = json.loads(body)["checkpoints"]
            self.assertEqual(code, 200)
            self.assertEqual({row["name"] for row in listed},
                             {imported["name"], duplicate["name"]})

    async def test_training_http_start_status_and_stop_use_python_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.app.training.data_dir = Path(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "profile": "fast", "networkArchitecture": "entity-v5", "device": "cpu",
                      "rulesEngine": "js", "mctsEngine": "cpp",
                      "neuralNetworkFramework": "libtorch", "backend": "native",
                      "nativeInferenceBackend": "libtorch", "mctsEvaluator": "native",
                      "mctsSimulations": 1, "mctsBatchSize": 16,
                      "batchGames": 1, "trainingEpochs": 1,
                      "miniBatch": 32, "checkpointEvery": 1, "maxRounds": 1, "seed": 901}
            code, body = await _request(self.port, "/api/training/start", "POST",
                                        json.dumps(config).encode("utf-8"),
                                        content_type="application/json")
            self.assertEqual(code, 200, body)
            started = json.loads(body)
            self.assertTrue(started["running"])
            self.assertEqual(started["config"]["rulesEngine"], "cpp")
            self.assertEqual(started["config"]["mctsEngine"], "cpp")
            self.assertEqual(started["config"]["neuralNetworkFramework"], "libtorch")
            self.assertEqual(started["config"]["mctsBatchSize"], 16)
            self.assertEqual(started["config"]["backend"], "python")
            self.assertNotIn("nativeInferenceBackend", started["config"])
            self.assertNotIn("mctsEvaluator", started["config"])
            deadline = time.monotonic() + 60
            status = {}
            while time.monotonic() < deadline:
                code, body = await _request(self.port, "/api/training/status")
                self.assertEqual(code, 200)
                status = json.loads(body)
                if not status["running"]:
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(status["state"], "completed", status.get("error"))
            self.assertEqual(status["completedGames"], 1)
            self.assertTrue((Path(directory) / status["checkpoint"]).is_file())

    async def test_same_name_can_rejoin_an_active_game(self) -> None:
        rooms = RoomRegistry()
        room = rooms.create_room("Host", {"playerCount": 2})
        _, guest = rooms.join_room(room["id"], "Guest")
        _start_reference_room(rooms, room["id"])
        same_room, host = rooms.join_room(room["id"], "Host")
        self.assertIs(same_room, room)
        self.assertEqual(host["id"], room["seats"][0]["id"])
        self.assertEqual(guest["name"], "Guest")

    async def test_leaving_lobby_sends_room_notice_before_room_refresh(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id, self.messages = player_id, room_id, []
            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _, guest = self.app.rooms.join_room(room["id"], "Guest")
        host_client = StubClient(room["seats"][0]["id"], room["id"])
        guest_client = StubClient(guest["id"], room["id"])
        self.app.clients.update((host_client, guest_client))
        await self.app._handle_message(host_client, {"t": "leaveRoom"})
        notices = [m["notice"] for m in guest_client.messages if m.get("t") == "roomNotice"]
        self.assertEqual(notices, [{"kind": "player_left", "playerName": "Host"}])
        self.assertIsNone(host_client.room_id)
        self.assertFalse(room["seats"][0]["taken"])
        self.assertIn(room["id"], self.app.rooms.rooms)

    async def test_leaving_active_game_keeps_human_seat_and_notifies_room(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id, self.messages = player_id, room_id, []
            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _, guest = self.app.rooms.join_room(room["id"], "Guest")
        state = _start_reference_room(self.app.rooms, room["id"])
        host_id = room["seats"][0]["id"]
        host_client = StubClient(host_id, room["id"])
        guest_client = StubClient(guest["id"], room["id"])
        self.app.clients.update((host_client, guest_client))
        await self.app._handle_message(host_client, {"t": "leaveRoom"})
        host_seat = room["seats"][0]
        host_player = next(p for p in state["players"] if p["id"] == host_id)
        self.assertTrue(host_seat["left"])
        self.assertTrue(host_player["isBot"])
        self.assertIsNone(host_client.room_id)
        notices = [m["notice"] for m in guest_client.messages if m.get("t") == "roomNotice"]
        self.assertEqual(notices, [{"kind": "player_left", "playerId": host_id, "playerName": "Host"}])
        self.assertIn(room["id"], self.app.rooms.rooms)

    async def test_start_compacts_taken_seats_before_auto_filling_npcs(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id = player_id, room_id
            async def send(self, _payload):
                return None

        room = self.app.rooms.create_room("Host", {"playerCount": 4})
        host = StubClient(room["seats"][0]["id"], room["id"])
        await self.app._handle_message(host, {"t": "setSeat", "index": 2, "kind": "bot"})
        original_bot = room["seats"][2]["id"]
        state = _start_reference_room(self.app.rooms, room["id"])
        self.assertEqual([seat["id"] for seat in room["seats"][:2]],
                         [host.id, original_bot])
        self.assertEqual([seat["name"] for seat in room["seats"][2:]], ["电脑 1", "电脑 2"])
        self.assertEqual([player["id"] for player in state["players"]],
                         [seat["id"] for seat in room["seats"]])

    async def test_start_rejects_unconfigured_agent_even_if_it_is_an_auto_fill(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id = player_id, room_id
            async def send(self, _payload):
                return None

        room = self.app.rooms.create_room("Host", {"playerCount": 2, "botType": "agent"})
        host = StubClient(room["seats"][0]["id"], room["id"])
        class UnavailableAgent:
            @staticmethod
            def status():
                return {"configured": False, "message": "test agent unavailable"}
        self.app.agent = UnavailableAgent()
        self.app.use_local_codex = False
        with self.assertRaisesRegex(ValueError, "unavailable|Codex CLI"):
            await self.app._handle_message(host, {"t": "startGame"})
        self.assertIsNone(room["state"])

    async def test_room_preserves_clamped_mcts_defaults_and_zero_override(self) -> None:
        rooms = RoomRegistry()
        room = rooms.create_room("Host", {"playerCount": 3, "bots": 1,
                                           "mctsSimulations": 2500, "mctsMaxDepth": -2,
                                           "mctsParticles": 0})
        self.assertEqual(room["config"]["mctsSimulations"], 2000)
        self.assertEqual(room["config"]["mctsMaxDepth"], 0)
        self.assertEqual(room["config"]["mctsParticles"], 1)
        self.assertEqual(room["seats"][1]["mcts"],
                         {"simulations": 2000, "maxDepth": 0, "particles": 1})
        zero = rooms.create_room("Zero", {"playerCount": 2, "mctsSimulations": 0})
        self.assertEqual(zero["config"]["mctsSimulations"], 0)

    async def test_python_npc_driver_takes_a_legal_draft_action(self) -> None:
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1,
                                                     "botPace": 0, "seed": 91})
        state = _start_reference_room(self.app.rooms, room["id"])
        original_step = state["draft"]["stepIdx"]
        self.app._schedule_bot(room)
        for _ in range(40):
            if state["phase"] != "draft" or state["draft"]["stepIdx"] != original_step:
                break
            actor_id = self.app._bot_actor(state)
            actor = next(player for player in state["players"] if player["id"] == actor_id)
            if not actor["isBot"]:
                options = (await self.app._state_for_client(room, actor_id))["available"]["actions"]
                self.assertTrue(options)
                from test.python_game_reference import apply_action
                self.assertTrue(apply_action(state, actor_id, options[0])["ok"])
                self.app._schedule_bot(room)
            await asyncio.sleep(0.01)
        task = room.get("botTask")
        if task and not task.done():
            await asyncio.wait_for(task, timeout=1)
        self.assertNotEqual(state["draft"]["stepIdx"], original_step)

    async def test_bots_confirm_round_results_without_waiting_for_human_seat_order(self) -> None:
        room = self.app.rooms.create_room("Host", {"playerCount": 3, "bots": 2,
                                                     "botType": "agent", "botPace": 0,
                                                     "seed": 92})
        state = _start_reference_room(self.app.rooms, room["id"])
        state["phase"] = "action"
        state["roundConfirm"] = {"round": state["round"],
                                  "confirmed": [False] * len(state["players"])}
        # Even an Agent bot can perform this deterministic engine action; it
        # must not be blocked by its unrelated model-error state.
        bot = next(player for player in state["players"] if player["isBot"])
        room["agentStatus"] = {"playerId": bot["id"], "state": "error"}

        self.app._schedule_bot(room)
        task = room.get("botTask")
        if task:
            await asyncio.wait_for(task, timeout=1)

        self.assertEqual(state["roundConfirm"]["confirmed"], [False, True, True])
        self.assertIsNone(self.app._bot_actor(state))

        host = state["players"][0]
        result = apply_action(state, host["id"], {"type": "confirm_round"})
        self.assertTrue(result["ok"])
        self.app._schedule_bot(room)
        self.assertIsNone(state["roundConfirm"])

    async def test_agent_driver_uses_validated_decision_and_host_can_fallback(self) -> None:
        class StubAgent:
            def __init__(self, fail=False):
                self.fail = fail

            def status(self):
                return {"configured": True, "model": "test-model", "message": "ready"}

            def decide(self, state, player_id, available):
                if self.fail:
                    from python_backend.agent import AgentError
                    raise AgentError("http_error", "模型服务返回 HTTP 503")
                action = available["actions"][0]
                return {"action": action, "model": "test-model"}

        self.app.agent = StubAgent(fail=True)
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1,
                                                     "botType": "agent", "botPace": 0})
        state = _start_reference_room(self.app.rooms, room["id"])
        self.app._schedule_bot(room)
        for _ in range(30):
            actor_id = self.app._bot_actor(state)
            actor = next(player for player in state["players"] if player["id"] == actor_id)
            if actor["isBot"]:
                await asyncio.sleep(0.01)
                if room.get("agentStatus", {}).get("state") == "error":
                    break
            else:
                options = get_available_actions(state, actor_id)["actions"]
                self.assertTrue(apply_action(state, actor_id, options[0])["ok"])
                self.app._schedule_bot(room)
        self.assertEqual(room["agentStatus"]["state"], "error")
        agent_seat = next(seat for seat in room["seats"] if seat.get("botType") == "agent")
        host = Client(None)  # type: ignore[arg-type]
        host.id, host.room_id = room["seats"][0]["id"], room["id"]
        await self.app._handle_message(host, {"t": "agentControl", "mode": "npc"})
        self.assertEqual(agent_seat["botType"], "npc")
        task = room.get("botTask")
        if task and not task.done():
            await asyncio.wait_for(task, timeout=1)

    async def test_livekit_voice_status_token_auth_and_rate_limit(self) -> None:
        self.app.voice = VoiceService({"LIVEKIT_URL": "wss://voice.example.test/",
                                       "LIVEKIT_API_KEY": "api-key",
                                       "LIVEKIT_API_SECRET": "private-secret",
                                       "LIVEKIT_TOKEN_TTL": "600"})
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1})
        host = room["seats"][0]
        self.assertTrue(self.app._state_for(room, host["id"])["voiceReady"])
        code, status_body = await _request(self.port, "/api/voice/status")
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(status_body)["configured"])
        self.assertNotIn("private-secret", status_body.decode("utf-8"))

        payload = json.dumps({"roomId": room["id"], "resumeToken": host["resumeToken"]}).encode()
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    {"Origin": "https://frontend.example"}, "application/json")
        self.assertEqual(code, 200)
        token = json.loads(body)
        self.assertEqual(token["room"], "citadels-" + room["id"])
        self.assertEqual(token["identity"], host["id"])
        self.assertIn("private-secret", self.app.voice.api_secret)
        self.assertNotIn("private-secret", body.decode("utf-8"))

        bad_identity = json.dumps({"roomId": room["id"], "resumeToken": "wrong"}).encode()
        code, body = await _request(self.port, "/api/voice/token", "POST", bad_identity,
                                    content_type="application/json")
        self.assertEqual(code, 403)
        self.assertIn("无法验证", json.loads(body)["error"])

        room["config"]["voice"] = False
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    content_type="application/json")
        self.assertEqual(code, 403)
        self.assertIn("已关闭", json.loads(body)["error"])
        room["config"]["voice"] = True

        self.app.voice_token_hits["127.0.0.1"] = (30, time.time() + 60)
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    content_type="application/json")
        self.assertEqual(code, 429)
        self.assertIn("频繁", json.loads(body)["error"])

        code, _ = await _request(self.port, "/api/voice/token", "OPTIONS", extra_headers={
            "Origin": "https://frontend.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(code, 204)

    async def test_websocket_lobby_and_draft(self) -> None:
        host_reader, host_writer = await _open_ws(self.port)
        guest_reader, guest_writer = await _open_ws(self.port)
        try:
            await _send_json(host_writer, {"t": "hello", "name": "Host"})
            self.assertEqual((await _recv_json(host_reader))["t"], "hello")
            self.assertEqual((await _recv_json(host_reader))["t"], "rooms")
            await _send_json(host_writer, {"t": "createRoom", "name": "Host",
                                           "config": {"playerCount": 2}})
            joined = await _recv_json(host_reader)
            self.assertEqual(joined["t"], "joined")
            room_id = joined["roomId"]
            self.assertNotIn("resumeToken", json.dumps(joined["state"]))
            self.assertEqual((await _recv_json(host_reader))["t"], "state")

            await _send_json(guest_writer, {"t": "hello", "name": "Guest"})
            self.assertEqual((await _recv_json(guest_reader))["t"], "hello")
            self.assertEqual((await _recv_json(guest_reader))["t"], "rooms")
            await _send_json(guest_writer, {"t": "joinRoom", "roomId": room_id,
                                            "name": "Guest"})
            self.assertEqual((await _recv_json(guest_reader))["t"], "joined")
            self.assertEqual((await _recv_json(guest_reader))["t"], "state")
            self.assertEqual((await _recv_json(host_reader))["t"], "state")

            await _send_json(host_writer, {"t": "startGame"})
            host_state = (await _recv_json(host_reader))["state"]
            guest_state = (await _recv_json(guest_reader))["state"]
            self.assertEqual(host_state["phase"], "draft")
            self.assertEqual(guest_state["phase"], "draft")
            actor_state = host_state if host_state["available"]["actions"] else guest_state
            other_state = guest_state if actor_state is host_state else host_state
            self.assertTrue(actor_state["draft"]["pool"])
            self.assertEqual(other_state["draft"]["pool"], [])
            self.assertTrue(all("hand" not in row for row in other_state["players"]
                                if row["id"] != other_state["you"]))
            actor_writer = host_writer if actor_state is host_state else guest_writer
            actor_reader = host_reader if actor_state is host_state else guest_reader
            await _send_json(actor_writer, {"t": "action", "action": "invalid"})
            self.assertEqual((await _recv_json(actor_reader))["t"], "error")
            await _send_json(actor_writer, {"t": "action",
                                            "action": actor_state["available"]["actions"][0]})
            self.assertEqual((await _recv_json(host_reader))["t"], "state")
            self.assertEqual((await _recv_json(guest_reader))["t"], "state")
        finally:
            host_writer.close()
            guest_writer.close()
            await host_writer.wait_closed()
            await guest_writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
