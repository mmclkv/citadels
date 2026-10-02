"""Training orchestration and PyTorch updates around the native game/search worker."""

from __future__ import annotations

import array
import atexit
import copy
import gzip
import json
import multiprocessing
import os
import platform
import re
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import cards
from .native_worker import NativeMctsWorker
from .training_config import sanitize_config

ROOT = Path(__file__).resolve().parents[1]
TRAINING_DIR = ROOT / "training"
ACTION_SIZE = 256
FLAT_PROFILES = {"fast": (256, 128, 128, 64, 64),
                 "balanced": (384, 256, 256, 128, 128),
                 "large": (512, 384, 384, 192, 192)}

_SAMPLER_CONFIG = None
_SAMPLER_STOP = None
_SAMPLER_NATIVE_WORKER = None
_SERVER_NATIVE_WORKER = None


def set_server_native_worker(worker) -> None:
    """Use the server-owned worker for serial training samplers when available."""
    global _SERVER_NATIVE_WORKER
    _SERVER_NATIVE_WORKER = worker


def _close_sampler_worker() -> None:
    global _SAMPLER_NATIVE_WORKER
    if _SAMPLER_NATIVE_WORKER is not None:
        _SAMPLER_NATIVE_WORKER.close()
        _SAMPLER_NATIVE_WORKER = None


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


def _native_worker(config: dict):
    global _SAMPLER_NATIVE_WORKER
    worker_path = config.get("nativeWorkerPath") or os.environ.get("CITADELS_NATIVE_MCTS_WORKER")
    if not worker_path:
        worker_path = ROOT / "native" / "mcts_worker_libtorch.exe"
    worker = _SAMPLER_NATIVE_WORKER or _SERVER_NATIVE_WORKER
    if worker is not None:
        process = getattr(worker, "process", None)
        streams = (getattr(process, "stdin", None), getattr(process, "stdout", None))
        if (process is None or process.poll() is not None or
                any(stream is None or stream.closed for stream in streams)):
            if worker is _SAMPLER_NATIVE_WORKER:
                try:
                    worker.close()
                finally:
                    _SAMPLER_NATIVE_WORKER = None
            worker = None
    if worker is None:
        _SAMPLER_NATIVE_WORKER = NativeMctsWorker(worker_path)
        atexit.register(_close_sampler_worker)
        worker = _SAMPLER_NATIVE_WORKER
    return worker


def _sample_game(config: dict, game_number: int, stop_event: threading.Event):
    game_started = time.perf_counter()
    seed = (int(config["seed"]) + game_number * 0x9E3779B1) & 0xFFFFFFFF
    rng = np.random.default_rng(seed)
    player_count = int(rng.integers(int(config["minPlayers"]), int(config["maxPlayers"]) + 1))
    network_count = _network_count(config, game_number, player_count)
    network_seats = set((game_number - 1 + offset) % player_count for offset in range(network_count))
    seats = [{"id": f"train-{game_number}-{i}", "name": f"玩家 {i + 1}", "isBot": True,
              "botType": "neural" if i in network_seats else "npc",
              "botLevel": config["heuristicDifficulty"]} for i in range(player_count)]
    if stop_event.is_set():
        return None
    worker = _native_worker(config)
    model_path = str(config["nativeModelPath"])
    native_result = worker.selfplay(
        new_game={"seed": int(rng.integers(1, 2**32)), "endDistricts": config["endDistricts"],
                  "charSetMode": config["charSet"], "initialCrownSeat": 0,
                  "startingHand": 4, "startingGold": 2, "seats": seats,
                  "catalog": cards._catalog},
        network_player_ids=[seats[index]["id"] for index in sorted(network_seats)],
        model_path=model_path, model_version=Path(model_path).stat().st_mtime_ns % 2_000_000_000,
        profile=config["profile"], architecture=config["networkArchitecture"],
        device=config["device"], simulations=config["mctsSimulations"],
        max_depth=config["mctsMaxDepth"], c_puct=config["mctsC_puct"],
        dirichlet_alpha=config["mctsDirichletAlpha"],
        dirichlet_epsilon=config["mctsDirichletEpsilon"], seed=seed,
        batch_size=config.get("mctsBatchSize", 32), max_rounds=config["maxRounds"],
        max_steps=config["maxSteps"], action_encoding_version=8,
        particles=config["mctsParticles"], belief=config.get("mctsBelief", True))
    rows = []
    for row in native_result.get("rows") or []:
        player_index = int(row["playerIdx"])
        rows.append({"playerId": seats[player_index]["id"],
                     "state": np.asarray(row["state"], dtype=np.float32),
                     "actions": np.asarray(row["actions"], dtype=np.float32),
                     "pi": np.asarray(row["pi"], dtype=np.float32),
                     "reward": np.asarray(row["reward"], dtype=np.float32),
                     "valueMask": np.asarray(row["valueMask"], dtype=np.float32)})
    native_result["rows"] = rows
    native_result.update({"samplerPid": os.getpid(), "fallbacks": 0,
                          "gameMs": (time.perf_counter() - game_started) * 1000,
                          "inferenceMs": native_result.get("inferenceMs", 0.0)})
    return native_result


