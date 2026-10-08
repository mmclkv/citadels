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


if __name__ == "__main__":
    unittest.main()
