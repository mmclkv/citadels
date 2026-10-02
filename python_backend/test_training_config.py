"""Verify Python launcher configuration and reject stale PPO fields."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.training_config import sanitize_config  # noqa: E402

class PythonTrainingConfigTests(unittest.TestCase):
    def test_native_search_is_canonical_even_for_legacy_checkpoint_fields(self):
        result = sanitize_config({"rulesEngine": "js", "mctsEngine": "cpp",
            "neuralNetworkFramework": "libtorch", "nativeInferenceBackend": "libtorch",
            "backend": "native", "mctsEvaluator": "native", "mctsBatchSize": 8,
            "mctsMaxWaitMs": 3, "mctsCacheSize": 0, "device": "cpu"})
        self.assertEqual(result["rulesEngine"], "cpp")
        self.assertEqual(result["mctsEngine"], "cpp")
        self.assertEqual(result["neuralNetworkFramework"], "libtorch")
        self.assertEqual(result["backend"], "python")
        self.assertEqual(result["device"], "cpu")
        self.assertEqual(result["mctsBatchSize"], 8)
        self.assertEqual(sanitize_config({})["mctsSimulations"], 500)
        self.assertEqual(sanitize_config({})["mctsMaxDepth"], 700)
        self.assertEqual(sanitize_config({})["mctsBatchSize"], 32)
        for obsolete in ("nativeInferenceBackend", "nativeSearchWorker", "mctsEvaluator",
                         "mctsMaxWaitMs", "mctsCacheSize",
                         "ppoEpochs", "policyLossMode", "trainNetworkOnly"):
            self.assertNotIn(obsolete, result)

    def test_numeric_and_curriculum_options_are_still_sanitized(self):
        result = sanitize_config({"targetGames": -4, "minPlayers": 99, "maxPlayers": 2,
            "profile": "unknown", "batchGames": 500, "miniBatch": 12, "seed": -7,
            "networkArchitecture": "entity-v5", "mctsSimulations": 2500,
            "mctsParticles": 2.5, "mctsDirichletAlpha": 0,
            "mctsDirichletEpsilon": 1, "selfPlayMode": "curriculum",
            "curriculumStartPlayers": 2.5, "curriculumEndPlayers": 5.5,
            "curriculumStepGames": None})
        self.assertEqual(result["targetGames"], 1)
        self.assertEqual(result["minPlayers"], 8)
        self.assertEqual(result["maxPlayers"], 8)
        self.assertEqual(result["profile"], "balanced")
        self.assertEqual(result["batchGames"], 256)
        self.assertEqual(result["miniBatch"], 32)
        self.assertEqual(result["seed"], -7)
        self.assertEqual(result["networkArchitecture"], "entity-v5")
        self.assertEqual(result["mctsSimulations"], 2500)
        self.assertEqual(result["mctsParticles"], 3)
        self.assertEqual(result["mctsDirichletAlpha"], 0)
        self.assertEqual(result["mctsDirichletEpsilon"], 1)
        self.assertEqual(result["selfPlayMode"], "curriculum")
        self.assertEqual(result["curriculumStartPlayers"], 3)
        self.assertEqual(result["curriculumEndPlayers"], 6)
        self.assertEqual(result["curriculumStepGames"], 1)

    def test_cpp_rules_engine_is_canonical(self):
        self.assertEqual(sanitize_config({"rulesEngine": "cpp"})["rulesEngine"], "cpp")


if __name__ == "__main__":
    unittest.main()
