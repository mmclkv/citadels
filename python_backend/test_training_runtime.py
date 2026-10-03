"""End-to-end smoke tests for native self-play and MCTS distillation."""
from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.training_runtime import (RecentNetworkMetrics, TrainingManager,
                                            _checkpoint_due)  # noqa: E402


class TrainingRuntimeTests(unittest.TestCase):
    def test_network_strength_metrics_are_recent_per_player_count(self):
        metrics = RecentNetworkMetrics(window=3)
        metrics.add(4, 1.0, 1.0)
        metrics.add(5, -1.0, 0.0)
        metrics.add(4, 0.0, 0.0)
        metrics.add(4, -1.0, 0.0)
        metrics.add(4, -1.0, 0.0)
        snapshot = metrics.snapshot()
        self.assertEqual(snapshot["4"]["games"], 3)
        self.assertAlmostEqual(snapshot["4"]["reward"], -2 / 3)
        self.assertAlmostEqual(snapshot["4"]["winRate"], 0.0)
        self.assertEqual(snapshot["5"]["games"], 1)
        self.assertEqual(snapshot["5"]["reward"], -1.0)

    def test_checkpoint_saves_when_batch_crosses_interval(self):
        self.assertFalse(_checkpoint_due(1984, 1920, 2000, 200000, False))
        self.assertTrue(_checkpoint_due(2048, 1984, 2000, 200000, False))
        self.assertFalse(_checkpoint_due(2064, 2048, 2000, 200000, False))
        self.assertTrue(_checkpoint_due(64, 0, 2000, 64, False))

    def test_mixed_selfplay_uses_native_state_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "selfPlayMode": "network-vs-heuristic", "networkPlayerCount": 1,
                      "heuristicDifficulty": "random", "charSet": "base",
                      "profile": "fast", "networkArchitecture": "entity-v6",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 1,
                      "mctsParticles": 1, "mctsMaxDepth": 12,
                      "batchGames": 1, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 1, "maxRounds": 1, "seed": 8162}
            self.assertTrue(manager.start(config)["running"])
            status = self._wait(manager)
            self.assertEqual(status["state"], "completed", status)
            self.assertEqual(status["completedGames"], 1)
            self.assertEqual(status["point"]["fallbacks"], 0)
            self.assertGreater(status["point"]["policySamples"], 0)

    def test_one_native_selfplay_game_trains_and_saves_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v6",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 1,
                      "batchGames": 1, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 1, "maxRounds": 1, "seed": 8127}
            self.assertTrue(manager.start(config)["running"])
            deadline = time.monotonic() + 60
            while manager.status()["running"] and time.monotonic() < deadline:
                time.sleep(0.05)
            status = manager.status()
            self.assertFalse(status["running"], status)
            self.assertEqual(status["state"], "completed", status)
            self.assertEqual(status["completedGames"], 1)
            point = status["point"]
            self.assertGreaterEqual(point["avgRounds"], 1)
            self.assertGreaterEqual(point["avgInferenceMs"], 0)
            self.assertEqual(point["fallbacks"], 0)
            self.assertIn("2", point["winSeatsByPlayers"])
            self.assertEqual(point["winSeatsByPlayers"]["2"]["games"], 1)
            self.assertEqual(len(point["winSeatsByPlayers"]["2"]["wins"]), 2)
            self.assertIn("torch", status["hardware"])
            self.assertGreaterEqual(status["hardware"]["logicalCores"], 1)
            self.assertIn("memoryGB", status["hardware"])
            self.assertIn("gpuMemoryMB", point)
            self.assertTrue((Path(directory) / status["checkpoint"]).is_file())
            self.assertGreater((Path(directory) / status["checkpoint"]).stat().st_size, 0)

    def test_mcts_policy_distillation_trains_from_search_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v6",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 2,
                      "mctsParticles": 1, "mctsMaxDepth": 10,
                      "batchGames": 1, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 1, "maxRounds": 1, "seed": 8130}
            self.assertTrue(manager.start(config)["running"])
            status = self._wait(manager)
            self.assertEqual(status["state"], "completed", status.get("error"))
            self.assertTrue(status["checkpoint"])
            self.assertTrue(any("ISMCTS=2" in line["text"] for line in status["logs"]))
            self.assertGreater(status["point"]["policySamples"], 0)

    def test_configured_workers_sample_games_in_separate_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory)
            config = {"targetGames": 4, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v6",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 1,
                      "workers": 2, "batchGames": 4, "trainingEpochs": 1, "miniBatch": 32,
                      "checkpointEvery": 4, "maxRounds": 1, "seed": 8131}
            self.assertTrue(manager.start(config)["running"])
            status = self._wait(manager)
            self.assertEqual(status["state"], "completed", status)
            self.assertEqual(status["completedGames"], 4)
            self.assertEqual(status["config"]["workers"], 2)
            self.assertTrue(any("采样进程=2" in line["text"] for line in status["logs"]))
            self.assertGreaterEqual(len(status["point"]["samplerPids"]), 1,
                                    "采样任务应由 spawn 子进程实际执行")

    def test_saved_checkpoint_can_resume_in_python_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v6",
                      "device": "cpu", "mctsSimulations": 1, "batchGames": 1,
                      "trainingEpochs": 1, "miniBatch": 32, "checkpointEvery": 1,
                      "maxRounds": 1, "seed": 8128}
            initial = TrainingManager(directory)
            initial.start(config)
            self._wait(initial)
            checkpoint = initial.status()["checkpoint"]
            self.assertTrue(checkpoint)
            continued = TrainingManager(directory)
            continued.start({**config, "targetGames": 2, "resumeCheckpoint": checkpoint})
            result = self._wait(continued)
            self.assertEqual(result["state"], "completed", result.get("error"))
            self.assertEqual(result["completedGames"], 2)

    @staticmethod
    def _wait(manager):
        deadline = time.monotonic() + 60
        while manager.status()["running"] and time.monotonic() < deadline:
            time.sleep(0.05)
        status = manager.status()
        if status["running"]:
            raise AssertionError("Python training task timed out")
        return status


if __name__ == "__main__":
    unittest.main()
