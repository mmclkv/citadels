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
        self.search_env = dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED="1",
                               CITADELS_HEURISTIC_MCTS_SIMULATIONS="128",
                               CITADELS_HEURISTIC_MCTS_PARTICLES="8",
                               CITADELS_HEURISTIC_MCTS_MAX_DEPTH="32",
                               CITADELS_HEURISTIC_MCTS_ROLLOUT_STEPS="8",
                               CITADELS_HEURISTIC_MCTS_ROLLOUTS="1",
                               CITADELS_HEURISTIC_MCTS_REUSE_TREE="1",
                               CITADELS_HEURISTIC_MCTS_TREE_NODES="4096",
                               CITADELS_HEURISTIC_MCTS_TIME_MS="100",
                               CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=self.search_env)
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
        self.assertGreater(stats["rolloutActions"], 0)
        self.assertGreater(stats["newVisits"], 0)
        self.assertEqual(stats["reusedVisits"], 0)
        self.assertEqual(stats["particles"], 2)
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
        self.assertGreater(result["heuristicSearch"]["rolloutActions"], 0)
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
        env = dict(self.search_env, CITADELS_HEURISTIC_MCTS_ENABLED="1",
                   CITADELS_HEURISTIC_MCTS_SIMULATIONS="3",
                   CITADELS_HEURISTIC_MCTS_PARTICLES="2",
                   CITADELS_HEURISTIC_MCTS_TIME_MS="80",
                   CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=env)
        self.worker.create_game(self.new_game, "budget")
        actor = self.worker.current("budget")["playerId"]
        stats = self.worker._request("npc", gameId="budget", playerId=actor)["heuristicSearch"]
        self.assertTrue(stats["searched"])
        self.assertGreater(stats["visits"], 3)  # obsolete simulation cap is ignored
        self.assertEqual(stats["particles"], 2)
        self.assertGreaterEqual(stats["elapsedMs"], 60)
        self.assertLess(stats["elapsedMs"], 1000)

    def test_session_isolated_between_games_and_recreation(self):
        self.worker.create_game(self.new_game, "a")
        actor = self.worker.current("a")["playerId"]
        self.worker._request("npc", gameId="a", playerId=actor, seed=71)
        repeated = self.worker._request("npc", gameId="a", playerId=actor, seed=72)["heuristicSearch"]
        self.assertGreater(repeated["reusedVisits"], 0)
        self.worker.create_game(self.new_game, "b")
        fresh = self.worker._request("npc", gameId="b", playerId=actor, seed=71)["heuristicSearch"]
        self.assertEqual(fresh["reusedVisits"], 0)
        self.worker.create_game(self.new_game, "a")
        reset = self.worker._request("npc", gameId="a", playerId=actor, seed=71)["heuristicSearch"]
        self.assertEqual(reset["reusedVisits"], 0)

    def test_real_apply_and_training_advance_share_retained_tree(self):
        self.worker.create_game(self.new_game, "turn")
        # Exercise real apply requests until a deterministic same-player
        # continuation has a retained searched subtree. Initial draft picks
        # correctly invalidate because the selected private role changes.
        found = False
        for step in range(150):
            actor = self.worker.current("turn")["playerId"]
            result = self.worker._request("npc", gameId="turn", playerId=actor, seed=71 + step)
            self.assertFalse(result["heuristicSearch"]["fallback"])
            self.worker.apply(game_id="turn", player_id=actor, action=result["action"])
            if self.worker.current("turn")["playerId"] != actor:
                continue
            legal = self.worker.legal_actions(game_id="turn", player_id=actor)["actions"]
            if len(legal) < 2:
                continue
            continuation = self.worker._request("npc", gameId="turn", playerId=actor, seed=900 + step)
            if continuation["heuristicSearch"]["reusedVisits"] > 0:
                sampled = self.worker._request("advance_npcs", gameId="turn", networkPlayerIds=[],
                                               seed=900 + step, maxSteps=1, maxRounds=100,
                                               includeTrainingFeatures=False)
                self.assertGreater(sampled["heuristicSearch"]["reusedVisits"], 0)
                self.assertGreater(sampled["heuristicSearch"]["newVisits"], 0)
                self.assertEqual(sampled["heuristicSearch"]["fallbacks"], 0)
                found = True
                break
        self.assertTrue(found, "No actual deterministic continuation reused a searched subtree")

    def test_hard_search_can_be_disabled(self):
        self.worker.close()
        env = dict(self.search_env, CITADELS_HEURISTIC_MCTS_ENABLED="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=env)
        self.worker.create_game(self.new_game, "disabled")
        actor = self.worker.current("disabled")["playerId"]
        result = self.worker._request("npc", gameId="disabled", playerId=actor)
        self.assertFalse(result["heuristicSearch"]["searched"])
        self.assertFalse(result["heuristicSearch"]["fallback"])
        self.assertIn(result["action"], self.worker.legal_actions(game_id="disabled", player_id=actor)["actions"])

    def test_legacy_rollout_and_reuse_overrides_are_ignored(self):
        self.worker.close()
        env = dict(self.search_env, CITADELS_HEURISTIC_MCTS_ROLLOUT_STEPS="0",
                   CITADELS_HEURISTIC_MCTS_REUSE_TREE="0",
                   CITADELS_HEURISTIC_MCTS_SIMULATIONS="16",
                   CITADELS_HEURISTIC_MCTS_TIME_MS="100",
                   CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS="0")
        self.worker = GameEngineWorker(os.environ["CITADELS_TEST_GAME_ENGINE"], env=env)
        self.worker.create_game(self.new_game, "static")
        actor = self.worker.current("static")["playerId"]
        for i, seed in enumerate((71, 72)):
            stats = self.worker._request("npc", gameId="static", playerId=actor, seed=seed)["heuristicSearch"]
            self.assertTrue(stats["searched"])
            self.assertGreater(stats["newVisits"], 0)
            self.assertGreater(stats["retainedNodes"], 0)
            self.assertGreater(stats["rolloutActions"], 0)
            if i:
                self.assertGreater(stats["reusedVisits"], 0)

    def test_request_budget_is_shared_by_draft_action_and_training(self):
        self.worker.create_game(self.new_game, "unified")
        for step in range(20):
            actor = self.worker.current("unified")["playerId"]
            before = self.worker.snapshot("unified")
            result = self.worker._request("npc", gameId="unified", playerId=actor,
                heuristicMcts={"timeBudgetMs": 30, "simulations": 1,
                               "criticalTimeBudgetMs": 100000, "particles": 99})
            stats = result["heuristicSearch"]
            if stats["searched"]:
                self.assertGreaterEqual(stats["elapsedMs"], 20)
                self.assertLess(stats["elapsedMs"], 1000)
                self.assertEqual(stats["particles"], 2)
                self.assertGreater(stats["visits"], 1)
            self.worker.apply(game_id="unified", player_id=actor, action=result["action"])
            if before["phase"] == "action" and stats["searched"]:
                break
        else:
            self.fail("Did not exercise an action-phase search")
        advanced = self.worker._request("advance_npcs", gameId="unified", networkPlayerIds=[],
            maxSteps=2, heuristicMcts={"timeBudgetMs": 30}, seed=1)
        self.assertEqual(advanced["steps"], 2)
        self.assertLess(advanced["heuristicSearch"]["elapsedMs"], 2000)


if __name__ == "__main__":
    unittest.main()