def _initialize_sampler(config: dict, stop_event) -> None:
    """Install lightweight sampler state; native worker owns search/inference."""
    global _SAMPLER_CONFIG, _SAMPLER_STOP
    _SAMPLER_CONFIG = config
    _SAMPLER_STOP = stop_event


def _sample_game_in_worker(game_number: int):
    if _SAMPLER_CONFIG is None or _SAMPLER_STOP is None:
        raise RuntimeError("自对弈进程尚未初始化")
    return _sample_game(_SAMPLER_CONFIG, int(game_number), _SAMPLER_STOP)


def _training_data(torch, rows: list[dict]) -> dict:
    if not rows:
        return {"states": torch.zeros((0, 672)), "rewards": torch.zeros((0, 8)),
                "value_masks": torch.zeros((0, 8)), "actions_flat": np.zeros((0, ACTION_SIZE), np.float32),
                "lengths": np.zeros(0, np.int64), "offsets": np.zeros(1, np.int64),
                "action_width": ACTION_SIZE, "pi_flat": np.zeros(0, np.float32),
                "pi_offsets": np.zeros(1, np.int64), "pi_lengths": np.zeros(0, np.int64)}
    lengths = np.asarray([len(row["actions"]) for row in rows], dtype=np.int64)
    offsets = np.zeros(len(rows) + 1, dtype=np.int64)
    np.cumsum(lengths, out=offsets[1:])
    pi_lengths = lengths.copy()
    pi_offsets = np.zeros(len(rows) + 1, dtype=np.int64)
    np.cumsum(pi_lengths, out=pi_offsets[1:])
    pi_flat = np.concatenate([np.asarray(row["pi"], dtype=np.float32) for row in rows])
    return {"states": torch.from_numpy(np.stack([row["state"] for row in rows]).astype(np.float32)),
            "rewards": torch.from_numpy(np.stack([row["reward"] for row in rows]).astype(np.float32)),
            "value_masks": torch.from_numpy(np.stack([row["valueMask"] for row in rows]).astype(np.float32)),
            "actions_flat": np.concatenate([row["actions"] for row in rows], axis=0).astype(np.float32),
            "lengths": lengths, "offsets": offsets, "action_width": ACTION_SIZE,
            "pi_flat": pi_flat, "pi_offsets": pi_offsets, "pi_lengths": pi_lengths}


