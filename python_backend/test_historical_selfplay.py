"""Real C++/LibTorch sampling with newly saved and resumed historical policies."""
import sys
import os
import tempfile
import time
import unittest
from pathlib import Path

# Small CPU probes must not fan out across every host core in each subprocess.
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.training_runtime import TrainingManager
from python_backend.native_worker_manager import NativeWorkerManager


class HistoricalSelfPlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        torch.set_num_threads(1)
        cls.native = NativeWorkerManager()
        cls.native.start()

    @classmethod
    def tearDownClass(cls):
        cls.native.close()

    def wait(self, manager):
        deadline = time.monotonic() + 120
        while manager.status()["running"] and time.monotonic() < deadline:
            time.sleep(0.05)
        status = manager.status()
        if status["running"]:
            manager.stop()
        self.assertFalse(status["running"], status.get("logs", [])[-4:])
        self.assertEqual(status["state"], "completed", status.get("error"))
        return status

    def test_parallel_samplers_refresh_pool_and_resume_against_frozen_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"targetGames": 2, "minPlayers": 2, "maxPlayers": 2,
                      "selfPlayMode": "all-network",
                      "charSet": "base", "profile": "fast", "device": "cpu",
                      "mctsSimulations": 1, "mctsParticles": 1, "mctsMaxDepth": 10,
                      "workers": 2, "batchGames": 1, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 1, "maxRounds": 30, "endDistricts": 7,
                      "historicalPoolSize": 2, "historicalOpponentProbability": 1,
                      "seed": 8127}
            manager = TrainingManager(directory, self.native.worker, self.native.game_worker)
            manager.start(config)
            status = self.wait(manager)
            self.assertEqual(status["completedGames"], 2)
            self.assertEqual(status["point"]["finishedGames"], 2)
            self.assertEqual(status["point"]["historicalPlayers"], 1)
            self.assertEqual(status["point"]["currentNetworkPlayers"], 1)
            self.assertEqual(status["point"]["historicalPoolCount"], 2)
            self.assertEqual(len(status["point"]["historicalCheckpoints"]), 1)
            self.assertGreater(status["point"]["policySamples"], 0)
            self.assertEqual(status["point"]["fallbacks"], 0)
            self.assertEqual(len(list(Path(directory).glob("checkpoint-*.json.gz"))), 2)
            old_checkpoint = status["checkpoint"]
            old_bytes = (Path(directory) / old_checkpoint).read_bytes()
            resumed = TrainingManager(directory, self.native.worker, self.native.game_worker)
            resumed.start({**config, "targetGames": 3, "workers": 1,
                           "resumeCheckpoint": old_checkpoint})
            continued = self.wait(resumed)
            self.assertEqual(continued["completedGames"], 3)
            self.assertEqual(continued["point"]["historicalPlayers"], 1)
            self.assertEqual(continued["point"]["historicalPoolCount"], 2)
            self.assertGreater(continued["point"]["policySamples"], 0)
            self.assertEqual((Path(directory) / old_checkpoint).read_bytes(), old_bytes)

    def test_native_weakness_training_and_heldout_screening(self):
        import json
        from unittest.mock import patch
        import torch
        from python_backend.weakness_search import WeaknessSearch
        original = WeaknessSearch.run
        checked = []
        def isolated_run(search, incumbent, games, backgrounds):
            before = {name: value.detach().clone() for name, value in incumbent.state_dict().items()}
            result = original(search, incumbent, games, backgrounds)
            checked.append(all(torch.equal(before[name], value) for name, value in incumbent.state_dict().items()))
            return result
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory, self.native.worker, self.native.game_worker)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "device": "cpu",
                      "mctsSimulations": 1, "mctsParticles": 1, "mctsMaxDepth": 10,
                      "workers": 1, "batchGames": 1, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 1, "maxRounds": 30, "endDistricts": 7,
                      "weaknessSearchEvery": 1, "weaknessTrainingGames": 1,
                      "weaknessEvaluationPairs": 1, "seed": 8127}
            config["maxRounds"] = 100
            with patch.object(WeaknessSearch, "run", isolated_run):
                manager.start(config)
                status = self.wait(manager)
            report = status["weaknessSearch"]
            self.assertEqual(checked, [True], "opponent learning must not update incumbent weights")
            self.assertEqual(report["trainingCompletedGames"], 1)
            self.assertGreater(report["updates"], 0)
            self.assertEqual(report["completePairs"], 1, report["pairs"])
            self.assertFalse(report["accepted"], "one pair cannot pass the significance gate")
            self.assertEqual(status["completedGames"], 1, "discovery games are separate from main training")
            self.assertEqual(len(list(Path(directory).glob("checkpoint-*.json.gz"))), 1)
            reports = list((Path(directory) / "weakness-search").glob("*.json"))
            self.assertEqual(len(reports), 1)
            self.assertEqual(json.loads(reports[0].read_text(encoding="utf-8"))["completePairs"], 1)

    def test_random_batch_counts_reach_parallel_native_games(self):
        from python_backend.batch_composition import random_batch_composition
        from python_backend.training_config import sanitize_config
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory, self.native.worker, self.native.game_worker)
            config = {"targetGames": 4, "minPlayers": 4, "maxPlayers": 4,
                      "selfPlayMode": "random-batch", "charSet": "base", "profile": "fast",
                      "device": "cpu", "mctsSimulations": 1, "mctsParticles": 1,
                      "mctsMaxDepth": 10, "workers": 2, "batchGames": 2,
                      "trainingEpochs": 1, "miniBatch": 32, "checkpointEvery": 2,
                      "maxRounds": 100, "endDistricts": 7, "weaknessSearchEvery": 0, "seed": 7}
            manager.start(config)
            status = self.wait(manager)
            self.assertEqual(status["completedGames"], 4)
            self.assertEqual(status["point"]["finishedGames"], 4)
            expected = random_batch_composition(sanitize_config(config), 3, True)
            self.assertEqual(status["batchComposition"], expected)
            self.assertEqual(status["point"]["currentNetworkPlayers"], expected["main"])
            self.assertEqual(status["point"]["historicalPlayers"], expected["historical"])
            self.assertEqual(status["point"]["heuristicPlayers"], expected["heuristic"])
            self.assertEqual(status["point"]["fallbacks"], 0)
            self.assertEqual(len(status["history"]), 2)
            first = random_batch_composition(sanitize_config(config), 1, False)
            self.assertEqual(status["history"][0]["batchComposition"], first)
            self.assertEqual(status["history"][1]["batchComposition"], expected)

    def test_only_rotating_learner_searches_and_supplies_policy_targets(self):
        from unittest.mock import patch
        from python_backend import training_runtime as runtime
        original_sample = runtime._sample_game
        original_search = self.native.worker.search
        checked = []

        def composition(config, first_game, history_available):
            return {"firstGame": first_game, "players": 4,
                    "main": 2 if history_available else 3,
                    "historical": 1 if history_available else 0, "heuristic": 1}

        def sample(config, number, stop):
            learner_id = f"train-{number}-{(number - 1) % 4}"
            kinds = set()

            def search(**kwargs):
                result = original_search(**kwargs)
                if kwargs["root_player_id"] == learner_id:
                    self.assertFalse(kwargs["policy_only"])
                    self.assertTrue(kwargs["include_training_features"])
                    opponents = kwargs["opponent_policies"]
                    self.assertEqual(len(opponents), 2)
                    self.assertNotIn(learner_id, {p["playerId"] for p in opponents})
                    self.assertEqual(result["opponentPolicyMode"], "seat-policy-sampling-v1")
                    self.assertTrue(all(p["actionEncodingVersion"] == kwargs["action_encoding_version"]
                                        for p in opponents))
                    if config.get("historicalPoolManifest") and number == 2:
                        self.assertTrue(any(p["modelPath"] != config["nativeModelPath"] for p in opponents))
                    kinds.add("learner")
                else:
                    self.assertTrue(kwargs["policy_only"])
                    self.assertEqual(kwargs["opponent_policies"], [])
                    self.assertFalse(kwargs["include_training_features"])
                    self.assertEqual(kwargs["dirichlet_epsilon"], 0)
                    self.assertEqual(result["visits"], 0)
                    self.assertEqual(result["expansions"], 0)
                    kinds.add("current" if kwargs["model_path"] == config["nativeModelPath"] else "historical")
                return result

            with patch.object(runtime, "_native_worker", return_value=self.native.worker), \
                    patch.object(self.native.worker, "search", search):
                result = original_sample(config, number, stop)
            self.assertTrue(result["completed"])
            policy_rows = [row for row in result["rows"] if len(row["pi"])]
            self.assertTrue(policy_rows)
            self.assertEqual({row["playerId"] for row in policy_rows}, {learner_id})
            checked.append(kinds)
            return result

        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory, self.native.worker, self.native.game_worker)
            config = {"targetGames": 2, "minPlayers": 4, "maxPlayers": 4,
                      "selfPlayMode": "random-batch", "charSet": "base", "profile": "fast",
                      "device": "cpu", "mctsSimulations": 4, "mctsParticles": 2,
                      "mctsMaxDepth": 20, "workers": 1, "batchGames": 1,
                      "trainingEpochs": 1, "miniBatch": 32, "checkpointEvery": 1,
                      "historicalPoolSize": 2, "historicalOpponentProbability": 1,
                      "maxRounds": 100, "endDistricts": 7, "weaknessSearchEvery": 0, "seed": 7}
            with patch.object(runtime, "_sample_game", sample), \
                    patch.object(runtime, "random_batch_composition", composition):
                manager.start(config)
                status = self.wait(manager)
            self.assertEqual(status["completedGames"], 2)
            self.assertEqual(checked[0], {"learner", "current"})
            self.assertEqual(checked[1], {"learner", "current", "historical"})


if __name__ == "__main__":
    unittest.main()
