import random
from collections import Counter
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from python_backend.neural import NeuralPolicy


class LiveSelectionTests(unittest.TestCase):
    def test_live_default_samples_search_probability(self):
        actions = [{"type": "gold"}, {"type": "cards"}, {"type": "end_turn"}]
        state = {"phase": "turn"}
        distribution = [0.2, 0.6, 0.2]
        worker = SimpleNamespace(
            determinize=lambda **kwargs: {"particles": [state], "weights": [1.0]},
            search=lambda **kwargs: {"policy": distribution},
        )
        # Exercise the live adapter without loading weights or starting native processes.
        policy = NeuralPolicy.__new__(NeuralPolicy)
        policy.worker = worker
        policy.profile = "fast"
        policy.architecture = "entity-v6"
        policy.device_name = "cpu"
        policy.action_version = 10
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "model.bin"
            model.touch()
            policy.model_path = str(model)
            for options in (None, {"simulations": 7, "maxDepth": 80, "particles": 1}):
                rng = random.Random(42)
                with patch("python_backend.neural.random.Random", return_value=rng):
                    counts = Counter()
                    for _ in range(1000):
                        diagnostics = {}
                        action = policy.decide(state, "p1", {"actions": actions}, options,
                                               diagnostics=diagnostics)
                        counts[actions.index(action)] += 1
                        self.assertEqual(diagnostics["mcts"]["selection"], "sample")
                for i, probability in enumerate(distribution):
                    self.assertAlmostEqual(counts[i] / 1000, probability, delta=0.05)
            distribution[:] = [0.0, 0.0, 1.0]
            self.assertEqual(policy.decide(state, "p1", {"actions": actions}), actions[2])
            distribution[:] = [0.2, 0.6, 0.2]
            self.assertEqual(policy.decide(state, "p1", {"actions": actions},
                                          {"selection": "argmax"}), actions[1])

    def test_neural_autohost_does_not_loop_thieves_den_cancellation(self):
        pay = {"type": "district_effect", "name": "thieves_pay", "uid": "den"}
        cancel = {"type": "district_effect", "name": "thieves_cancel"}
        seen = []
        def search(**kwargs):
            seen.extend(kwargs["legal_actions"])
            return {"policy": [1.]}
        policy = NeuralPolicy.__new__(NeuralPolicy)
        policy.worker = SimpleNamespace(determinize=lambda **kw: {"particles": [{}], "weights": [1.]}, search=search)
        policy.profile = "fast"; policy.architecture = "entity-v6"; policy.device_name = "cpu"; policy.action_version = 10
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.bin"; path.touch(); policy.model_path = str(path)
            available = {"actions": [cancel, pay]}
            self.assertEqual(policy.decide({}, "human", available), pay)
            self.assertEqual(seen, [pay])
            self.assertEqual(available["actions"], [cancel, pay])


if __name__ == "__main__":
    unittest.main()
