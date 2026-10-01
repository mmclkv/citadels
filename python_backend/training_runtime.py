"""In-process Python self-play/PPO runtime and lifecycle manager."""

from __future__ import annotations

import array
import copy
import gzip
import json
import multiprocessing
import os
import platform
import random
import re
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .bot import decide as decide_npc
from .encoding import ACTION_SIZE, encode_action, encode_state
from .game import apply_action, create_game, get_available_actions, start_game
from .belief import belief_weights
from .determinize import determinize
from .mcts import InformationSetMCTS
from .neural import NeuralPolicy
from .scoring import compute_scores
from .training_config import sanitize_config
from .views import sanitize

ROOT = Path(__file__).resolve().parents[1]
TRAINING_DIR = ROOT / "training"
FLAT_PROFILES = {"fast": (256, 128, 128, 64, 64),
                 "balanced": (384, 256, 256, 128, 128),
                 "large": (512, 384, 384, 192, 192)}

_SAMPLER_MODEL = None
_SAMPLER_CONFIG = None
_SAMPLER_STOP = None


def _system_memory_gb() -> float | None:
    try:
        if os.name == "nt":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                            ("total_phys", ctypes.c_ulonglong), ("avail_phys", ctypes.c_ulonglong),
                            ("total_page", ctypes.c_ulonglong), ("avail_page", ctypes.c_ulonglong),
                            ("total_virtual", ctypes.c_ulonglong), ("avail_virtual", ctypes.c_ulonglong),
                            ("avail_extended", ctypes.c_ulonglong)]

            status = MemoryStatus()
            status.length = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return round(status.total_phys / (1024 ** 3), 1)
        else:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round(pages * page_size / (1024 ** 3), 1)
    except (AttributeError, OSError, ValueError):
        pass
    return None


def _flat_parameter_count(profile: str) -> int:
    state_hidden, latent, policy_hidden, policy_mid, value_hidden = FLAT_PROFILES[profile]
    dense = lambda inputs, outputs: inputs * outputs + outputs
    return (dense(672, state_hidden) + dense(state_hidden, latent) +
            dense(latent + ACTION_SIZE, policy_hidden) + dense(policy_hidden, policy_mid) +
            dense(policy_mid, 1) + dense(latent, value_hidden) + dense(value_hidden, 8))


def _load_trainer():
    import sys
    if str(TRAINING_DIR) not in sys.path:
        sys.path.insert(0, str(TRAINING_DIR))
    import torch
    import gpu_trainer
    return torch, gpu_trainer


def _current_actor(state: dict) -> dict | None:
    if state["phase"] == "draft" and state.get("draft"):
        draft = state["draft"]
        step = draft["steps"][draft["stepIdx"]] if draft["stepIdx"] < len(draft["steps"]) else None
        return state["players"][step["player"]] if step else None
    if state.get("reaction"):
        return state["players"][state["reaction"]["playerIdx"]]
    if state.get("roundConfirm"):
        idx = next((i for i, done in enumerate(state["roundConfirm"]["confirmed"]) if not done), -1)
        return state["players"][idx] if idx >= 0 else None
    turn = state.get("turn")
    return state["players"][turn["playerIdx"]] if turn else None


