import unittest
import numpy as np
import torch
from python_backend.training_runtime import _training_data
from training.gpu_trainer import train_mcts_distillation


class Probe(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.policy_weight = torch.nn.Parameter(torch.tensor(.3))
        self.value_weight = torch.nn.Parameter(torch.tensor(.5))

    def forward(self, states, actions, mask, temperatures):
        logits = (actions[..., 0] * self.policy_weight).masked_fill(~mask, -1e9)
        return logits, self.value_weight.expand(len(states), 8)


def row(count, reward=0):
    actions = np.zeros((count, 448), np.float32)
    if count:
        actions[:, 0] = np.arange(count)
    pi = np.zeros(count, np.float32)
    if count:
        pi[0] = 1
    return {"state": np.zeros(2054, np.float32), "actions": actions, "pi": pi,
            "reward": np.full(8, reward, np.float32), "valueMask": np.ones(8, np.float32)}


class PolicyDecisionMaskTests(unittest.TestCase):
    def run_rows(self, rows):
        model = Probe()
        metrics = train_mcts_distillation(model, torch.optim.SGD(model.parameters(), lr=0),
                                          torch.device("cpu"), _training_data(torch, rows), 1, 32)
        return model, metrics

    def test_forced_moves_do_not_dilute_policy_gradient(self):
        base, base_metrics = self.run_rows([row(2)])
        mixed, mixed_metrics = self.run_rows([row(2), row(1, .5), row(0, .5)])
        torch.testing.assert_close(base.policy_weight.grad, mixed.policy_weight.grad)
        for key in ("policyLoss", "entropy", "targetEntropy", "approxKl"):
            self.assertAlmostEqual(base_metrics[key], mixed_metrics[key], places=6)
        self.assertEqual(mixed_metrics["policySamples"], 1)
        self.assertEqual(mixed_metrics["forcedActionSamples"], 1)
        self.assertAlmostEqual(mixed_metrics["valueLoss"], base_metrics["valueLoss"] / 3)

    def test_only_forced_and_value_rows_have_finite_value_training(self):
        model, metrics = self.run_rows([row(1), row(0)])
        self.assertEqual(metrics["policySamples"], 0)
        self.assertEqual(metrics["policyLoss"], 0)
        self.assertEqual(metrics["entropy"], 0)
        self.assertEqual(metrics["approxKl"], 0)
        self.assertGreater(metrics["valueLoss"], 0)
        self.assertTrue(torch.isfinite(model.value_weight.grad))
        self.assertNotEqual(model.value_weight.grad.item(), 0)
        self.assertEqual(model.policy_weight.grad.item(), 0)

    def test_gradient_fits_teacher_without_extra_entropy_reward(self):
        sample = row(3)
        sample['pi'] = np.asarray([.1, .3, .6], np.float32)
        model, metrics = self.run_rows([sample])
        features = torch.arange(3, dtype=torch.float32)
        expected = ((torch.softmax(features * .3, dim=0) - torch.from_numpy(sample['pi'])) * features).sum()
        torch.testing.assert_close(model.policy_weight.grad, expected)
        self.assertAlmostEqual(metrics['policyLoss'], metrics['targetEntropy'] + metrics['approxKl'], places=6)
        self.assertAlmostEqual(metrics['totalLoss'], metrics['policyLoss'] + .5 * metrics['valueLoss'], places=6)


if __name__ == "__main__":
    unittest.main()
