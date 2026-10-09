import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from python_backend.neural import NeuralPolicy


class LiveSelectionTests(unittest.TestCase):
    def test_live_default_chooses_largest_search_probability(self):
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
                for _ in range(20):
                    diagnostics = {}
                    self.assertEqual(policy.decide(state, "p1", {"actions": actions}, options,
                                                   diagnostics=diagnostics), actions[1])
                    self.assertEqual(diagnostics["mcts"]["selection"], "argmax")
            distribution[:] = [0.4, 0.4, 0.2]
            self.assertEqual(policy.decide(state, "p1", {"actions": actions}), actions[0])


if __name__ == "__main__":
    unittest.main()
