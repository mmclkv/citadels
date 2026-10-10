"""Held-out admission, real policy gradients and frozen incumbent isolation."""
import copy
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.training_config import sanitize_config
from python_backend.training_runtime import _load_trainer, _training_data
from python_backend.weakness_search import (WeaknessSearch, discovery_due, evaluate_pairs,
                                           train_response_policy)


def pair(baseline_target=True, candidate_target=False, baseline_own=False, candidate_own=True):
    return {"baseline": {"completed": True, "targetFirst": baseline_target,
                         "challengerFirst": baseline_own, "playerCount": 4},
            "candidate": {"completed": True, "targetFirst": candidate_target,
                          "challengerFirst": candidate_own, "playerCount": 4}}


class WeaknessSearchTests(unittest.TestCase):
    def test_trigger_obeys_interval_and_pool_enablement(self):
        config = sanitize_config({})
        self.assertFalse(discovery_due(1999, 0, config))
        self.assertTrue(discovery_due(2001, 0, config))
        self.assertFalse(discovery_due(2010, 2001, config))
        self.assertTrue(discovery_due(4000, 2001, config))
        for key in ("historicalPoolSize", "historicalOpponentProbability", "weaknessSearchEvery"):
            self.assertFalse(discovery_due(4000, 0, {**config, key: 0}))

    def test_exact_paired_admission_rejects_noise_sabotage_and_incomplete_games(self):
        self.assertFalse(evaluate_pairs([pair()] * 4, 4)["accepted"])
        result = evaluate_pairs([pair()] * 5, 5)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["pValue"], 1 / 32)
        self.assertFalse(evaluate_pairs([pair(candidate_own=False)] * 10, 10)["accepted"])
        self.assertFalse(evaluate_pairs([pair(False, True)] * 10, 10)["accepted"])
        self.assertFalse(evaluate_pairs([pair()] * 5, 6)["accepted"])
        missing = pair()
        missing["candidate"]["completed"] = False
        self.assertFalse(evaluate_pairs([pair()] * 5 + [missing], 6)["accepted"])
        self.assertEqual(evaluate_pairs([], 32)["pValue"], 1)

    def test_policy_gradient_changes_challenger_but_preserves_main_and_rng(self):
        torch, trainer = _load_trainer()
        torch.set_num_threads(1)
        class Model(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.policy = torch.nn.Parameter(torch.zeros(2))
                self.value = torch.nn.Parameter(torch.zeros(8))
            def forward(self, states, actions, masks):
                count = len(states)
                return self.policy[None, :].expand(count, 2), self.value[None, :].expand(count, 8)
            def save_flat(self, path):
                torch.cat([self.policy, self.value]).detach().numpy().astype("<f4").tofile(path)
        def row():
            return {"state": np.zeros(2054, np.float32), "actions": np.zeros((2, 448), np.float32),
                    "pi": np.array([.5, .5], np.float32), "reward": np.array([1., -1.] + [0.] * 6, np.float32),
                    "valueMask": np.array([1., 1.] + [0.] * 6, np.float32),
                    "chosenAction": 0, "behaviorProbability": .5}
        main = Model()
        candidate = copy.deepcopy(main)
        updates = train_response_policy(torch, trainer, candidate,
                    torch.optim.Adam(candidate.parameters(), lr=.1), torch.device("cpu"),
                    [row()], _training_data, 2, 32, threading.Event())
        self.assertEqual(updates, 2)
        self.assertGreater(float(torch.softmax(candidate.policy.detach(), dim=0)[0]), .5)
        self.assertTrue(torch.equal(main.policy, torch.zeros(2)))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = sanitize_config({"device": "cpu", "learningRate": .1,
                                      "weaknessTrainingGames": 1, "weaknessEvaluationPairs": 5,
                                      "minPlayers": 4, "maxPlayers": 8, "batchGames": 1})
            calls = []
            frozen = []
            def sample(config, number, stop):
                case = config["weaknessRun"]
                calls.append((config["seed"], number, case.copy()))
                frozen.append(Path(case["targetPolicy"]["modelPath"]).read_bytes())
                if not case["evaluation"]:
                    return {"completed": True, "rows": [row()]}
                trained = Path(config["nativeModelPath"]).name == "candidate.bin"
                return {"completed": True, "playerCount": case["playerCount"],
                        "targetFirst": not trained, "challengerFirst": trained}
            torch.manual_seed(42)
            before_rng = torch.get_rng_state().clone()
            before_weights = {k: v.clone() for k, v in main.state_dict().items()}
            search = WeaknessSearch(torch, trainer, torch.device("cpu"), config, root / "data",
                                    root / "runtime", sample, _training_data, threading.Event(), lambda s: None)
            result = search.run(main, 2000, [])
            self.assertTrue(result["accepted"])
            self.assertGreater(result["updates"], 0)
            self.assertTrue((root / "data" / result["checkpoint"]).is_file())
            self.assertEqual(len(list((root / "data" / "weakness-search").glob("*.json"))), 1)
            self.assertEqual(len(set(frozen)), 1)
            self.assertTrue(torch.equal(before_rng, torch.get_rng_state()))
            for name, value in main.state_dict().items():
                self.assertTrue(torch.equal(value, before_weights[name]))
            self.assertEqual({case["playerCount"] for _, _, case in calls[1:]}, set(range(4, 9)))
            self.assertNotEqual(calls[0][0], calls[1][0], "held-out seed must differ from training")
            for first, second in zip(calls[1::2], calls[2::2]):
                self.assertEqual(first, second, "each paired case must have identical seats and seed")

    def test_stop_never_admits_partial_candidate(self):
        torch, trainer = _load_trainer()
        torch.set_num_threads(1)
        model = trainer.create_model("entity-v6", "fast")
        stop = threading.Event()
        stop.set()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            search = WeaknessSearch(torch, trainer, torch.device("cpu"), sanitize_config({}),
                                    root / "data", root / "runtime", lambda *args: None,
                                    _training_data, stop, lambda message: None)
            result = search.run(model, 2000, [])
            self.assertTrue(result["cancelled"])
            self.assertFalse(result["accepted"])
            self.assertEqual(list((root / "data").glob("checkpoint-*.json.gz")), [])


if __name__ == "__main__":
    unittest.main()
