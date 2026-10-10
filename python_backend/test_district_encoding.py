import os
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from python_backend.model_contract import MODEL_CONTRACTS, validate_checkpoint_contract


class DistrictEncodingTests(unittest.TestCase):
    def test_contract_does_not_mix_legacy_and_expanded_layouts(self):
        for state, action, sw, aw in ((14, 9, 1790, 256), (14, 10, 1790, 256), (15, 11, 2054, 448)):
            checkpoint = {"model": {"architecture": "entity-v6", "stateSize": sw, "actionSize": aw},
                          "encoding": {"state": state, "action": action}}
            self.assertEqual(validate_checkpoint_contract(checkpoint, "entity-v6"),
                             {"state": state, "action": action, "stateSize": sw, "actionSize": aw})
            for field in ("stateSize", "actionSize"):
                broken = {**checkpoint, "model": {**checkpoint["model"], field: 1}}
                with self.assertRaises(ValueError):
                    validate_checkpoint_contract(broken, "entity-v6")
        for state, action in ((14, 11), (15, 10), (15, 9)):
            checkpoint = {"model": {"architecture": "entity-v6", "stateSize": 2054, "actionSize": 448},
                          "encoding": {"state": state, "action": action}}
            with self.assertRaises(ValueError):
                validate_checkpoint_contract(checkpoint, "entity-v6")

    def test_native_all_districts_context_and_privacy(self):
        compiler = shutil.which("clang++")
        if not compiler:
            self.skipTest("clang++ required")
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="citadels-district-encoding-") as directory:
            exe = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            result = subprocess.run([compiler, str(root / "native/district_encoding_regression.cpp"),
                                     "-std=c++17", "-O2", "-o", str(exe)],
                                    capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(exe)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_training_can_learn_new_identity_and_dimensions_match(self):
        import torch
        from training.entity_transformer import EntityTransformerNet
        from python_backend.training_runtime import _entity_forward_probe_inputs, _entity_parameter_count
        torch.set_num_threads(1)
        torch.manual_seed(71)
        model = EntityTransformerNet("fast")
        contract = MODEL_CONTRACTS["entity-v6"]
        self.assertEqual(model.state_size, contract["stateSize"])
        self.assertEqual(model.action_size, contract["actionSize"])
        self.assertEqual(model.city_embed.weight.shape, (55, 8))
        self.assertEqual(sum(p.numel() for p in model.parameters()), _entity_parameter_count("fast"))
        state, actions = _entity_forward_probe_inputs()[0]
        state = torch.from_numpy(state)[None]
        actions = torch.from_numpy(actions)[None]
        optimizer = torch.optim.Adam(model.parameters(), lr=.001)
        before = model.city_embed.weight.detach().clone()
        logits, values = model(state, actions)
        loss = logits.square().mean() + values.square().mean()
        loss.backward()
        self.assertGreater(model.city_embed.weight.grad[31:].abs().sum().item(), 0)
        optimizer.step()
        self.assertFalse(torch.equal(before[31:], model.city_embed.weight[31:]))
        torch.testing.assert_close(model.city_embed.weight[0], torch.zeros(8))
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / "model.bin")
            model.save_flat(path)
            loaded = EntityTransformerNet("fast")
            loaded.load_flat(path)
            for expected, actual in zip(model.parameters(), loaded.parameters()):
                torch.testing.assert_close(expected, actual, rtol=0, atol=0)
            with self.assertRaises(ValueError):
                EntityTransformerNet("fast", encoding_version=14).load_flat(path)

    def test_old_worker_cannot_claim_new_state_contract(self):
        from python_backend.native_worker import NativeMctsWorker
        check = NativeMctsWorker._validate_search_encoding
        result = {"actionEncodingVersion": 11, "supportedActionEncodingVersion": 11}
        with self.assertRaises(RuntimeError):
            check(result, 11)
        check({**result, "stateEncodingVersion": 15}, 11)

    def test_training_rejects_old_widths_and_history(self):
        import numpy as np
        import torch
        from python_backend.training_runtime import _training_data
        from python_backend.historical_policy_pool import HistoricalPolicyPool
        self.assertEqual(tuple(_training_data(torch, [])['states'].shape), (0, 2054))
        for state_width, action_width in ((1790, 448), (2054, 256)):
            with self.assertRaises(ValueError):
                _training_data(torch, [{'state': np.zeros(state_width),
                                        'actions': np.zeros((1, action_width))}])
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            checkpoint = {"model": {"architecture": "entity-v6", "profile": "fast",
                          "stateSize": 1790, "actionSize": 256, "parameterCount": 4,
                          "flat": [0] * 4, "valueObjective": "win-first-v1"},
                          "encoding": {"state": 14, "action": 10}}
            (root / 'checkpoint-legacy.json.gz').write_bytes(gzip.compress(json.dumps(checkpoint).encode()))
            messages = []
            pool = HistoricalPolicyPool(root, root / 'runtime', 2, 'fast', 4, messages.append)
            self.assertEqual(pool.refresh(), [])
            self.assertTrue(any('需先迁移' in text for text in messages))


if __name__ == "__main__":
    unittest.main()
