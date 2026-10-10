import gzip
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from python_backend.model_contract import ENCODING_CONTRACTS, checkpoint_resume_plan, config_contract
from python_backend.training_config import sanitize_config
from python_backend.training_runtime import (_entity_forward_probe_inputs, _entity_parameter_count,
                                             _training_data, TrainingManager)
from python_backend.server import PythonServer
from training.entity_transformer import EntityTransformerNet, migrate_model_weights


def checkpoint(pair, profile='fast'):
    contract = ENCODING_CONTRACTS[pair]
    return {'model': {'architecture': 'entity-v6', 'profile': profile,
                     'stateSize': contract['stateSize'], 'actionSize': contract['actionSize']},
            'encoding': {'state': pair[0], 'action': pair[1]}}


class EncodingMigrationTests(unittest.TestCase):
    def test_every_source_target_pair_and_scale(self):
        allowed = {((14, 9), (14, 10)), ((14, 9), (15, 11)), ((14, 10), (15, 11))}
        for source in ENCODING_CONTRACTS:
            for target in ENCODING_CONTRACTS:
                for profile in ('fast', 'balanced', 'large'):
                    if source == target or (source, target) in allowed:
                        plan = checkpoint_resume_plan(checkpoint(source, profile), *target, profile)
                        self.assertEqual(plan['resetOptimizer'], source != target)
                        self.assertEqual(plan['mode'] == 'direct', source == target)
                    else:
                        with self.assertRaises(ValueError):
                            checkpoint_resume_plan(checkpoint(source, profile), *target, profile)
        with self.assertRaisesRegex(ValueError, '网络规模不匹配'):
            checkpoint_resume_plan(checkpoint((14, 10)), 15, 11, 'large')
        for pair in ((14, 11), (15, 9), (15, 10), (16, 12)):
            with self.assertRaises(ValueError):
                sanitize_config({'stateEncodingVersion': pair[0], 'actionEncodingVersion': pair[1]})
        self.assertEqual(config_contract(sanitize_config({})), ENCODING_CONTRACTS[(15, 11)])

    def test_migration_preserves_logits_and_value_on_extended_features(self):
        torch.set_num_threads(1)
        for old_action, target_pair in ((9, (14, 10)), (9, (15, 11)), (10, (15, 11))):
            torch.manual_seed(71)
            source = EntityTransformerNet('fast', encoding_version=14).eval()
            target = EntityTransformerNet('fast', encoding_version=target_pair[0]).eval()
            migrate_model_weights(source, target, old_action, target_pair[1])
            state, actions = _entity_forward_probe_inputs(14)[0]
            if old_action == 9:
                actions[:, 182:] = 0
            expanded_actions = np.zeros((len(actions), target.action_size), np.float32)
            expanded_actions[:, :256] = actions
            if old_action == 9:
                expanded_actions[:, 182:] = .5
            else:
                expanded_actions[:, 256:] = .5
            if target_pair[0] == 15:
                expanded = np.zeros(2054, np.float32)
                expanded[:1504] = state[:1504]
                expanded[1504:1534] = state[1504:1534]
                expanded[1534:1558] = .5
                expanded[1558:1814] = state[1534:1790]
                expanded[1814:] = .5
                expanded[0] = 15
                # New city identity was unknown in the old model, with the same
                # visible cost/color/score attributes in both representations.
                state[32+56+15*8+3] = 0
                expanded[32+56+15*8+3] = 54
                self.assertTrue((target.city_embed.weight[31:] == 0).all())
                torch.testing.assert_close(target.city_embed.weight[:31], source.city_embed.weight)
            else:
                expanded = state.copy()
            with torch.inference_mode():
                old_logits, old_values = source(torch.from_numpy(state)[None], torch.from_numpy(actions)[None])
                new_logits, new_values = target(torch.from_numpy(expanded)[None], torch.from_numpy(expanded_actions)[None])
            torch.testing.assert_close(old_logits, new_logits, rtol=1e-5, atol=1e-5)
            torch.testing.assert_close(old_values, new_values, rtol=1e-5, atol=1e-5)
            if target_pair[0] == 15:
                logits, values = target(torch.from_numpy(expanded)[None], torch.from_numpy(expanded_actions)[None])
                (logits.square().mean() + values.square().mean()).backward()
                self.assertGreater(target.city_embed.weight.grad[54].abs().sum().item(), 0)
                self.assertGreater(target.self_embed.weight.grad[:, 326:].abs().sum().item(), 0)
                self.assertGreater(target.action_embed.weight.grad[:, 256:].abs().sum().item(), 0)

    def test_direct_resume_is_exact_and_downgrade_is_rejected(self):
        torch.set_num_threads(1)
        for state, action in ENCODING_CONTRACTS:
            source = EntityTransformerNet('fast', encoding_version=state)
            target = EntityTransformerNet('fast', encoding_version=state)
            migrate_model_weights(source, target, action, action)
            for a, b in zip(source.parameters(), target.parameters()):
                torch.testing.assert_close(a, b, rtol=0, atol=0)
        with self.assertRaises(ValueError):
            migrate_model_weights(EntityTransformerNet('fast'), EntityTransformerNet('fast', encoding_version=14), 11, 10)

    def test_console_inspection_has_all_target_plans(self):
        metadata = PythonServer._checkpoint_metadata('checkpoint-old.json.gz', checkpoint((14, 9)))
        self.assertEqual(set(metadata['resumePlans']), {'14/9', '14/10', '15/11'})
        self.assertEqual(metadata['resumePlans']['14/9']['mode'], 'direct')
        self.assertEqual(metadata['resumePlans']['14/10']['mode'], 'action-v9-v10')
        self.assertEqual(metadata['resumePlans']['15/11']['mode'], 'district-v14-v15')
        self.assertTrue(metadata['encodingCompatible'])
        unknown = checkpoint((14, 9)); unknown['encoding']['action'] = 8
        self.assertFalse(PythonServer._checkpoint_metadata('bad', unknown)['encodingCompatible'])
        for invalid in ({'model': ['invalid'], 'encoding': []},
                        {**checkpoint((14, 9)), 'encoding': {'state': 14, 'action': []}}):
            self.assertFalse(PythonServer._checkpoint_metadata('bad', invalid)['encodingCompatible'])
        conflict = checkpoint((14, 9)); conflict['model']['encodingVersion'] = 15
        self.assertFalse(PythonServer._checkpoint_metadata('bad', conflict)['encodingCompatible'])

    def test_legacy_training_widths_and_parameter_counts(self):
        torch.set_num_threads(1)
        for pair, contract in ENCODING_CONTRACTS.items():
            model = EntityTransformerNet('fast', encoding_version=pair[0])
            self.assertEqual(sum(p.numel() for p in model.parameters()), _entity_parameter_count('fast', pair[0]))
            row = {'state': np.zeros(contract['stateSize'], np.float32),
                   'actions': np.zeros((1, contract['actionSize']), np.float32),
                   'pi': np.ones(1, np.float32), 'reward': np.zeros(8), 'valueMask': np.ones(8)}
            batch = _training_data(torch, [row], contract)
            self.assertEqual(batch['action_width'], contract['actionSize'])
            self.assertEqual(batch['states'].shape[1], contract['stateSize'])

    def test_server_rejects_downgrade_before_starting_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            name = 'checkpoint-new.json.gz'
            (Path(folder) / name).write_bytes(gzip.compress(json.dumps(checkpoint((15, 11))).encode()))
            manager = TrainingManager(folder)
            with self.assertRaisesRegex(ValueError, '降级'):
                manager.start({'resumeCheckpoint': name, 'profile': 'fast', 'stateEncodingVersion': 14,
                               'actionEncodingVersion': 10})
            self.assertFalse(manager.status()['running'])
            self.assertIsNone(manager._thread)


if __name__ == '__main__':
    unittest.main()
