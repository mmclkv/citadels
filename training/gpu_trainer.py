"""Persistent PyTorch PPO trainer used by the Node.js self-play coordinator."""
import array
import gzip
import json
import os
import sys

import torch
from torch import nn


PROFILES = {
    "fast": (256, 128, 128, 64, 64),
    "balanced": (384, 256, 256, 128, 128),
    "large": (512, 384, 384, 192, 192),
}


class PolicyValueNet(nn.Module):
    def __init__(self, profile, state_size=192, action_size=64):
        super().__init__()
        sh, latent, ph, pm, vh = PROFILES[profile]
        self.state1 = nn.Linear(state_size, sh)
        self.state2 = nn.Linear(sh, latent)
        self.policy1 = nn.Linear(latent + action_size, ph)
        self.policy2 = nn.Linear(ph, pm)
        self.policy_out = nn.Linear(pm, 1)
        self.value1 = nn.Linear(latent, vh)
        self.value_out = nn.Linear(vh, 1)
        self.ordered = [self.state1, self.state2, self.policy1, self.policy2,
                        self.policy_out, self.value1, self.value_out]

    def forward(self, states, actions, mask, temperatures):
        latent = torch.nn.functional.elu(self.state1(states))
        latent = torch.nn.functional.elu(self.state2(latent))
        value = self.value_out(torch.nn.functional.elu(self.value1(latent))).squeeze(-1)
        expanded = latent.unsqueeze(1).expand(-1, actions.shape[1], -1)
        policy = torch.cat((expanded, actions), dim=-1)
        policy = torch.nn.functional.elu(self.policy1(policy))
        policy = torch.nn.functional.elu(self.policy2(policy))
        logits = self.policy_out(policy).squeeze(-1) / temperatures.unsqueeze(-1)
        logits = logits.masked_fill(~mask, -1e9)
        return logits, value

    def load_flat(self, filename):
        values = array.array("f")
        with open(filename, "rb") as handle:
            values.fromfile(handle, os.path.getsize(filename) // values.itemsize)
        cursor = 0
        with torch.no_grad():
            for layer in self.ordered:
                count = layer.weight.numel()
                layer.weight.copy_(torch.tensor(values[cursor:cursor + count]).reshape_as(layer.weight))
                cursor += count
                count = layer.bias.numel()
                layer.bias.copy_(torch.tensor(values[cursor:cursor + count]).reshape_as(layer.bias))
                cursor += count
        if cursor != len(values):
            raise ValueError("模型二进制参数数量不匹配")

    def save_flat(self, filename):
        values = array.array("f")
        for layer in self.ordered:
            values.extend(layer.weight.detach().cpu().reshape(-1).tolist())
            values.extend(layer.bias.detach().cpu().reshape(-1).tolist())
        temporary = filename + ".tmp"
        with open(temporary, "wb") as handle:
            values.tofile(handle)
        os.replace(temporary, filename)


def load_rollout(filename):
    with gzip.open(filename, "rt", encoding="utf-8") as handle:
        rows = json.load(handle)
    maximum = max(len(row["actions"]) for row in rows)
    states, actions, masks = [], [], []
    chosen, old_probs, old_values, rewards, temperatures = [], [], [], [], []
    for row in rows:
        count = len(row["actions"])
        states.append(row["state"])
        actions.append(row["actions"] + [[0.0] * 64 for _ in range(maximum - count)])
        masks.append([True] * count + [False] * (maximum - count))
        chosen.append(row["chosen"])
        old_probs.append(row["oldProb"])
        old_values.append(row["oldValue"])
        rewards.append(row["reward"])
        temperatures.append(row.get("temperature", 1.0))
    return {
        "states": torch.tensor(states, dtype=torch.float32),
        "actions": torch.tensor(actions, dtype=torch.float32),
        "masks": torch.tensor(masks, dtype=torch.bool),
        "chosen": torch.tensor(chosen, dtype=torch.long),
        "old_probs": torch.tensor(old_probs, dtype=torch.float32),
        "old_values": torch.tensor(old_values, dtype=torch.float32),
        "rewards": torch.tensor(rewards, dtype=torch.float32),
        "temperatures": torch.tensor(temperatures, dtype=torch.float32),
    }


def train_ppo(model, optimizer, device, data, epochs, batch_size=256):
    total = {"policy": 0.0, "value": 0.0, "entropy": 0.0, "clip": 0.0,
             "kl": 0.0, "gradient": 0.0, "samples": 0}
    advantages = data["rewards"] - data["old_values"]
    advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)
    size = len(advantages)
    for _ in range(epochs):
        for indices in torch.randperm(size).split(batch_size):
            batch = {key: value[indices].to(device, non_blocking=True) for key, value in data.items()}
            adv = advantages[indices].to(device, non_blocking=True)
            logits, values = model(batch["states"], batch["actions"], batch["masks"], batch["temperatures"])
            probs = torch.softmax(logits, dim=-1)
            selected = probs.gather(1, batch["chosen"].unsqueeze(1)).squeeze(1).clamp_min(1e-8)
            old = batch["old_probs"].clamp_min(1e-8)
            ratio = selected / old
            clipped = ratio.clamp(0.8, 1.2)
            policy_loss = -torch.minimum(ratio * adv, clipped * adv).mean()
            value_loss = torch.nn.functional.mse_loss(values, batch["rewards"])
            entropy = -(probs * probs.clamp_min(1e-8).log()).sum(dim=-1).mean()
            loss = policy_loss + 0.5 * value_loss - 0.01 * entropy
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            count = len(indices)
            total["policy"] += policy_loss.item() * count
            total["value"] += value_loss.item() * count
            total["entropy"] += entropy.item() * count
            total["clip"] += ((ratio - 1.0).abs() > 0.2).float().mean().item() * count
            total["kl"] += (old.log() - selected.log()).mean().item() * count
            total["gradient"] += float(gradient) * count
            total["samples"] += count
    denominator = max(1, total["samples"])
    policy = total["policy"] / denominator
    value = total["value"] / denominator
    entropy = total["entropy"] / denominator
    return {
        "policyLoss": policy,
        "valueLoss": value,
        "totalLoss": policy + 0.5 * value - 0.01 * entropy,
        "entropy": entropy,
        "clipFraction": total["clip"] / denominator,
        "approxKl": total["kl"] / denominator,
        "gradientNorm": total["gradient"] / denominator,
        "samples": size,
    }


