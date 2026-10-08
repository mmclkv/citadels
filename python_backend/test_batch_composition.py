"""Batch count invariants and exact, reproducible sampler assignments."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.batch_composition import random_batch_composition
from python_backend.historical_policy_pool import assign_seat_policies
from python_backend.training_config import sanitize_config
from python_backend import training_runtime


class BatchCompositionTests(unittest.TestCase):
    def test_count_invariants_and_diversity_across_player_counts(self):
        for count in range(2, 9):
            config = sanitize_config({"minPlayers": count, "maxPlayers": count})
            seen = set()
            for first_game in range(1, 513):
                plan = random_batch_composition(config, first_game, True)
                self.assertEqual(plan, random_batch_composition(config, first_game, True))
                self.assertEqual(plan["main"] + plan["historical"] + plan["heuristic"], count)
                self.assertGreaterEqual(plan["main"], 1)
                self.assertGreaterEqual(plan["historical"], 0)
                self.assertGreaterEqual(plan["heuristic"], 0)
                seen.add((plan["main"], plan["historical"], plan["heuristic"]))
            self.assertEqual(len(seen), count * (count + 1) // 2)

    def test_empty_or_disabled_history_falls_back_to_current_models(self):
        config = sanitize_config({"minPlayers": 8, "maxPlayers": 8})
        for first_game in range(1, 40):
            original = random_batch_composition(config, first_game, True)
            for available, settings in ((False, config), (True, {**config, "historicalPoolSize": 0}),
                                        (True, {**config, "historicalOpponentProbability": 0})):
                plan = random_batch_composition(settings, first_game, available)
                self.assertEqual(plan["historical"], 0)
                self.assertEqual(plan["main"], original["main"] + original["historical"])
                self.assertEqual(plan["heuristic"], original["heuristic"])

    def test_player_range_and_legacy_modes(self):
        config = sanitize_config({"minPlayers": 4, "maxPlayers": 8})
        self.assertEqual({random_batch_composition(config, n, True)["players"] for n in range(1, 100)}, set(range(4, 9)))
        for mode in ("curriculum", "all-network", "network-vs-heuristic"):
            self.assertIsNone(random_batch_composition({**config, "selfPlayMode": mode}, 1, True))

    def test_exact_history_count_and_reserved_rotating_learner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "current.bin"
            current.touch()
            manifest = root / "pool.json"
            manifest.write_text(json.dumps({"policies": [{"checkpoint": "old", "modelPath": "old.bin",
                                                          "modelVersion": 1, "actionEncodingVersion": 10}]}))
            config = {**sanitize_config({}), "nativeModelPath": str(current),
                      "historicalPoolManifest": str(manifest)}
            for count in range(2, 9):
                for history in range(count):
                    for learner in range(count):
                        composition = {"players": count, "main": count - history,
                                       "historical": history, "heuristic": 0}
                        settings = {**config, "batchComposition": composition}
                        result = assign_seat_policies(settings, set(range(count)), learner, np.random.default_rng(17))
                        self.assertFalse(result[learner]["historical"])
                        self.assertEqual(sum(policy["historical"] for policy in result.values()), history)

    def test_spawn_task_uses_producer_composition_without_mutating_worker_config(self):
        config = sanitize_config({})
        stop = threading.Event()
        composition = {"players": 5, "main": 2, "historical": 1, "heuristic": 2}
        with patch.object(training_runtime, "_SAMPLER_CONFIG", config), \
             patch.object(training_runtime, "_SAMPLER_STOP", stop), \
             patch.object(training_runtime, "_sample_game", return_value={"done": True}) as sample:
            self.assertEqual(training_runtime._sample_game_in_worker((7, composition)), {"done": True})
            self.assertEqual(sample.call_args.args[0]["batchComposition"], composition)
            self.assertEqual(sample.call_args.args[1], 7)
            self.assertNotIn("batchComposition", config)


if __name__ == "__main__":
    unittest.main()
