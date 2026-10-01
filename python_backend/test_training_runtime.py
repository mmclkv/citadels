"""End-to-end smoke test for the Python self-play PPO runtime."""
from __future__ import annotations

import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.training_runtime import TrainingManager  # noqa: E402


class TrainingRuntimeTests(unittest.TestCase):
    def test_one_python_selfplay_game_trains_and_saves_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = TrainingManager(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v5",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 0,
                      "batchGames": 1, "ppoEpochs": 1, "miniBatch": 32,
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
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v5",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 2,
                      "mctsParticles": 1, "mctsMaxDepth": 10, "policyLossMode": "mcts_ce",
                      "batchGames": 1, "ppoEpochs": 1, "miniBatch": 32,
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
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v5",
                      "device": "cpu", "backend": "cpu", "mctsSimulations": 0,
                      "workers": 2, "batchGames": 4, "ppoEpochs": 1, "miniBatch": 32,
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
                      "charSet": "base", "profile": "fast", "networkArchitecture": "entity-v5",
                      "device": "cpu", "mctsSimulations": 0, "batchGames": 1,
                      "ppoEpochs": 1, "miniBatch": 32, "checkpointEvery": 1,
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
