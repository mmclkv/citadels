"""Security and protocol tests for external-model Agent decisions."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.agent import AgentClient, AgentError, config_from_env, prepare_decision  # noqa: E402
from python_backend.game import create_game, start_game  # noqa: E402


class _Response:
    status = 200

    def __init__(self, payload: dict):
        self.raw = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, count: int) -> bytes:
        return self.raw[:count]


class AgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = create_game({"seats": [{"id": "p0", "name": "A"},
                                             {"id": "p1", "name": "B"}], "seed": 71})
        start_game(self.state)

    def test_config_validation_and_local_keyless_mode(self) -> None:
        env = {"CITADELS_AGENT_BASE_URL": "http://localhost:1234/v1/",
               "CITADELS_AGENT_MODEL": "  test-model  ", "CITADELS_AGENT_TIMEOUT_MS": "500"}
        config = config_from_env(env)
        self.assertTrue(config["configured"])
        self.assertEqual(config["endpoint"], "http://localhost:1234/v1/chat/completions")
        self.assertEqual(config["timeoutMs"], 1000)
        env["CITADELS_AGENT_BASE_URL"] = "https://user:pass@example.test/v1?secret=x"
        self.assertFalse(config_from_env(env)["configured"])

    def test_observation_is_player_scoped_and_decision_is_validated(self) -> None:
        prepared = prepare_decision(self.state, "p0")
        encoded = json.dumps(prepared)
        self.assertNotIn('"deck"', encoded)
        self.assertNotIn("resumeToken", encoded)
        self.assertNotIn("opponent-secret", encoded)
        self.state["players"][1]["hand"][0]["name"] = "opponent-secret"
        prepared = prepare_decision(self.state, "p0")
        self.assertNotIn("opponent-secret", json.dumps(prepared))

        client = AgentClient({"endpoint": "http://localhost/v1/chat/completions",
                              "model": "test-model", "apiKey": "secret-key",
                              "timeoutMs": 1000, "configured": True},
                             opener=_FakeOpener())
        result = client.decide(self.state, "p0")
        self.assertEqual(result["model"], "test-model")
        self.assertEqual(result["action"]["type"], "draft_pick")
        request = client.opener.request
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-key")
        body = json.loads(request.data)
        self.assertNotIn("secret-key", json.dumps(body["messages"][1]["content"]))

    def test_agent_does_not_leak_upstream_error_body(self) -> None:
        class BrokenOpener:
            def open(self, request, timeout):
                raise RuntimeError("secret upstream response")

        client = AgentClient({"endpoint": "https://example.test/chat/completions",
                              "model": "test-model", "apiKey": "secret-key",
                              "timeoutMs": 1000, "configured": True}, opener=BrokenOpener())
        with self.assertRaises(AgentError) as caught:
            client.decide(self.state, "p0")
        self.assertEqual(caught.exception.code, "network_error")
        self.assertNotIn("secret", str(caught.exception))


class _FakeOpener:
    def __init__(self):
        self.request = None

    def open(self, request, timeout):
        self.request = request
        messages = json.loads(request.data)["messages"]
        prepared = json.loads(messages[1]["content"])
        response = {"choices": [{"message": {"content": json.dumps({"actionIndex": 0})}}]}
        self.assert_player_scoped(prepared)
        return _Response(response)

    @staticmethod
    def assert_player_scoped(prepared):
        assert "deck" not in prepared["observation"]
        assert all("hand" not in player for player in prepared["observation"]["players"]
                   if player["id"] != prepared["observation"]["you"])


if __name__ == "__main__":
    unittest.main()