def _network_count(config: dict, game_number: int, player_count: int) -> int:
    mode = config["selfPlayMode"]
    if mode == "all-network":
        return player_count
    if mode == "network-vs-heuristic":
        return max(1, min(player_count, config["networkPlayerCount"] or 1))
    start = max(1, min(player_count, config["curriculumStartPlayers"] or 1))
    end = max(start, min(player_count, config["curriculumEndPlayers"] or player_count))
    increments = max(0, (game_number - 1) // config["curriculumStepGames"])
    return min(end, start + increments)


def _rank_rewards(state: dict) -> dict[str, float]:
    scores = state.get("scores") or compute_scores(state)
    player_count = len(scores)
    rewards = {}
    for row in scores:
        rank = sum(other["total"] > row["total"] for other in scores)
        rewards[state["players"][row["playerIdx"]]["id"]] = (
            1.0 if player_count == 1 else 1.0 - 2.0 * rank / (player_count - 1))
    return rewards


def _value_target(player_ids: list[str], player_id: str, rewards: dict[str, float]):
    start = player_ids.index(player_id)
    values = np.zeros(8, dtype=np.float32)
    mask = np.zeros(8, dtype=np.float32)
    for relative in range(min(8, len(player_ids))):
        values[relative] = rewards[player_ids[(start + relative) % len(player_ids)]]
        mask[relative] = 1
    return values, mask


def _training_search(state: dict, player_id: str, actions: list[dict], model, device,
                     config: dict, rng: random.Random):
    """Return an ISMCTS visit target, using only root determinizations observable to the actor."""
    import torch
    from .views import sanitize

    architecture = "entity-v1" if config["networkArchitecture"] == "flat" else "entity-v5"
    particles = []
    baseline = json.dumps(actions, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    for _ in range(int(config["mctsParticles"]) * 3):
        if len(particles) >= int(config["mctsParticles"]):
            break
        try:
            candidate = determinize(state, player_id, rng.random)
            legal = NeuralPolicy._expand(candidate, player_id,
                get_available_actions(candidate, player_id).get("actions") or [])
            signature = json.dumps(legal, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if signature == baseline:
                particles.append(candidate)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    if not particles:
        return None
    weights = (belief_weights(particles, player_id, 0.15)
               if config.get("mctsBelief", True) else None)

    inference_ms = 0.0

    def evaluate(search_state: dict, player_index: int, candidates: list[dict]):
        nonlocal inference_ms
        actor_id = search_state["players"][player_index]["id"]
        view = sanitize(search_state, actor_id)
        vector, context = encode_state(view, actor_id, architecture)
        action_vectors = np.stack([encode_action(action, context) for action in candidates])
        state_tensor = torch.from_numpy(vector.copy()).to(device).unsqueeze(0)
        action_tensor = torch.from_numpy(action_vectors.copy()).to(device).unsqueeze(0)
        mask = torch.ones((1, len(candidates)), dtype=torch.bool, device=device)
        temperature = torch.ones((1,), dtype=torch.float32, device=device)
        started = time.perf_counter()
        with torch.inference_mode():
            logits, values = model(state_tensor, action_tensor, mask, temperature)
            priors = torch.softmax(logits, dim=-1)[0].detach().cpu().numpy().astype(np.float32)
            value_vector = values[0].detach().cpu().numpy().astype(np.float32)
        inference_ms += (time.perf_counter() - started) * 1000
        return priors, value_vector

    search = InformationSetMCTS(evaluate, simulations=int(config["mctsSimulations"]),
        max_depth=int(config["mctsMaxDepth"]), c_puct=float(config["mctsC_puct"]),
        seed=rng.randrange(0, 2**32), dirichlet_alpha=float(config["mctsDirichletAlpha"]),
        dirichlet_epsilon=float(config["mctsDirichletEpsilon"]))
    result = search.search(particles, player_id, actions, weights)
    if len(result.policy) != len(actions) or not np.isfinite(result.policy).all() or float(result.policy.sum()) <= 0:
        return None
    policy = np.maximum(result.policy.astype(np.float64), 0)
    policy /= policy.sum()
    return {"policy": policy.astype(np.float32), "value": result.value_vector,
            "visits": result.visits, "particles": len(particles),
            "expansions": result.expansions, "inferenceMs": inference_ms}


def _sample_game(model, device, config: dict, game_number: int, stop_event: threading.Event):
    game_started = time.perf_counter()
    import torch
    rng = random.Random((int(config["seed"]) + game_number * 0x9E3779B1) & 0xFFFFFFFF)
    player_count = rng.randint(int(config["minPlayers"]), int(config["maxPlayers"]))
    network_count = _network_count(config, game_number, player_count)
    network_seats = set((game_number - 1 + offset) % player_count for offset in range(network_count))
    seats = [{"id": f"train-{game_number}-{i}", "name": f"玩家 {i + 1}", "isBot": True,
              "botType": "neural" if i in network_seats else "npc",
              "botLevel": config["heuristicDifficulty"]} for i in range(player_count)]
    state = create_game({"roomId": f"training-{game_number}", "seed": rng.randrange(1, 2**32),
                         "endDistricts": config["endDistricts"], "charSetMode": config["charSet"],
                         "seats": seats})
    if not start_game(state)["ok"]:
        raise RuntimeError("Python 游戏引擎无法启动自对弈局")
    architecture = config["networkArchitecture"]
    encode_arch = "entity-v1" if architecture == "flat" else "entity-v5"
    rows = []
    steps = 0
    inference_ms = 0.0
    fallback_count = 0
    while state["phase"] != "gameover" and state["round"] <= config["maxRounds"] and steps < config["maxSteps"]:
        if stop_event.is_set():
            return None
        actor = _current_actor(state)
        if actor is None:
            raise RuntimeError(f"局 {game_number} 无当前行动者（phase={state['phase']}）")
        player_id = actor["id"]
        available = get_available_actions(state, player_id)
        options = NeuralPolicy._expand(state, player_id, available.get("actions") or [])
        if not options:
            raise RuntimeError(f"局 {game_number} {player_id} 没有合法候选行动")
        view = sanitize(state, player_id)
        encoded_state, context = encode_state(view, player_id, encode_arch)
        action_vectors = np.stack([encode_action(action, context) for action in options])
        is_network = actor.get("botType") == "neural"
        chosen = 0
        old_probability = 1.0 / len(options)
        value_vector = np.zeros(8, dtype=np.float32)
        temperature_progress = min(1.0, game_number / max(1, config["targetGames"] * 0.7))
        temperature = config["temperatureStart"] + (config["temperatureEnd"] - config["temperatureStart"]) * temperature_progress
        if is_network:
            states_t = torch.from_numpy(encoded_state.copy()).to(device).unsqueeze(0)
            actions_t = torch.from_numpy(action_vectors.copy()).to(device).unsqueeze(0)
            mask_t = torch.ones((1, len(options)), dtype=torch.bool, device=device)
            temp_t = torch.tensor([temperature], dtype=torch.float32, device=device)
            inference_started = time.perf_counter()
            with torch.inference_mode():
                logits, values = model(states_t, actions_t, mask_t, temp_t)
                probs = torch.softmax(logits, dim=-1)[0]
                value_vector = values[0].detach().cpu().numpy().astype(np.float32, copy=True)
                chosen = int(torch.multinomial(probs, 1).item())
                old_probability = float(probs[chosen].item())
            inference_ms += (time.perf_counter() - inference_started) * 1000
            search_result = None
            if config["mctsSimulations"] > 0 and len(options) > 1:
                search_result = _training_search(state, player_id, options, model, device, config, rng)
            if search_result:
                inference_ms += search_result["inferenceMs"]
                policy = torch.as_tensor(search_result["policy"], dtype=torch.float32, device=device)
                chosen = int(torch.multinomial(policy, 1).item())
                old_probability = float(policy[chosen].item())
                value_vector = np.asarray(search_result["value"], dtype=np.float32).copy()
            if len(options) > 1:
                row = {"playerId": player_id, "state": encoded_state.copy(),
                             "actions": action_vectors.copy(), "chosen": chosen,
                             "oldProb": old_probability, "oldValue": value_vector,
                             "temperature": float(temperature)}
                if search_result:
                    row["pi"] = search_result["policy"].copy()
                    row["mctsVisits"] = search_result["visits"]
                    row["mctsParticles"] = search_result["particles"]
                rows.append(row)
        else:
            action = decide_npc(state, player_id, available)
            chosen = next((i for i, item in enumerate(options) if item == action), 0)
            if not config["trainNetworkOnly"] and len(options) > 1:
                rows.append({"playerId": player_id, "state": encoded_state.copy(),
                             "actions": action_vectors.copy(), "chosen": chosen,
                             "oldProb": 1.0 / len(options), "oldValue": value_vector,
                             "temperature": float(temperature)})
        action = options[chosen]
        result = apply_action(state, player_id, action)
        if not result.get("ok"):
            fallback_count += 1
            replacement = None
            for candidate in options:
                trial = copy.deepcopy(state)
                if apply_action(trial, player_id, candidate).get("ok"):
                    replacement = candidate
                    break
            if replacement is None:
                raise RuntimeError("模型选择的行动无效，且找不到合法兜底：" + result.get("error", ""))
            result = apply_action(state, player_id, replacement)
        steps += 1
    if state["phase"] != "gameover":
        if stop_event.is_set():
            return None
        state["scores"] = compute_scores(state)
    rewards = _rank_rewards(state)
    player_ids = [player["id"] for player in state["players"]]
    for row in rows:
        row["reward"], row["valueMask"] = _value_target(player_ids, row["playerId"], rewards)
    network_indices = [i for i, seat in enumerate(seats) if seat["botType"] == "neural"]
    network_rewards = [rewards[player_ids[i]] for i in network_indices]
    winning_indices = {row["playerIdx"] for row in state["scores"]
                       if row["total"] == max(score["total"] for score in state["scores"])}
    network_scores = [row["total"] for row in state["scores"] if row["playerIdx"] in network_indices]
    return {"rows": rows, "steps": steps, "scores": state["scores"], "rounds": state["round"],
            "playerCount": player_count, "inferenceMs": inference_ms, "fallbacks": fallback_count,
            "samplerPid": os.getpid(),
            "gameMs": (time.perf_counter() - game_started) * 1000,
            "networkReward": sum(network_rewards) / max(1, len(network_rewards)),
            "networkWin": sum(index in winning_indices for index in network_indices) / max(1, len(network_indices)),
            "networkScore": sum(network_scores) / max(1, len(network_scores)),
            "winners": sorted(winning_indices)}


def _initialize_sampler(model, config: dict, stop_event) -> None:
    """Install a shared, read-only CPU model in a spawned self-play process."""
    global _SAMPLER_MODEL, _SAMPLER_CONFIG, _SAMPLER_STOP
    import torch
    torch.set_num_threads(1)
    _SAMPLER_MODEL = model.eval()
    _SAMPLER_CONFIG = config
    _SAMPLER_STOP = stop_event


def _sample_game_in_worker(game_number: int):
    if _SAMPLER_MODEL is None or _SAMPLER_CONFIG is None or _SAMPLER_STOP is None:
        raise RuntimeError("自对弈进程尚未初始化")
    import torch
    return _sample_game(_SAMPLER_MODEL, torch.device("cpu"), _SAMPLER_CONFIG,
                        int(game_number), _SAMPLER_STOP)


def _sync_shared_model(torch, source, destination) -> None:
    state = {key: value.detach().to("cpu") for key, value in source.state_dict().items()}
    with torch.no_grad():
        destination.load_state_dict(state, strict=True)


def _training_data(torch, rows: list[dict]) -> dict:
    if not rows:
        return {"states": torch.zeros((0, 672)), "chosen": torch.zeros(0, dtype=torch.long),
                "old_probs": torch.zeros(0), "old_values": torch.zeros((0, 8)),
                "rewards": torch.zeros((0, 8)), "value_masks": torch.zeros((0, 8)),
                "temperatures": torch.zeros(0), "actions_flat": np.zeros((0, ACTION_SIZE), np.float32),
                "lengths": np.zeros(0, np.int64), "offsets": np.zeros(1, np.int64),
                "action_width": ACTION_SIZE, "pi_flat": None, "pi_offsets": None,
                "pi_lengths": None, "has_pi": torch.zeros(0, dtype=torch.bool)}
    lengths = np.asarray([len(row["actions"]) for row in rows], dtype=np.int64)
    offsets = np.zeros(len(rows) + 1, dtype=np.int64)
    np.cumsum(lengths, out=offsets[1:])
    has_pi = np.asarray(["pi" in row for row in rows], dtype=np.bool_)
    pi_lengths = np.asarray([len(row["actions"]) if "pi" in row else 0 for row in rows], dtype=np.int64)
    pi_offsets = np.zeros(len(rows) + 1, dtype=np.int64)
    np.cumsum(pi_lengths, out=pi_offsets[1:])
    pi_flat = (np.concatenate([np.asarray(row["pi"], dtype=np.float32) for row in rows if "pi" in row])
               if np.any(has_pi) else None)
    return {"states": torch.from_numpy(np.stack([row["state"] for row in rows]).astype(np.float32)),
            "chosen": torch.tensor([row["chosen"] for row in rows], dtype=torch.long),
            "old_probs": torch.tensor([row["oldProb"] for row in rows], dtype=torch.float32),
            "old_values": torch.from_numpy(np.stack([row["oldValue"] for row in rows]).astype(np.float32)),
            "rewards": torch.from_numpy(np.stack([row["reward"] for row in rows]).astype(np.float32)),
            "value_masks": torch.from_numpy(np.stack([row["valueMask"] for row in rows]).astype(np.float32)),
            "temperatures": torch.tensor([row["temperature"] for row in rows], dtype=torch.float32),
            "actions_flat": np.concatenate([row["actions"] for row in rows], axis=0).astype(np.float32),
            "lengths": lengths, "offsets": offsets, "action_width": ACTION_SIZE,
            "pi_flat": pi_flat, "pi_offsets": pi_offsets if pi_flat is not None else None,
            "pi_lengths": pi_lengths if pi_flat is not None else None,
            "has_pi": torch.from_numpy(has_pi)}


class TrainingManager:
    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir or ROOT / "training-data")
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._worker_stop = multiprocessing.get_context("spawn").Event()
        self._thread: threading.Thread | None = None
        self._model = None
        self._optimizer = None
        self._torch = None
        self._trainer = None
        self._device = None
        self._log_seq = 0
        self._status = {"state": "idle", "running": False, "stopping": False,
                        "preparing": False, "completedGames": 0, "targetGames": 0,
                        "startedAt": None, "endedAt": None, "point": None,
                        "history": [], "checkpoint": "", "error": "", "logs": [],
                        "profiles": {name: _flat_parameter_count(name) for name in FLAT_PROFILES},
                        "hardware": {"cpu": os.environ.get("PROCESSOR_IDENTIFIER", ""),
                                     "logicalCores": os.cpu_count() or 1,
                                     "runtime": "Python"}, "config": None,
                        "parameterCount": 0}

    def _log(self, message: str) -> None:
        with self._lock:
            self._log_seq += 1
            self._status["logs"].append({"seq": self._log_seq,
                                        "at": datetime.now(timezone.utc).isoformat(),
                                        "text": str(message)[:800]})
            self._status["logs"] = self._status["logs"][-80:]

    def status(self) -> dict:
        with self._lock:
            result = copy.deepcopy(self._status)
            result["pid"] = os.getpid() if result["running"] else None
            profile = (result.get("config") or {}).get("profile", "balanced")
            result["parameterCount"] = result["profiles"].get(profile, result["profiles"]["balanced"])
            result["checkpoints"] = self._checkpoint_list()
            return result

    def _checkpoint_list(self) -> list[dict]:
        try:
            files = sorted(self.data_dir.glob("checkpoint-*.json.gz"), key=lambda p: p.name, reverse=True)[:40]
            return [{"name": p.name, "bytes": p.stat().st_size, "mtimeMs": int(p.stat().st_mtime * 1000)}
                    for p in files if re.fullmatch(r"checkpoint-[\w-]+\.json\.gz", p.name)]
        except OSError:
            return []

    def start(self, raw_config: dict) -> dict:
        config = sanitize_config(raw_config)
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise ValueError("训练任务已经在运行")
            self._stop.clear()
            self._worker_stop.clear()
            config.update({"rulesEngine": "python", "mctsEngine": "python",
                           "neuralNetworkFramework": "pytorch", "backend": "python"})
            self._status.update({"state": "preparing", "running": True, "stopping": False,
                                 "preparing": True, "completedGames": 0,
                                 "targetGames": int(config["targetGames"]),
                                 "startedAt": datetime.now(timezone.utc).isoformat(), "endedAt": None,
                                 "point": None, "history": [], "checkpoint": "", "error": "",
                                 "logs": [], "config": config})
            self._thread = threading.Thread(target=self._run, args=(config,),
                                            name="citadels-python-training", daemon=True)
            self._thread.start()
            return self.status()

    def stop(self) -> dict:
        with self._lock:
            if self._thread and self._thread.is_alive():
                self._stop.set()
                self._worker_stop.set()
                self._status.update({"state": "stopping", "stopping": True})
            return self.status()

    def _run(self, config: dict) -> None:
        games = 0
        saved_game = 0
        sampler_pool = None
        shared_sampler_model = None
        try:
            torch, trainer = _load_trainer()
            self._torch, self._trainer = torch, trainer
            torch.manual_seed(int(config["seed"]))
            np.random.seed(int(config["seed"]) & 0xFFFFFFFF)
            if config["device"] == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("已要求 CUDA，但 PyTorch 无法访问 CUDA")
            self._device = torch.device("cuda" if config["device"] == "cuda" else "cpu")
            architecture = config["networkArchitecture"]
            self._model = trainer.create_model(architecture, config["profile"]).to(self._device)
            resume_path = None
            if config["resumeCheckpoint"]:
                resume_path = self.data_dir / config["resumeCheckpoint"]
                if not resume_path.is_file():
                    raise ValueError("续训 checkpoint 不存在：" + config["resumeCheckpoint"])
                if not re.fullmatch(r"checkpoint-[\w-]+\.json\.gz", resume_path.name):
                    raise ValueError("续训 checkpoint 名称不合法")
                with gzip.open(resume_path, "rb") as handle:
                    raw = handle.read(512 * 1024 * 1024 + 1)
                if len(raw) > 512 * 1024 * 1024:
                    raise ValueError("续训 checkpoint 解压后超过 512 MB")
                checkpoint = json.loads(raw.decode("utf-8"))
                metadata = checkpoint.get("model") or {}
                if metadata.get("architecture") != architecture or metadata.get("profile") != config["profile"]:
                    raise ValueError("续训 checkpoint 的网络架构/profile 与本次配置不一致")
                encoding = checkpoint.get("encoding") or {}
                expected_state = 11 if architecture == "entity-v5" else 8
                if encoding.get("state") != expected_state or encoding.get("action") != 8:
                    raise ValueError("续训 checkpoint 的状态/动作编码版本不兼容")
                values = np.asarray(metadata.get("flat") or [], dtype="<f4")
                if values.size != metadata.get("parameterCount"):
                    raise ValueError("续训 checkpoint 权重数量不匹配")
                with tempfile.NamedTemporaryFile(prefix="citadels-resume-", suffix=".bin", delete=False) as handle:
                    values.tofile(handle)
                    model_path = Path(handle.name)
                try:
                    self._model.load_flat(str(model_path))
                finally:
                    model_path.unlink(missing_ok=True)
                games = int(checkpoint.get("game") or 0)
                with self._lock:
                    self._status["completedGames"] = games
                self._log(f"从 checkpoint 续训：{resume_path.name}（{games} 局）")
            self._model.eval()
            self._optimizer = torch.optim.Adam(self._model.parameters(), lr=config["learningRate"])
            if resume_path:
                optimizer_path = resume_path.with_name(resume_path.name.replace(".json.gz", ".optimizer.pt"))
                if optimizer_path.is_file():
                    self._optimizer.load_state_dict(torch.load(optimizer_path, map_location=self._device,
                                                               weights_only=True))
            with self._lock:
                hardware = {"cpu": os.environ.get("PROCESSOR_IDENTIFIER") or platform.processor(),
                            "logicalCores": os.cpu_count() or 1, "memoryGB": _system_memory_gb(),
                            "runtime": "Python", "torch": torch.__version__, "device": str(self._device),
                            "cuda": torch.version.cuda or ""}
                if self._device.type == "cuda":
                    properties = torch.cuda.get_device_properties(self._device)
                    hardware["gpu"] = torch.cuda.get_device_name(self._device)
                else:
                    hardware.update({"gpu": "", "memoryGB": None})
                self._status.update({"state": "running", "preparing": False,
                                     "hardware": hardware})
            sampler_count = min(int(config["workers"]), int(config["batchGames"]))
            if sampler_count > 1:
                process_context = multiprocessing.get_context("spawn")
                shared_sampler_model = trainer.create_model(architecture, config["profile"]).cpu()
                _sync_shared_model(torch, self._model, shared_sampler_model)
                shared_sampler_model.share_memory()
                sampler_pool = process_context.Pool(
                    processes=sampler_count, initializer=_initialize_sampler,
                    initargs=(shared_sampler_model, config, self._worker_stop))
            self._log(f"Python 训练启动：profile={config['profile']}，架构={architecture}，设备={self._device}；" +
                      f"采样进程={sampler_count}；" +
                      (f"ISMCTS={config['mctsSimulations']} simulations" if config["mctsSimulations"] > 0 else "MCTS=关闭"))
            totals = {"steps": 0, "gameMs": 0.0, "inferenceMs": 0.0,
                      "rounds": 0, "fallbacks": 0, "networkByPlayers": {}, "winSeatsByPlayers": {}}
            while games < config["targetGames"] and not self._stop.is_set():
                if self._device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats(self._device)
                rows: list[dict] = []
                batch_metrics = []
                batch_results = []
                batch_count = int(min(config["batchGames"], config["targetGames"] - games))
                game_numbers = [games + offset + 1 for offset in range(batch_count)]
                if sampler_pool:
                    _sync_shared_model(torch, self._model, shared_sampler_model)
                    sampled_games = sampler_pool.map(_sample_game_in_worker, game_numbers, chunksize=1)
                else:
                    sampled_games = [_sample_game(self._model, self._device, config,
                                                  game_number, self._stop)
                                     for game_number in game_numbers]
                sampler_pids = set()
                for result in sampled_games:
                    if result is None:
                        break
                    games += 1
                    sampler_pids.add(int(result["samplerPid"]))
                    rows.extend(result["rows"])
                    batch_results.append(result)
                    totals["steps"] += result["steps"]
                    totals["gameMs"] += result["gameMs"]
                    totals["inferenceMs"] += result["inferenceMs"]
                    totals["rounds"] += result["rounds"]
                    totals["fallbacks"] += result["fallbacks"]
                    seat_count = result["playerCount"]
                    seat_bucket = totals["winSeatsByPlayers"].setdefault(
                        str(seat_count), {"games": 0, "wins": [0] * seat_count})
                    seat_bucket["games"] += 1
                    for winning_seat in result["winners"]:
                        if 0 <= winning_seat < seat_count:
                            seat_bucket["wins"][winning_seat] += 1
                    bucket = totals["networkByPlayers"].setdefault(str(result["playerCount"]),
                        {"games": 0, "reward": 0.0, "winRate": 0.0})
                    bucket["games"] += 1
                    bucket["reward"] += result["networkReward"]
                    bucket["winRate"] += result["networkWin"]
                    for key in ("reward", "winRate"):
                        bucket[key] /= bucket["games"]
                    with self._lock:
                        self._status["completedGames"] = games
                        elapsed_minutes = max(1e-9, (time.time() - datetime.fromisoformat(self._status["startedAt"]).timestamp()) / 60)
                        self._status["point"] = {"game": games, "networkReward": result["networkReward"],
                            "networkWinRate": result["networkWin"], "networkScore": result["networkScore"],
                            "networkByPlayers": copy.deepcopy(totals["networkByPlayers"]),
                            "networkPlayers": _network_count(config, games, result["playerCount"]),
                            "steps": totals["steps"], "avgGameMs": totals["gameMs"] / games,
                            "avgInferenceMs": totals["inferenceMs"] / max(1, totals["steps"]),
                            "avgRounds": totals["rounds"] / games, "avgScore": result["networkScore"],
                            "gamesPerMinute": games / elapsed_minutes, "fallbacks": totals["fallbacks"],
                            "samplerPids": sorted(sampler_pids),
                            "gpuMemoryMB": (torch.cuda.max_memory_allocated(self._device) / (1024 ** 2)
                                            if self._device.type == "cuda" else 0),
                            "winSeatsByPlayers": copy.deepcopy(totals["winSeatsByPlayers"])}
                    if games % 10 == 0 or games == config["targetGames"]:
                        self._log(f"已完成 {games}/{config['targetGames']} 局；样本 {len(rows)}")
                if self._stop.is_set():
                    break
                if rows:
                    data = _training_data(torch, rows)
                    mcts_ce_required = config["mctsSimulations"] > 0 and config["policyLossMode"] != "ppo"
                    if mcts_ce_required:
                        sample_total = int(data["has_pi"].numel())
                        coverage = float(data["has_pi"].float().mean()) if sample_total else 0.0
                        if sample_total == 0 or coverage < 0.5:
                            raise RuntimeError(f"MCTS 策略目标覆盖率过低：{coverage:.0%}（低于 50%），停止训练避免污染权重")
                    self._model.train()
                    batch_metrics = trainer.train_ppo(self._model, self._optimizer, self._device, data,
                                                      int(config["ppoEpochs"]), int(config["miniBatch"]),
                                                      config["policyLossMode"], mcts_ce_required)
                    self._model.eval()
                    batch_metrics["game"] = games
                    with self._lock:
                        self._status["point"] = {**(self._status.get("point") or {}), **batch_metrics}
                        self._status["history"].append(copy.deepcopy(self._status["point"]))
                        self._status["history"] = self._status["history"][-400:]
                if games and (games % config["checkpointEvery"] == 0 or games >= config["targetGames"] or self._stop.is_set()):
                    self._save_checkpoint(config, games)
                    saved_game = games
            if games and saved_game != games:
                self._save_checkpoint(config, games)
            if sampler_pool:
                sampler_pool.close()
                sampler_pool.join()
                sampler_pool = None
            with self._lock:
                self._status.update({"state": "stopped" if self._stop.is_set() else "completed",
                                     "running": False, "stopping": False, "preparing": False,
                                     "endedAt": datetime.now(timezone.utc).isoformat()})
            self._log("训练已停止。" if self._stop.is_set() else f"训练完成：{games} 局")
        except Exception as exc:
            self._stop.set()
            self._worker_stop.set()
            if sampler_pool:
                sampler_pool.terminate()
                sampler_pool.join()
            with self._lock:
                self._status.update({"state": "error", "running": False, "stopping": False,
                                     "preparing": False, "error": str(exc),
                                     "endedAt": datetime.now(timezone.utc).isoformat()})
            self._log("训练失败：" + "".join(traceback.format_exception(exc))[-800:])

    def _save_checkpoint(self, config: dict, game_number: int) -> str:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        architecture = config["networkArchitecture"]
        tag = (f"p{config['profile']}-a{architecture}-m{int(config['mctsSimulations'])}"
               f"-c{config['charSet']}-s{config['seed']}")
        name = f"checkpoint-{game_number:06d}-{tag}.json.gz"
        temp = tempfile.NamedTemporaryFile(prefix="citadels-model-", suffix=".bin", delete=False)
        temp_path = Path(temp.name)
        temp.close()
        try:
            self._model.save_flat(str(temp_path))
            weights = array.array("f")
            with temp_path.open("rb") as handle:
                weights.fromfile(handle, temp_path.stat().st_size // weights.itemsize)
            state_version = 11 if architecture == "entity-v5" else 8
            payload = {"createdAt": datetime.now(timezone.utc).isoformat(), "game": game_number,
                       "config": config, "encoding": {"state": state_version, "action": 8},
                       "model": {"version": 1, "architecture": architecture,
                                 "profile": config["profile"], "stateSize": int(self._model.state_size)
                                 if hasattr(self._model, "state_size") else 672,
                                 "actionSize": ACTION_SIZE, "parameterCount": len(weights),
                                 "encodingVersion": state_version, "flat": weights.tolist()},
                       "history": self._status.get("history", [])[-400:]}
            compressed = gzip.compress(json.dumps(payload, separators=(",", ":"),
                                       ensure_ascii=False).encode("utf-8"), compresslevel=6)
            path = self.data_dir / name
            pending = path.with_suffix(path.suffix + ".tmp")
            pending.write_bytes(compressed)
            os.replace(pending, path)
            optimizer_path = path.with_name(path.name.replace(".json.gz", ".optimizer.pt"))
            optimizer_temp = optimizer_path.with_suffix(optimizer_path.suffix + ".tmp")
            self._torch.save(self._optimizer.state_dict(), optimizer_temp)
            os.replace(optimizer_temp, optimizer_path)
            with self._lock:
                self._status["checkpoint"] = name
            self._log(f"已保存 checkpoint：{name}")
            return name
        finally:
            temp_path.unlink(missing_ok=True)
