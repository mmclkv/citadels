"""History retention, sampler refresh and isolation from learner targets."""
import gzip
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.historical_policy_pool import HistoricalPolicyPool, assign_seat_policies
from python_backend.training_config import sanitize_config
from python_backend.training_runtime import _sample_game


class HistoricalPolicyPoolTests(unittest.TestCase):
    def checkpoint(self, directory, number, **changes):
        path = Path(directory) / f"checkpoint-{number:06d}-test.json.gz"
        model = {"architecture": "entity-v6", "profile": "fast", "stateSize": 1790,
                 "actionSize": 256, "parameterCount": 4, "flat": [number] * 4,
                 "valueObjective": "win-first-v1", **changes}
        path.write_bytes(gzip.compress(json.dumps({"model": model,
                        "encoding": {"state": 14, "action": 10}}).encode()))
        os.utime(path, ns=(number * 1_000_000_000, number * 1_000_000_000))
        return path

    def test_retention_is_bounded_and_covers_older_and_recent_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for number in range(1, 11):
                self.checkpoint(root, number)
            pool = HistoricalPolicyPool(root, root / "runtime", 4, "fast", 4)
            entries = pool.refresh()
            self.assertEqual({e["checkpoint"] for e in entries},
                             {f"checkpoint-{n:06d}-test.json.gz" for n in (1, 8, 9, 10)})
            old = {e["checkpoint"]: e for e in entries}
            self.checkpoint(root, 11)
            entries = pool.refresh()
            self.assertEqual(len(entries), 4)
            self.assertEqual(len(list(pool.directory.glob("*.bin"))), 4)
            self.assertEqual(json.loads(pool.manifest.read_text())["policies"], entries)
            # Retained weights never become the continually updated learner weights.
            anchor = next(e for e in entries if e["checkpoint"] == "checkpoint-000001-test.json.gz")
            self.assertEqual(anchor, old[anchor["checkpoint"]])
            np.testing.assert_equal(np.fromfile(anchor["modelPath"], dtype="<f4"), [1] * 4)
            restored = HistoricalPolicyPool(root, root / "restart", 4, "fast", 4)
            self.assertEqual([e["checkpoint"] for e in restored.refresh()],
                             [e["checkpoint"] for e in entries])

    def test_incompatible_and_corrupt_files_are_skipped_and_backfilled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.checkpoint(root, 1)
            self.checkpoint(root, 2, profile="large")
            self.checkpoint(root, 3, valueObjective="rank")
            self.checkpoint(root, 4, flat=[float("nan")] * 4)
            self.checkpoint(root, 5, flat=[1])
            corrupt = self.checkpoint(root, 6)
            corrupt.write_bytes(b"invalid")
            malformed = self.checkpoint(root, 7)
            malformed.write_bytes(gzip.compress(b"[]"))
            self.checkpoint(root, 8)
            pool = HistoricalPolicyPool(root, root / "runtime", 2, "fast", 4)
            entries = pool.refresh()
            self.assertEqual(len(entries), 2)
            self.assertEqual({e["checkpoint"] for e in entries},
                             {"checkpoint-000001-test.json.gz", "checkpoint-000008-test.json.gz"})

    def test_verified_specialists_get_reserved_pool_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self.checkpoint(root, 1)
            with gzip.open(original, "rt", encoding="utf-8") as handle:
                data = json.load(handle)
            original.unlink()
            data["weaknessSearch"] = {"accepted": True}
            specialist = root / "checkpoint-000001-opponent-7.json.gz"
            specialist.write_bytes(gzip.compress(json.dumps(data).encode()))
            os.utime(specialist, ns=(1_000_000_000, 1_000_000_000))
            data["weaknessSearch"] = {"accepted": False}
            (root / "checkpoint-000002-opponent-8.json.gz").write_bytes(gzip.compress(json.dumps(data).encode()))
            for number in range(3, 15):
                self.checkpoint(root, number)
            pool = HistoricalPolicyPool(root, root / "runtime", 4, "fast", 4)
            entries = pool.refresh()
            self.assertEqual(len(entries), 4)
            self.assertIn(specialist.name, [entry["checkpoint"] for entry in entries])
            self.assertEqual(next(e for e in entries if e["checkpoint"] == specialist.name)["kind"], "weakness-opponent")
            self.assertNotIn("checkpoint-000002-opponent-8.json.gz", [e["checkpoint"] for e in entries])

    def test_assignments_reserve_learner_rotate_seats_and_refresh_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.checkpoint(root, 1)
            pool = HistoricalPolicyPool(root, root / "runtime", 2, "fast", 4)
            pool.refresh()
            current = root / "current.bin"
            current.write_bytes(b"current")
            config = {**sanitize_config({"historicalOpponentProbability": 1}),
                      "nativeModelPath": str(current), "historicalPoolManifest": str(pool.manifest)}
            for learner in range(8):
                first = assign_seat_policies(config, set(range(8)), learner, np.random.default_rng(7))
                second = assign_seat_policies(config, set(range(8)), learner, np.random.default_rng(7))
                self.assertEqual(first, second)
                self.assertFalse(first[learner]["historical"])
                self.assertEqual(sum(p["historical"] for p in first.values()), 7)
            self.checkpoint(root, 2)
            pool.refresh()
            seen = set()
            for seed in range(20):
                result = assign_seat_policies(config, {0, 1}, 0, np.random.default_rng(seed))
                seen.add(result[1]["checkpoint"])
            self.assertEqual(len(seen), 2, "already initialized samplers must see newly published history")
            config["historicalOpponentProbability"] = 0.5
            counts = set()
            versions = set()
            for seed in range(20):
                result = assign_seat_policies(config, set(range(8)), 0, np.random.default_rng(seed))
                counts.add(sum(p["historical"] for p in result.values()))
                versions.update(p["checkpoint"] for p in result.values() if p["historical"])
            self.assertGreater(len(counts), 1)
            self.assertEqual(len(versions), 2)
            config["historicalPoolSize"] = 0
            self.assertFalse(any(p["historical"] for p in
                             assign_seat_policies(config, {0, 1}, 0, np.random.default_rng(7)).values()))

    def test_empty_history_and_single_network_seat_keep_current_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool = HistoricalPolicyPool(root, root / "runtime", 2, "fast", 4)
            pool.refresh()
            current = root / "current.bin"
            current.touch()
            config = {**sanitize_config({}), "nativeModelPath": str(current),
                      "historicalPoolManifest": str(pool.manifest)}
            self.assertFalse(any(p["historical"] for p in
                             assign_seat_policies(config, {0, 1}, 0, np.random.default_rng(2)).values()))
            self.checkpoint(root, 1)
            pool.refresh()
            self.assertFalse(assign_seat_policies(config, {1}, 1, np.random.default_rng(2))[1]["historical"])

    def test_historical_actions_are_executed_but_excluded_from_training_and_metrics(self):
        class Game:
            steps = 0
            def create_game(self, options, game_id):
                self.players = options["seats"]
                return {"players": self.players}
            def current(self, *args, **kwargs):
                return {"gameOver": self.steps >= 2, "round": 1,
                        "playerId": self.players[min(self.steps, 1)]["id"],
                        "valueObjective": "win-first-v1", "valueRewards": [1., -1.],
                        "rewards": [1., -1.]}
            def decision(self, *args):
                return {"playerId": self.players[self.steps]["id"], "state": {},
                        "round": 1, "actions": [{"type": "one"}, {"type": "two"}]}
            def apply(self, **kwargs):
                self.steps += 1
            def snapshot(self, *args):
                return {"players": [{"city": [{"cost": 3}]}, {"city": []}], "round": 1}
            def close_game(self, *args):
                pass
        class Search:
            calls = []
            def determinize(self, **kwargs):
                return {"particles": [{}], "weights": [1.]}
            def search(self, **kwargs):
                self.calls.append(kwargs)
                result = {"policy": [0.5, 0.5]}
                if kwargs["include_training_features"]:
                    result.update(stateFeatures=[0] * 1790, actionFeatures=[[0] * 256] * 2)
                return result
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.checkpoint(root, 1)
            pool = HistoricalPolicyPool(root, root / "runtime", 2, "fast", 4)
            pool.refresh()
            current = root / "current.bin"
            current.touch()
            config = {**sanitize_config({"minPlayers": 2, "maxPlayers": 2,
                                        "historicalOpponentProbability": 1}),
                      "nativeModelPath": str(current), "historicalPoolManifest": str(pool.manifest)}
            search = Search()
            with patch("python_backend.training_runtime._native_worker", return_value=search), \
                 patch("python_backend.training_runtime._game_worker", return_value=Game()):
                result = _sample_game(config, 1, threading.Event())
            self.assertEqual(len(result["rows"]), 1)
            self.assertEqual(result["rows"][0]["playerId"], "train-1-0")
            self.assertEqual(result["networkWin"], 1.)
            self.assertEqual(result["networkPlayerCount"], 1)
            self.assertEqual(result["historicalPlayers"], 1)
            self.assertEqual(search.calls[0]["model_path"], str(current))
            self.assertNotEqual(search.calls[1]["model_path"], str(current))
            self.assertFalse(search.calls[1]["include_training_features"])
            self.assertEqual(search.calls[1]["dirichlet_epsilon"], 0)


if __name__ == "__main__":
    unittest.main()
