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
    pi_targets = []
    has_pi = False
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
        if "pi" in row and row["pi"]:
            row_pi = list(row["pi"]) + [0.0] * (maximum - len(row["pi"]))
            pi_targets.append(row_pi)
            has_pi = True
        else:
            pi_targets.append([0.0] * maximum)
    result = {
        "states": torch.tensor(states, dtype=torch.float32),
        "actions": torch.tensor(actions, dtype=torch.float32),
        "masks": torch.tensor(masks, dtype=torch.bool),
        "chosen": torch.tensor(chosen, dtype=torch.long),
        "old_probs": torch.tensor(old_probs, dtype=torch.float32),
        "old_values": torch.tensor(old_values, dtype=torch.float32),
        "rewards": torch.tensor(rewards, dtype=torch.float32),
        "temperatures": torch.tensor(temperatures, dtype=torch.float32),
    }
    if has_pi:
        # 混合批次中若个别动作没有 MCTS 访问分布，用实际选择动作的一热分布补齐，
        # 避免 auto 模式把该样本误当成全零目标而产生无效梯度。
        for index, target in enumerate(pi_targets):
            if sum(target) <= 0 and 0 <= chosen[index] < len(target):
                target[chosen[index]] = 1.0
        result["pi"] = torch.tensor(pi_targets, dtype=torch.float32)
    return result


def train_ppo(model, optimizer, device, data, epochs, batch_size=256, policy_loss_mode="auto"):
    total = {"policy": 0.0, "value": 0.0, "entropy": 0.0, "clip": 0.0,
             "kl": 0.0, "gradient": 0.0, "samples": 0}
    has_pi = "pi" in data
    use_mcts_ce = policy_loss_mode == "mcts_ce" or (policy_loss_mode == "auto" and has_pi)
    size = len(data["rewards"])
    advantages = data["rewards"] - data["old_values"]
    advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)
    for _ in range(epochs):
        for indices in torch.randperm(size).split(batch_size):
            batch = {key: value[indices].to(device, non_blocking=True) for key, value in data.items()}
            adv = advantages[indices].to(device, non_blocking=True)
            logits, values = model(batch["states"], batch["actions"], batch["masks"], batch["temperatures"])
            probs = torch.softmax(logits, dim=-1)
            if use_mcts_ce:
                # AlphaZero 风格：用 MCTS 访问分布 π 当策略目标，纯交叉熵
                if "pi" in batch:
                    pi = batch["pi"]
                else:
                    pi = torch.zeros_like(probs)
                    pi.scatter_(1, batch["chosen"].unsqueeze(1), 1.0)
                pi = pi.masked_fill(~batch["masks"], 0.0)
                pi = pi / pi.sum(dim=-1, keepdim=True).clamp_min(1e-12)
                # 取最低有效动作位置的截断，避免 mask=False 的零位被梯度拉低（已 mask 后在 -1e9）
                masked_probs = probs.masked_fill(~batch["masks"], 1e-12)
                norm_probs = masked_probs / masked_probs.sum(dim=-1, keepdim=True).clamp_min(1e-12)
                policy_loss = -(pi * (norm_probs.clamp_min(1e-12)).log()).sum(dim=-1).mean()
                # 用当前策略在所选动作上的概率反推 KL 估计（旧/新在同一分布上比较即可，意义近似）
                selected = norm_probs.gather(1, batch["chosen"].unsqueeze(1)).squeeze(1).clamp_min(1e-12)
                pi_selected = pi.gather(1, batch["chosen"].unsqueeze(1)).squeeze(1).clamp_min(1e-12)
                approx_kl = (pi.clamp_min(1e-12) * (pi.clamp_min(1e-12).log() - norm_probs.clamp_min(1e-12).log())).sum(dim=-1).mean()
                clip_frac = torch.zeros((), device=device)
            else:
                selected = probs.gather(1, batch["chosen"].unsqueeze(1)).squeeze(1).clamp_min(1e-8)
                old = batch["old_probs"].clamp_min(1e-8)
                ratio = selected / old
                clipped = ratio.clamp(0.8, 1.2)
                policy_loss = -torch.minimum(ratio * adv, clipped * adv).mean()
                approx_kl = (old.log() - selected.log()).mean()
                clip_frac = ((ratio - 1.0).abs() > 0.2).float().mean()
            value_loss = torch.nn.functional.mse_loss(values, batch["rewards"])
            masked_probs = probs.masked_fill(~batch["masks"], 1e-12)
            entropy = -(masked_probs * masked_probs.log()).sum(dim=-1).mean()
            loss = policy_loss + 0.5 * value_loss - 0.01 * entropy
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            gradient = torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            count = len(indices)
            total["policy"] += policy_loss.item() * count
            total["value"] += value_loss.item() * count
            total["entropy"] += entropy.item() * count
            total["clip"] += clip_frac.item() * count
            total["kl"] += approx_kl.item() * count
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
            elif command["cmd"] == "reload":
                if model is None:
                    raise RuntimeError("GPU 训练器尚未 init")
                model.load_flat(command["modelPath"])
                model.to(device)
                reply({"ok": True})
            elif command["cmd"] == "train":
                data = load_rollout(command["rolloutPath"])
                metrics = train_ppo(model, optimizer, device, data, command["epochs"], command.get("miniBatch", 256),
                                    command.get("policyLossMode", "auto"))
                model.save_flat(command["modelPath"])
                if device.type == "cuda":
                    metrics["gpuMemoryMB"] = torch.cuda.max_memory_allocated() / 1048576
                    torch.cuda.reset_peak_memory_stats()
                reply({"ok": True, "metrics": metrics})
            elif command["cmd"] == "batch_eval":
                # MCTS 批量前向：一次性跑若干 (state, [actions]) 对，返回 probsList 与 values。
                # 与 load_rollout 同款 padding 逻辑：动作列数对齐到 batch 内最大值，mask 屏蔽 padding。
                state_vectors = command.get("stateVectors", [])
                action_groups = command.get("actionVectorsList", [])
                if not state_vectors:
                    raise ValueError("batch_eval 缺少 stateVectors")
                if len(state_vectors) != len(action_groups):
                    raise ValueError("batch_eval 中 stateVectors 与 actionVectorsList 数量不一致")
                maximum = max(1, max((len(group) for group in action_groups), default=1))
                padded_actions = []
                masks = []
                for group in action_groups:
                    padded = list(group) + [[0.0] * 64 for _ in range(maximum - len(group))]
                    padded_actions.append(padded)
                    masks.append([True] * len(group) + [False] * (maximum - len(group)))
                states = torch.tensor(state_vectors, dtype=torch.float32, device=device)
                actions = torch.tensor(padded_actions, dtype=torch.float32, device=device)
                mask = torch.tensor(masks, dtype=torch.bool, device=device)
                temperatures = torch.ones(len(states), dtype=torch.float32, device=device)
                with torch.no_grad():
                    logits, values = model(states, actions, mask, temperatures)
                    probs = torch.softmax(logits, dim=-1)
                probs_cpu = probs.cpu().tolist()
                values_cpu = values.cpu().tolist()
                # 截断到每个样本真实动作数（PyTorch 输出是 padding 后的固定宽度）
                trimmed = [probs_cpu[i][:len(action_groups[i])] for i in range(len(probs_cpu))]
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                reply({"ok": True, "probsList": trimmed, "values": values_cpu})
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
