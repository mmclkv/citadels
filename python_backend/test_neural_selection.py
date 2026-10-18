import random
from collections import Counter
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from python_backend.neural import NeuralPolicy


class LiveSelectionTests(unittest.TestCase):
    def test_collapsed_options_follow_budget_and_ignore_stale_manual_limits(self):
        from python_backend.rooms import RoomRegistry, _seat_mcts, _seat_heuristic_mcts
        from unittest.mock import Mock
        policy = NeuralPolicy.__new__(NeuralPolicy)
        policy.worker = SimpleNamespace(
            determinize=lambda **kwargs: {"particles": [{}], "weights": [1.]},
            search=Mock(return_value={"policy": [1., 0.], "visits": 6000}))
        policy.model_path = __file__
        policy.profile = "fast"; policy.architecture = "entity-v6"
        policy.device_name = "cpu"; policy.action_version = 11
        defaults = RoomRegistry().create_room("Host", {"bots": 1})["seats"][1]["mcts"]
        self.assertFalse(defaults["advancedEnabled"])
        for budget, depth in ((100, 64), (1000, 70), (10000, 700), (60000, 2000)):
            options = _seat_mcts({"advancedEnabled": False, "timeBudgetMs": budget,
                                  "simulations": 2, "maxDepth": 1, "particles": 1})
            diagnostics = {}
            policy.decide({}, "p1", {"actions": [{"type": "take_gold"}, {"type": "take_cards"}]}, options,
                          diagnostics=diagnostics)
            request = policy.worker.search.call_args.kwargs
            self.assertEqual(request["simulations"], 2_147_483_647)
            self.assertEqual(request["max_depth"], depth)
            self.assertEqual(request["time_budget_ms"], budget)
            self.assertTrue(diagnostics["mcts"]["automatic"])
        options = _seat_mcts({"advancedEnabled": True, "timeBudgetMs": 10000,
                              "simulations": 20, "maxDepth": 10, "particles": 2})
        policy.decide({}, "p1", {"actions": [{"type": "take_gold"}, {"type": "take_cards"}]}, options)
        request = policy.worker.search.call_args.kwargs
        self.assertEqual((request["simulations"], request["max_depth"]), (20, 10))
        policy.worker.search.reset_mock()
        policy.decide({}, "p1", {"actions": [{"type": "end_turn"}]}, defaults)
        policy.worker.search.assert_not_called()
        self.assertNotIn("advanced", _seat_heuristic_mcts({"advancedEnabled": False,
                          "advanced": {"simulations": 1, "maxDepth": 1}}))

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
            self.assertEqual(seen, [])  # A forced payment needs no search.
            self.assertEqual(available["actions"], [cancel, pay])


if __name__ == "__main__":
    unittest.main()
