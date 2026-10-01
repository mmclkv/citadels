"""Search-tree sanity checks against real Python-engine turns."""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.game import apply_action, create_game, get_available_actions, start_game  # noqa: E402
from python_backend.mcts import InformationSetMCTS  # noqa: E402
from python_backend.neural import NeuralPolicy  # noqa: E402
import torch  # noqa: E402


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

    def test_search_returns_normalized_visits_without_mutating_root(self):
        state = self.action_state()
        actor_index = state["turn"]["playerIdx"]
        player_id = state["players"][actor_index]["id"]
        actions = get_available_actions(state, player_id)["actions"]
        before = copy.deepcopy(state)

        def evaluator(_state, _player, candidates):
            # Nonuniform priors exercise PUCT; zero value keeps this test independent
            # of torch/model artifacts while the legal game engine drives transitions.
            priors = [1.0 + (i % 3) for i in range(len(candidates))]
            return priors, [0.0] * 8

        result = InformationSetMCTS(evaluator, simulations=12, max_depth=30, seed=91).search(
            [state], player_id, actions)
        self.assertEqual(state, before)
        self.assertEqual(len(result.policy), len(result.actions))
        self.assertAlmostEqual(float(result.policy.sum()), 1.0)
        self.assertEqual(result.visits, 12)
        self.assertGreater(result.expansions, 0)
        self.assertLessEqual(result.nodes, 20000)

    def test_weighted_particle_search_reports_used_particles(self):
        state = self.action_state()
        actor_index = state["turn"]["playerIdx"]
        player_id = state["players"][actor_index]["id"]
        actions = get_available_actions(state, player_id)["actions"]
        second = copy.deepcopy(state)
        def evaluator(_state, _player, candidates):
            return [1] * len(candidates), [0] * 8
        result = InformationSetMCTS(evaluator, simulations=4, max_depth=5, seed=3).search(
            [state, second], player_id, actions, [0.0, 1.0])
        self.assertEqual(result.particles_used, 2)
        self.assertEqual(result.visits, 4)
        self.assertAlmostEqual(float(result.policy.sum()), 1.0)

    def test_neural_policy_runs_determinized_search_when_seat_enables_it(self):
        state = self.action_state()
        actor_index = state["turn"]["playerIdx"]
        player_id = state["players"][actor_index]["id"]
        available = get_available_actions(state, player_id)

        class UniformModel:
            def __call__(self, states, actions):
                return (torch.zeros((1, actions.shape[1]), device=actions.device),
                        torch.zeros((1, 8), device=actions.device))

        policy = NeuralPolicy.__new__(NeuralPolicy)
        policy.model = UniformModel()
        policy.checkpoint = "test-model"
        policy.profile = "fast"
        policy.device = torch.device("cpu")
        policy.architecture = "entity-v5"
        policy.action_version = 8
        policy.error = ""
        policy._last_mcts = {}
        action = policy.decide(state, player_id, available,
            {"simulations": 3, "maxDepth": 8, "particles": 2, "belief": True})
        self.assertIn(action, NeuralPolicy._expand(state, player_id, available["actions"]))
        diagnostics = policy.status()["mcts"]
        self.assertEqual(diagnostics["determinizations"], 2)
        self.assertEqual(diagnostics["visits"], 3)


if __name__ == "__main__":
    unittest.main()
