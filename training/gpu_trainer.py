"""Persistent PyTorch PPO trainer used by the Node.js self-play coordinator."""
import array
import gc
import gzip
import json
import os
import struct
import sys
import time

import numpy as np
import torch
from torch import nn


PROFILES = {
    "fast": (256, 128, 128, 64, 64),
    "balanced": (384, 256, 256, 128, 128),
    "large": (512, 384, 384, 192, 192),
}
VALUE_SLOTS = 8
STATE_SIZE = 672
ACTION_SIZE = 256

BINARY_MAGIC = 0x31425443  # "CTB1" little-endian.
BINARY_BATCH_EVAL = 1
BINARY_BATCH_RESULT = 2
BINARY_RELOAD = 3
BINARY_CLOSE = 4
BINARY_ACK = 5
BINARY_ERROR = 0xFFFFFFFF


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("binary GPU stream closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_binary_frame(stream):
    header = read_exact(stream, 8)
    magic, size = struct.unpack("<II", header)
    if magic != BINARY_MAGIC or size > (1 << 28):
        raise ValueError("binary GPU frame header invalid")
    return read_exact(stream, size)


def write_binary_frame(stream, payload):
    stream.write(struct.pack("<II", BINARY_MAGIC, len(payload)))
    stream.write(payload)
    stream.flush()


def binary_error(message):
    encoded = str(message).encode("utf-8", errors="replace")
    return struct.pack("<II", BINARY_ERROR, len(encoded)) + encoded


def binary_batch_eval(payload, model, device):
    # Use a writable backing buffer so torch.frombuffer does not emit a warning
    # on stderr; the native binary client expects stdout to contain frames only.
    payload = bytearray(payload)
    offset = 0

    def take_u32():
        nonlocal offset
        if offset + 4 > len(payload):
            raise ValueError("binary batch_eval payload truncated")
        value = struct.unpack_from("<I", payload, offset)[0]
        offset += 4
        return value

    command = take_u32()
    if command != BINARY_BATCH_EVAL:
        raise ValueError("binary GPU command is not batch_eval")
    count = take_u32()
    state_size = take_u32()
    action_size = take_u32()
    action_counts = [take_u32() for _ in range(count)]
    if not count or not state_size or not action_size:
        raise ValueError("binary batch_eval dimensions invalid")
    state_bytes = count * state_size * 4
    if offset + state_bytes > len(payload):
        raise ValueError("binary batch_eval states truncated")
    state_buffer = memoryview(payload)[offset:offset + state_bytes]
    offset += state_bytes
    states_cpu = torch.frombuffer(state_buffer, dtype=torch.float32).reshape(count, state_size).clone()

    maximum = max(1, max(action_counts, default=1))
    actions_cpu = torch.zeros((count, maximum, action_size), dtype=torch.float32)
    for row, action_count in enumerate(action_counts):
        byte_count = action_count * action_size * 4
        if offset + byte_count > len(payload):
            raise ValueError("binary batch_eval actions truncated")
        if action_count:
            source = memoryview(payload)[offset:offset + byte_count]
            values = torch.frombuffer(source, dtype=torch.float32).reshape(action_count, action_size)
            actions_cpu[row, :action_count].copy_(values)
        offset += byte_count
    if offset != len(payload):
        raise ValueError("binary batch_eval payload has trailing bytes")

    mask_cpu = torch.zeros((count, maximum), dtype=torch.bool)
    for row, action_count in enumerate(action_counts):
        mask_cpu[row, :action_count] = True
    states = states_cpu.to(device)
    actions = actions_cpu.to(device)
    mask = mask_cpu.to(device)
    temperatures = torch.ones(count, dtype=torch.float32, device=device)
    with torch.inference_mode():
        logits, values = model(states, actions, mask, temperatures)
        probs = torch.softmax(logits, dim=-1).cpu().contiguous()
        values = values.cpu().contiguous()

    output = bytearray()
    output.extend(struct.pack("<II", BINARY_BATCH_RESULT, count))
    for row, action_count in enumerate(action_counts):
        output.extend(struct.pack("<I", action_count))
        if action_count:
            output.extend(probs[row, :action_count].numpy().astype("<f4", copy=False).tobytes())
        output.extend(values[row].numpy().astype("<f4", copy=False).tobytes())
    return bytes(output)


def run_binary_protocol(model, device):
    stream = sys.stdin.buffer
    output = sys.stdout.buffer
    while True:
        payload = read_binary_frame(stream)
        try:
            if len(payload) < 4:
                raise ValueError("binary GPU command truncated")
            command = struct.unpack_from("<I", payload, 0)[0]
            if command == BINARY_BATCH_EVAL:
                response = binary_batch_eval(payload, model, device)
            elif command == BINARY_RELOAD:
                if len(payload) < 8:
                    raise ValueError("binary reload payload truncated")
                length = struct.unpack_from("<I", payload, 4)[0]
                if 8 + length != len(payload):
                    raise ValueError("binary reload path length invalid")
                model.load_flat(payload[8:8 + length].decode("utf-8"))
                model.to(device)
                response = struct.pack("<II", BINARY_ACK, BINARY_RELOAD)
            elif command == BINARY_CLOSE:
                response = struct.pack("<II", BINARY_ACK, BINARY_CLOSE)
                write_binary_frame(output, response)
                return
            else:
                raise ValueError("unknown binary GPU command")
        except Exception as error:
            response = binary_error(error)
        write_binary_frame(output, response)


class PolicyValueNet(nn.Module):
    def __init__(self, profile, state_size=672, action_size=256):
        super().__init__()
        sh, latent, ph, pm, vh = PROFILES[profile]
        self.state1 = nn.Linear(state_size, sh)
        self.state2 = nn.Linear(sh, latent)
        self.policy1 = nn.Linear(latent + action_size, ph)
        self.policy2 = nn.Linear(ph, pm)
        self.policy_out = nn.Linear(pm, 1)
        self.value1 = nn.Linear(latent, vh)
        self.value_out = nn.Linear(vh, VALUE_SLOTS)
        self.ordered = [self.state1, self.state2, self.policy1, self.policy2,
                        self.policy_out, self.value1, self.value_out]

    def forward(self, states, actions, mask, temperatures):
        latent = torch.nn.functional.elu(self.state1(states))
        latent = torch.nn.functional.elu(self.state2(latent))
        value = self.value_out(torch.nn.functional.elu(self.value1(latent)))
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
        legacy_value_head_size = self.value_out.in_features * (VALUE_SLOTS - 1) + (VALUE_SLOTS - 1)
        legacy = len(values) == sum(layer.weight.numel() + layer.bias.numel() for layer in self.ordered) - legacy_value_head_size
        if not legacy and len(values) != sum(layer.weight.numel() + layer.bias.numel() for layer in self.ordered):
            raise ValueError("模型二进制参数数量不匹配")
        cursor = 0
        with torch.no_grad():
            for layer in self.ordered:
                count = layer.weight.numel()
                if legacy and layer is self.value_out:
                    layer.weight.zero_(); layer.bias.zero_()
                    old_weight_count = layer.in_features
                    layer.weight[0].copy_(torch.tensor(values[cursor:cursor + old_weight_count]))
                    cursor += old_weight_count
                    layer.bias[0] = values[cursor]
                    cursor += 1
                else:
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
        # The shared inference daemon may briefly have the old model open while
        # polling for a weight update. Windows refuses replacing an open file,
        # so retry the atomic swap across that short read window.
        last_error = None
        for attempt in range(20):
            try:
                os.replace(temporary, filename)
                break
            except PermissionError as error:
                last_error = error
                if attempt == 19:
                    raise
                time.sleep(0.025 * (attempt + 1))


def load_rollout(filename):
    """加载 rollout 并转为紧凑的 numpy 缓冲。

    内存说明：旧实现 json.load 一次性把整批样本物化为 Python 对象（每个
    浮点 ~32 字节），再按批内全局最大动作数 pad 出 (N, max, width) 的巨型
    嵌套列表，模型更新瞬间峰值可达数 GB，且整批 data 在训练结束后仍被
    主循环变量持有到下一批。现在改为流式逐行解析直接填 float32 numpy
    缓冲，动作/π 不做全局 padding，由 build_minibatch 按 mini-batch 内
    最大动作数现场 pad——数学语义与超参数完全不变，峰值内存降一个量级。
    """
    with gzip.open(filename, "rt", encoding="utf-8") as handle:
        text = handle.read()
    decoder = json.JSONDecoder()
    position = 0
    size = len(text)

    def skip_blanks():
        nonlocal position
        while position < size and text[position] in " \t\r\n":
            position += 1

    skip_blanks()
    if position >= size or text[position] != "[":
        raise ValueError("rollout 文件不是 JSON 数组")
    position += 1

    states_rows, actions_rows, pi_rows = [], [], []
    chosen, old_probs, temperatures = [], [], []
    old_values, rewards, value_masks = [], [], []
    while True:
        skip_blanks()
        if position < size and text[position] == ",":
            position += 1
            skip_blanks()
        if position < size and text[position] == "]":
            break
        if position >= size:
            raise ValueError("rollout JSON 数组未闭合")
        row, position = decoder.raw_decode(text, position)
        count = len(row["actions"])
        states_rows.append(np.asarray(row["state"], dtype=np.float32))
        if count:
            actions_rows.append(np.asarray(row["actions"], dtype=np.float32).reshape(count, -1))
        else:
            actions_rows.append(None)
        pi = row.get("pi")
        if pi:
            pi_arr = np.zeros(count, dtype=np.float32)
            usable = min(count, len(pi))
            pi_arr[:usable] = np.asarray(pi[:usable], dtype=np.float32)
            pi_rows.append(pi_arr)
        else:
            pi_rows.append(None)
        chosen.append(int(row["chosen"]))
        old_probs.append(float(row["oldProb"]))
        temperatures.append(float(row.get("temperature", 1.0)))
        old_values.append(np.asarray(
            (list(row.get("oldValueVector", [row.get("oldValue", 0.0)])) + [0.0] * VALUE_SLOTS)[:VALUE_SLOTS],
            dtype=np.float32))
        rewards.append(np.asarray(
            (list(row.get("rewardVector", [row.get("reward", 0.0)])) + [0.0] * VALUE_SLOTS)[:VALUE_SLOTS],
            dtype=np.float32))
        value_masks.append(np.asarray(
            (list(row.get("valueMask", [1.0])) + [0.0] * VALUE_SLOTS)[:VALUE_SLOTS],
            dtype=np.float32))
    del text, decoder
    gc.collect()

    n = len(states_rows)
    if n == 0:
        raise ValueError("rollout 为空")
    action_width = next((a.shape[1] for a in actions_rows if a is not None), ACTION_SIZE)
    actions_rows = [a if a is not None else np.zeros((0, action_width), np.float32) for a in actions_rows]
    counts = np.asarray([a.shape[0] for a in actions_rows], dtype=np.int64)
    offsets = np.zeros(n + 1, dtype=np.int64)
    np.cumsum(counts, out=offsets[1:])
    actions_flat = np.concatenate(actions_rows) if actions_rows else np.zeros((0, action_width), np.float32)
    del actions_rows

    has_pi = any(p is not None for p in pi_rows)
    pi_flat, pi_offsets, pi_lengths = None, None, None
    if has_pi:
        pi_lengths = np.asarray([p.shape[0] if p is not None else 0 for p in pi_rows], dtype=np.int64)
        pi_offsets = np.zeros(n + 1, dtype=np.int64)
        np.cumsum(pi_lengths, out=pi_offsets[1:])
        present = [p for p in pi_rows if p is not None]
        pi_flat = np.concatenate(present) if present else np.zeros(0, np.float32)
        del present
    del pi_rows

    result = {
        "states": torch.from_numpy(np.stack(states_rows)),
        "chosen": torch.from_numpy(np.asarray(chosen, dtype=np.int64)),
        "old_probs": torch.from_numpy(np.asarray(old_probs, dtype=np.float32)),
        "old_values": torch.from_numpy(np.stack(old_values)),
        "rewards": torch.from_numpy(np.stack(rewards)),
        "value_masks": torch.from_numpy(np.stack(value_masks)),
        "temperatures": torch.from_numpy(np.asarray(temperatures, dtype=np.float32)),
        # 变宽字段：mini-batch 组装时才 pad
        "actions_flat": actions_flat,
        "lengths": counts,
        "offsets": offsets,
        "action_width": action_width,
        "pi_flat": pi_flat,
        "pi_offsets": pi_offsets,
        "pi_lengths": pi_lengths,
    }
    del states_rows, old_values, rewards, value_masks
    gc.collect()
    return result


def build_minibatch(data, indices, device):
    """按 mini-batch 组装训练批并搬上 device。

    动作/mask/π 的列数对齐到本 mini-batch 内的最大动作数（旧实现是对齐
    全批最大值）：mask 屏蔽 padding、π 在 padding 位为 0，与旧全局 padding
    在数学上等价，但省掉跨批驻留的大块 CPU 内存。
    """
    batch = {
        "states": data["states"][indices].to(device, non_blocking=True),
        "chosen": data["chosen"][indices].to(device, non_blocking=True),
        "old_probs": data["old_probs"][indices].to(device, non_blocking=True),
        "old_values": data["old_values"][indices].to(device, non_blocking=True),
        "rewards": data["rewards"][indices].to(device, non_blocking=True),
        "value_masks": data["value_masks"][indices].to(device, non_blocking=True),
        "temperatures": data["temperatures"][indices].to(device, non_blocking=True),
    }
    lengths = data["lengths"][indices]
    m = len(indices)
    max_len = max(1, int(lengths.max()))
    actions = np.zeros((m, max_len, data["action_width"]), np.float32)
    flat, offsets = data["actions_flat"], data["offsets"]
    for j, i in enumerate(indices):
        ln = int(lengths[j])
        if ln:
            actions[j, :ln] = flat[offsets[i]:offsets[i] + ln]
    batch["actions"] = torch.from_numpy(actions).to(device, non_blocking=True)
    mask = np.arange(max_len, dtype=np.int64)[None, :] < lengths[:, None]
    batch["masks"] = torch.from_numpy(mask).to(device, non_blocking=True)
    if data["pi_flat"] is not None:
        pi = np.zeros((m, max_len), np.float32)
        pi_flat, pi_offsets = data["pi_flat"], data["pi_offsets"]
        for j, i in enumerate(indices):
            pl = int(data["pi_lengths"][i])
            if pl:
                pi[j, :pl] = pi_flat[pi_offsets[i]:pi_offsets[i] + pl]
        # 混合批次中若个别动作没有 MCTS 访问分布，用实际选择动作的一热分布补齐，
        # 避免 auto 模式把该样本误当成全零目标而产生无效梯度。
        for j, i in enumerate(indices):
            if pi[j].sum() <= 0:
                c = int(data["chosen"][i])
                if 0 <= c < max_len:
                    pi[j, c] = 1.0
        batch["pi"] = torch.from_numpy(pi).to(device, non_blocking=True)
    return batch


def train_ppo(model, optimizer, device, data, epochs, batch_size=256, policy_loss_mode="auto"):
    total = {"policy": 0.0, "value": 0.0, "entropy": 0.0, "clip": 0.0,
             "kl": 0.0, "gradient": 0.0, "samples": 0}
    has_pi = data["pi_flat"] is not None
    use_mcts_ce = policy_loss_mode == "mcts_ce" or (policy_loss_mode == "auto" and has_pi)
    size = len(data["rewards"])
    advantages = data["rewards"][:, 0] - data["old_values"][:, 0]
    advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-8)
    for _ in range(epochs):
        for indices in torch.randperm(size).split(batch_size):
            batch = build_minibatch(data, indices.numpy(), device)
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
            squared_value_error = (values - batch["rewards"]) ** 2
            value_mask = batch["value_masks"]
            value_loss = ((squared_value_error * value_mask).sum(dim=-1) /
                          value_mask.sum(dim=-1).clamp_min(1.0)).mean()
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
    for raw_line in sys.stdin.buffer:
        try:
            line = raw_line.decode("utf-8")
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
                model.eval()
                optimizer = torch.optim.Adam(model.parameters(), lr=command["learningRate"])
                optimizer_path = command.get("optimizerPath")
                if optimizer_path and os.path.exists(optimizer_path):
                    optimizer.load_state_dict(torch.load(optimizer_path, map_location=device, weights_only=True))
                reply({"ok": True, "device": str(device), "torch": torch.__version__,
                       "cuda": torch.version.cuda, "gpu": torch.cuda.get_device_name(0) if use_cuda else ""})
                if command.get("protocol") == "binary":
                    run_binary_protocol(model, device)
                    return
            elif command["cmd"] == "reload":
                if model is None:
                    raise RuntimeError("GPU 训练器尚未 init")
                model.load_flat(command["modelPath"])
                model.to(device)
                model.eval()
                reply({"ok": True})
            elif command["cmd"] == "train":
                data = load_rollout(command["rolloutPath"])
                metrics = train_ppo(model, optimizer, device, data, command["epochs"], command.get("miniBatch", 256),
                                    command.get("policyLossMode", "auto"))
                if device.type == "cuda":
                    metrics["gpuMemoryMB"] = torch.cuda.max_memory_allocated() / 1048576
                # 立刻释放整批样本：旧实现把它一直持有到下一批 train，
                # 自对弈阶段平白多驻留一整批 rollout（数百 MB 级）。
                del data
                gc.collect()
                if device.type == "cuda":
                    torch.cuda.empty_cache()
                    torch.cuda.reset_peak_memory_stats()
                model.save_flat(command["modelPath"])
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
                    padded = list(group) + [[0.0] * ACTION_SIZE for _ in range(maximum - len(group))]
                    padded_actions.append(padded)
                    masks.append([True] * len(group) + [False] * (maximum - len(group)))
                states = torch.tensor(state_vectors, dtype=torch.float32, device=device)
                actions = torch.tensor(padded_actions, dtype=torch.float32, device=device)
                mask = torch.tensor(masks, dtype=torch.bool, device=device)
                temperatures = torch.ones(len(states), dtype=torch.float32, device=device)
                with torch.inference_mode():
                    logits, values = model(states, actions, mask, temperatures)
                    probs = torch.softmax(logits, dim=-1)
                probs_cpu = probs.cpu().tolist()
                value_vectors_cpu = values.cpu().tolist()
                values_cpu = [row[0] for row in value_vectors_cpu]
                # 截断到每个样本真实动作数（PyTorch 输出是 padding 后的固定宽度）
                trimmed = [probs_cpu[i][:len(action_groups[i])] for i in range(len(probs_cpu))]
                if device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                reply({"ok": True, "probsList": trimmed, "valueVectors": value_vectors_cpu, "values": values_cpu})
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
