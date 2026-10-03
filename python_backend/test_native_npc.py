"""Tests for the Python-to-native NPC decision boundary."""

from __future__ import annotations

import io
import json
import threading
import unittest

from python_backend.game_engine_worker import GameEngineWorker


class _FakeProcess:
    def __init__(self) -> None:
        self.stdin = io.StringIO()
        self.stdout = io.StringIO('{"id":"1","t":"npc_result","action":{"type":"choose_char","name":"3","num":3}}\n')
        self.returncode = None

    def poll(self):
        return None


class NativeNpcBridgeTests(unittest.TestCase):
    def test_npc_request_returns_canonical_native_action(self) -> None:
        worker = GameEngineWorker.__new__(GameEngineWorker)
        worker.process = _FakeProcess()
        worker._lock = threading.Lock()
        worker._request_id = 0
        action = worker.decide_npc(game_id="g1", player_id="p0", seed=19)
        self.assertEqual(action, {"type": "choose_char", "name": "3", "num": 3})
        request = json.loads(worker.process.stdin.getvalue())
        self.assertEqual((request["mode"], request["gameId"], request["playerId"], request["seed"]),
                         ("npc", "g1", "p0", 19))

    def test_no_python_bot_implementation_remains(self) -> None:
        from pathlib import Path
        self.assertFalse((Path(__file__).parent / "bot.py").exists())


if __name__ == "__main__":
    unittest.main()
