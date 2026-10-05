"""IPC checks against a compiled standalone game engine (no LibTorch required).

Set CITADELS_TEST_GAME_ENGINE to the executable to run these integration checks.
"""
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.game_engine_worker import GameEngineWorker


@unittest.skipUnless(os.environ.get("CITADELS_TEST_GAME_ENGINE"), "Compiled test game engine required")
class NativeHeuristicSearchTests(unittest.TestCase):
    def setUp(self):
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"])
        self.new_game = {"seed": 1700, "endDistricts": 8, "charSetMode": "random",
                         "catalog": json.loads((ROOT / "python_backend/catalog.json").read_text(encoding="utf-8")),
                         "seats": [{"id": f"p{i}", "botLevel": "hard", "isBot": True,
                                    "botType": "npc"} for i in range(5)]}

    def tearDown(self):
        self.worker.close()

    def test_real_game_npc_search_is_legal_and_does_not_mutate_game(self):
        before = self.worker.create_game(self.new_game, "real")
        actor = self.worker.current("real")["playerId"]
        result = self.worker._request("npc", gameId="real", playerId=actor, seed=71)
        stats = result["heuristicSearch"]
        self.assertTrue(stats["searched"])
        self.assertFalse(stats["fallback"])
        self.assertGreater(stats["visits"], 0)
        self.assertEqual(stats["particles"], 8)
        legal = self.worker.legal_actions(game_id="real", player_id=actor)["actions"]
        self.assertIn(result["action"], legal)
        self.assertEqual(before, self.worker.snapshot("real"))
        self.worker.apply(game_id="real", player_id=actor, action=result["action"])

    def test_training_advancement_uses_the_same_search(self):
        self.worker.create_game(self.new_game, "training")
        result = self.worker._request("advance_npcs", gameId="training", networkPlayerIds=[],
                                      seed=71, maxSteps=4, maxRounds=100,
                                      includeTrainingFeatures=False)
        self.assertEqual(result["steps"], 4)
        self.assertGreater(result["heuristicSearch"]["searches"], 0)
        self.assertGreater(result["heuristicSearch"]["visits"], 0)
        self.assertEqual(result["heuristicSearch"]["fallbacks"], 0)

    def test_normal_npc_keeps_fast_policy(self):
        for seat in self.new_game["seats"]:
            seat["botLevel"] = "normal"
        self.worker.create_game(self.new_game, "normal")
        actor = self.worker.current("normal")["playerId"]
        result = self.worker._request("npc", gameId="normal", playerId=actor, seed=71)
        self.assertFalse(result["heuristicSearch"]["searched"])
        self.assertFalse(result["heuristicSearch"]["fallback"])

    def test_startup_budget_controls_search(self):
        self.worker.close()
        env = dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED="1",
                   CITADELS_HEURISTIC_MCTS_SIMULATIONS="3",
                   CITADELS_HEURISTIC_MCTS_PARTICLES="2",
                   CITADELS_HEURISTIC_MCTS_TIME_MS="0",
                   CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=env)
        self.worker.create_game(self.new_game, "budget")
        actor = self.worker.current("budget")["playerId"]
        stats = self.worker._request("npc", gameId="budget", playerId=actor)["heuristicSearch"]
        self.assertTrue(stats["searched"])
        self.assertEqual(stats["visits"], 3)
        self.assertEqual(stats["particles"], 2)

    def test_hard_search_can_be_disabled(self):
        self.worker.close()
        env = dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=env)
        self.worker.create_game(self.new_game, "disabled")
        actor = self.worker.current("disabled")["playerId"]
        result = self.worker._request("npc", gameId="disabled", playerId=actor)
        self.assertFalse(result["heuristicSearch"]["searched"])
        self.assertFalse(result["heuristicSearch"]["fallback"])
        self.assertIn(result["action"], self.worker.legal_actions(game_id="disabled", player_id=actor)["actions"])


if __name__ == "__main__":
    unittest.main()
