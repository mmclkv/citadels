import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from python_backend.model_contract import MODEL_CONTRACTS, validate_checkpoint_contract


class ActionInstanceTests(unittest.TestCase):
    def test_stale_worker_cannot_silently_encode_v10(self):
        from python_backend.native_worker import NativeMctsWorker
        check = NativeMctsWorker._validate_search_encoding
        check({}, 9)
        check({'actionEncodingVersion': 10, 'supportedActionEncodingVersion': 10}, 10)
        for response in ({}, {'actionEncodingVersion': 9, 'supportedActionEncodingVersion': 10},
                         {'actionEncodingVersion': 10, 'supportedActionEncodingVersion': 9}):
            with self.assertRaises(RuntimeError):
                check(response, 10)

    def test_native_instance_features_and_legacy_prefix(self):
        compiler = shutil.which("clang++")
        if not compiler:
            self.skipTest("clang++ required")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-action-instance-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run([compiler, str(root / "native/action_instance_regression.cpp"),
                                       "-std=c++17", "-O2", "-o", str(executable)],
                                      capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                                    env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_checkpoint_keeps_declared_encoding(self):
        for version in (9, 10):
            checkpoint = {"model": {"architecture": "entity-v6", "stateSize": 1790, "actionSize": 256},
                          "encoding": {"state": 14, "action": version}}
            self.assertEqual(validate_checkpoint_contract(checkpoint, "entity-v6")["action"], version)
        self.assertEqual(MODEL_CONTRACTS["entity-v6"]["action"], 10)
        checkpoint["encoding"]["action"] = 11
        with self.assertRaises(ValueError):
            validate_checkpoint_contract(checkpoint, "entity-v6")

    def test_migration_preserves_logits_and_clears_new_moments(self):
        import torch
        from training.entity_transformer import EntityTransformerNet, migrate_action_encoding
        torch.set_num_threads(1)
        torch.manual_seed(71)
        model = EntityTransformerNet("fast").eval()
        optimizer = torch.optim.Adam(model.parameters())
        weight = model.action_embed.weight
        optimizer.state[weight] = {"step": torch.tensor(1.), "exp_avg": torch.ones_like(weight),
                                   "exp_avg_sq": torch.ones_like(weight)}
        states = torch.zeros(1, 1790); states[0, 1] = .5
        actions = torch.randn(1, 2, 256); actions[..., 182:244] = 0
        extended = actions.clone(); extended[..., 182:244] = torch.rand(1, 2, 62)
        with torch.no_grad():
            old_logits, old_values = model(states, actions)
        self.assertTrue(migrate_action_encoding(model, optimizer, 9))
        with torch.no_grad():
            new_logits, new_values = model(states, extended)
        torch.testing.assert_close(old_logits, new_logits, rtol=0, atol=0)
        torch.testing.assert_close(old_values, new_values, rtol=0, atol=0)
        self.assertTrue((optimizer.state[weight]["exp_avg"][:, 182:244] == 0).all())
        self.assertTrue((optimizer.state[weight]["exp_avg"][:, :182] == 1).all())
        self.assertFalse(migrate_action_encoding(model, optimizer, 10))


if __name__ == "__main__":
    unittest.main()
