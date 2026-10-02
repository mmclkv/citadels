"""MCTS distillation uses untempered logits, independent of self-play sampling temperature."""

import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from training.gpu_trainer import train_mcts_distillation


class CaptureModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.scale = torch.nn.Parameter(torch.tensor(0.1))
        self.temperatures = []

    def forward(self, states, actions, mask, temperatures):
        self.temperatures.append(temperatures.detach().tolist())
        logits = actions[..., 0] * self.scale / temperatures.unsqueeze(-1)
        values = self.scale.expand(states.shape[0], 8)
        return logits.masked_fill(~mask, -1e9), values


def main():
    actions = np.zeros((4, 256), dtype=np.float32)
    actions[0, 0] = 1
    actions[3, 0] = 1
    data = {
        "states": torch.zeros(2, 838),
        "rewards": torch.ones(2, 8) * 0.2,
        "value_masks": torch.ones(2, 8),
        "actions_flat": actions,
        "lengths": np.array([2, 2]),
        "offsets": np.array([0, 2, 4]),
        "action_width": 256,
        "pi_flat": np.array([0.8, 0.2, 0.2, 0.8], dtype=np.float32),
        "pi_offsets": np.array([0, 2, 4]),
        "pi_lengths": np.array([2, 2]),
    }
    model = CaptureModel()
    optimizer = torch.optim.SGD(model.parameters(), lr=0.01)
    train_mcts_distillation(model, optimizer, torch.device("cpu"), data, 1, batch_size=2)
    assert model.temperatures[0] == [1.0, 1.0]
    print(json.dumps({"mctsDistillationTemperatures": model.temperatures[0]}))


if __name__ == "__main__":
    main()
