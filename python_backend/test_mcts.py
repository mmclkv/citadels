"""Checks that the live policy delegates search to the native worker."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from test.python_game_reference import (apply_action, create_game, get_available_actions,
                                        start_game)  # noqa: E402
from python_backend.neural import NeuralPolicy  # noqa: E402


class MctsTests(unittest.TestCase):
    @staticmethod
    def action_state():
        state = create_game({"seats": [{"id": f"p{i}", "name": f"P{i}"} for i in range(3)],
                             "seed": 631, "charSetMode": "base"})
        start_game(state)
        while state["phase"] == "draft":
            draft_step = state["draft"]["steps"][state["draft"]["stepIdx"]]
            player = state["players"][draft_step["player"]]["id"]
            action = get_available_actions(state, player)["actions"][0]
            assert apply_action(state, player, action)["ok"]
        return state

    def test_neural_policy_runs_determinized_search_when_seat_enables_it(self):
        state = self.action_state()
        actor_index = state["turn"]["playerIdx"]
        player_id = state["players"][actor_index]["id"]
        available = get_available_actions(state, player_id)

        class NativeWorkerStub:
            def determinize(self, **request):
                self.determinize_request = request
                count = request["count"]
                return {"particles": [request["state"] for _ in range(count)],
                        "weights": [1.0] * count}

            def search(self, **request):
                self.request = request
                count = len(request["legal_actions"])
                return {"policy": [1 / count] * count, "visits": 3,
                        "expansions": 2, "particlesUsed": 2}

        policy = NeuralPolicy.__new__(NeuralPolicy)
        policy.worker = NativeWorkerStub()
        policy.model_path = __file__
        policy.checkpoint = "test-model"
        policy.profile = "fast"
        policy.device_name = "cpu"
        policy.architecture = "entity-v5"
        policy.action_version = 8
        policy.error = ""
        policy._last_mcts = {}
        action = policy.decide(state, player_id, available,
            {"simulations": 3, "maxDepth": 8, "particles": 2, "belief": True})
        self.assertIn(action, available["actions"])
        diagnostics = policy.status()["mcts"]
        self.assertEqual(diagnostics["determinizations"], 2)
        self.assertEqual(diagnostics["visits"], 3)
        self.assertEqual(policy.worker.request["architecture"], "entity-v5")
        self.assertEqual(len(policy.worker.request["particles"]), 1)
        self.assertEqual(policy.worker.determinize_request["count"], 2)


if __name__ == "__main__":
    unittest.main()