def reply(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    model = optimizer = device = None
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if command["cmd"] == "init":
                requested = command.get("device", "auto")
                use_cuda = torch.cuda.is_available() and requested != "cpu"
                if requested == "cuda" and not use_cuda:
                    raise RuntimeError("已要求 CUDA，但 PyTorch 无法访问 CUDA")
                device = torch.device("cuda" if use_cuda else "cpu")
                model = PolicyValueNet(command["profile"])
                model.load_flat(command["modelPath"])
                model.to(device)
                optimizer = torch.optim.Adam(model.parameters(), lr=command["learningRate"])
                optimizer_path = command.get("optimizerPath")
                if optimizer_path and os.path.exists(optimizer_path):
                    optimizer.load_state_dict(torch.load(optimizer_path, map_location=device, weights_only=True))
                reply({"ok": True, "device": str(device), "torch": torch.__version__,
                       "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0) if use_cuda else ""})
            elif command["cmd"] == "train":
                data = load_rollout(command["rolloutPath"])
                metrics = train_ppo(model, optimizer, device, data, command["epochs"], command.get("miniBatch", 256))
                model.save_flat(command["modelPath"])
                if device.type == "cuda":
                    metrics["gpuMemoryMB"] = torch.cuda.max_memory_allocated() / 1048576
                    torch.cuda.reset_peak_memory_stats()
                reply({"ok": True, "metrics": metrics})
            elif command["cmd"] == "checkpoint":
                torch.save(optimizer.state_dict(), command["optimizerPath"])
                reply({"ok": True})
            elif command["cmd"] == "close":
                reply({"ok": True})
                return
        except Exception as error:
            reply({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