class TrainingManager:
    def __init__(self, data_dir: str | Path | None = None, native_worker=None):
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
        set_server_native_worker(native_worker)
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
            config.update({"rulesEngine": "cpp", "mctsEngine": "cpp",
                           "neuralNetworkFramework": "libtorch", "backend": "python"})
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
        native_model_dir = None
        try:
            self._log("正在初始化 PyTorch 训练环境…")
            torch, trainer = _load_trainer()
            self._torch, self._trainer = torch, trainer
            self._log(f"PyTorch 已加载（{torch.__version__}），正在初始化随机种子与设备…")
            torch.manual_seed(int(config["seed"]))
            np.random.seed(int(config["seed"]) & 0xFFFFFFFF)
            if config["device"] == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("已要求 CUDA，但 PyTorch 无法访问 CUDA")
            self._device = torch.device("cuda" if config["device"] == "cuda" else "cpu")
            architecture = config["networkArchitecture"]
            self._log(f"正在创建网络：架构={architecture}，profile={config['profile']}…")
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
            worker_path = (config.get("nativeWorkerPath") or
                           os.environ.get("CITADELS_NATIVE_MCTS_WORKER") or
                           str(ROOT / "native" / "mcts_worker_libtorch.exe"))
            if not Path(worker_path).is_file():
                raise FileNotFoundError(f"找不到 C++ LibTorch MCTS worker：{worker_path}")
            native_model_dir = tempfile.TemporaryDirectory(prefix="citadels-native-model-")
            config["nativeWorkerPath"] = str(worker_path)
            config["nativeModelPath"] = str(Path(native_model_dir.name) / "model.bin")
            self._model.save_flat(config["nativeModelPath"])
            with self._lock:
                hardware = {"cpu": os.environ.get("PROCESSOR_IDENTIFIER") or platform.processor(),
                            "logicalCores": os.cpu_count() or 1, "memoryGB": _system_memory_gb(),
                            "runtime": "Python launcher + C++ MCTS/LibTorch inference",
                            "torch": torch.__version__, "device": str(self._device),
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
                self._log(f"正在启动 {sampler_count} 个自对弈采样进程…")
                process_context = multiprocessing.get_context("spawn")
                sampler_pool = process_context.Pool(
                    processes=sampler_count, initializer=_initialize_sampler,
                    initargs=(config, self._worker_stop))
            self._log(f"训练启动：profile={config['profile']}，架构={architecture}，设备={self._device}；" +
                      f"采样进程={sampler_count}；" +
                      f"C++ ISMCTS={config['mctsSimulations']} simulations，深度={config['mctsMaxDepth']}，" +
                      f"粒子={config['mctsParticles']}，batch={config['mctsBatchSize']}，" +
                      f"c_puct={config['mctsC_puct']}，Dirichlet α={config['mctsDirichletAlpha']} " +
                      f"ε={config['mctsDirichletEpsilon']}；LibTorch 前向推理")
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
                self._log(f"开始采样批次：第 {game_numbers[0]}–{game_numbers[-1]} 局（共 {batch_count} 局）…")
                if sampler_pool:
                    self._model.save_flat(config["nativeModelPath"])
                    sampled_games = sampler_pool.imap_unordered(_sample_game_in_worker, game_numbers, chunksize=1)
                else:
                    def serial_samples():
                        self._model.save_flat(config["nativeModelPath"])
                        for game_number in game_numbers:
                            if self._stop.is_set():
                                break
                            self._log(f"正在采样第 {game_number}/{config['targetGames']} 局…")
                            yield _sample_game(config, game_number, self._stop)
                    sampled_games = serial_samples()
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
                    self._log(f"自对弈进度：已完成 {games}/{config['targetGames']} 局")
                    if games % 10 == 0 or games == config["targetGames"]:
                        self._log(f"已完成 {games}/{config['targetGames']} 局；样本 {len(rows)}")
                if self._stop.is_set():
                    break
                if rows:
                    self._log(f"采样批次完成（{len(rows)} 条训练样本），正在执行 MCTS 策略蒸馏更新…")
                    data = _training_data(torch, rows)
                    self._model.train()
                    batch_metrics = trainer.train_mcts_distillation(
                        self._model, self._optimizer, self._device, data,
                        int(config["trainingEpochs"]), int(config["miniBatch"]))
                    self._model.eval()
                    batch_metrics["game"] = games
                    with self._lock:
                        self._status["point"] = {**(self._status.get("point") or {}), **batch_metrics}
                        self._status["history"].append(copy.deepcopy(self._status["point"]))
                        self._status["history"] = self._status["history"][-400:]
                if games and (games % config["checkpointEvery"] == 0 or games >= config["targetGames"] or self._stop.is_set()):
                    self._log(f"正在保存 checkpoint（{games} 局）…")
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
        finally:
            _close_sampler_worker()
            if native_model_dir is not None:
                native_model_dir.cleanup()

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
