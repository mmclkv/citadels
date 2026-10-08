"""Training orchestration and PyTorch updates around the native game/search worker."""

from __future__ import annotations

import array
import atexit
import bisect
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
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import cards
from .native_worker import NativeMctsWorker
from .game_engine_worker import GameEngineWorker
from .model_contract import MODEL_CONTRACTS, validate_checkpoint_contract
from .training_config import sanitize_config
from .historical_policy_pool import HistoricalPolicyPool, assign_seat_policies
from .weakness_search import WeaknessSearch, discovery_due
from .batch_composition import random_batch_composition

ROOT = Path(__file__).resolve().parents[1]
TRAINING_DIR = ROOT / "training"
ACTION_SIZE = 256
_SAMPLER_CONFIG = None
_SAMPLER_STOP = None
_SAMPLER_NATIVE_WORKER = None
_SAMPLER_GAME_WORKER = None
_SERVER_NATIVE_WORKER = None
_SERVER_GAME_WORKER = None
REPLAY_MAX_GAMES = 128
NETWORK_METRIC_WINDOW = 50
VALUE_OBJECTIVE = "win-first-v1"


def _terminal_value_targets(outcome: dict, player_index: int, count: int):
    """Use engine win-first rewards, rotated to the sample actor's seat order."""
    if outcome.get("valueObjective") != VALUE_OBJECTIVE:
        raise RuntimeError("游戏主进程的价值目标不是 win-first-v1，请重新构建并启动引擎")
    reward = np.asarray(outcome["valueRewards"], dtype=np.float32)
    if reward.shape != (count,) or not np.all(np.isfinite(reward)):
        raise RuntimeError("游戏主进程返回的终局价值奖励无效")
    relative = np.zeros(8, dtype=np.float32)
    relative[:min(8, count)] = [reward[(player_index + i) % count]
                                for i in range(min(8, count))]
    mask = np.zeros(8, dtype=np.float32)
    mask[:min(8, count)] = 1
    return relative, mask


class RecentNetworkMetrics:
    """Per-player-count performance over the latest completed games."""

    def __init__(self, window: int = NETWORK_METRIC_WINDOW):
        self.window = max(1, int(window))
        self._games: dict[int, deque[tuple[float, float]]] = {}

    def add(self, player_count: int, reward: float, win_rate: float) -> None:
        samples = self._games.setdefault(int(player_count), deque(maxlen=self.window))
        samples.append((float(reward), float(win_rate)))

    def snapshot(self) -> dict[str, dict]:
        result = {}
        for player_count, samples in self._games.items():
            if not samples:
                continue
            result[str(player_count)] = {
                "games": len(samples),
                "reward": sum(item[0] for item in samples) / len(samples),
                "winRate": sum(item[1] for item in samples) / len(samples),
            }
        return result


def _checkpoint_due(games: int, saved_game: int, interval: int,
                    target_games: int, stopping: bool) -> bool:
    """Save on crossing a checkpoint boundary, not only on exact batch alignment."""
    interval = max(1, int(interval))
    crossed_boundary = games // interval > saved_game // interval
    return bool(games and (crossed_boundary or games >= target_games or stopping))


class RecentReplayBuffer:
    """Recent completed self-play games, bounded by the configured game count."""

    def __init__(self, max_games: int = REPLAY_MAX_GAMES):
        self.max_games = max(0, int(max_games))
        self._games: deque[tuple[list[dict], int]] = deque()
        self.bytes = 0
        self.samples = 0

    @staticmethod
    def _game_bytes(rows: list[dict]) -> int:
        return sum(int(row[key].nbytes) for row in rows
                   for key in ("state", "actions", "pi", "reward", "valueMask")
                   if isinstance(row.get(key), np.ndarray))

    @property
    def game_count(self) -> int:
        return len(self._games)

    def add_game(self, rows: list[dict]) -> bool:
        if not rows or self.max_games == 0:
            return False
        size = self._game_bytes(rows)
        self._games.append((rows, size))
        self.bytes += size
        self.samples += len(rows)
        while len(self._games) > self.max_games:
            evicted_rows, evicted_bytes = self._games.popleft()
            self.bytes -= evicted_bytes
            self.samples -= len(evicted_rows)
        return True

    def sample(self, limit: int, rng: np.random.Generator) -> list[dict]:
        count = min(max(0, int(limit)), self.samples)
        if count == 0:
            return []
        picks = np.asarray(rng.choice(self.samples, size=count, replace=False)).reshape(-1)
        games = list(self._games)
        ends = np.cumsum([len(rows) for rows, _ in games]).tolist()
        sampled = []
        for pick in picks:
            index = int(pick)
            game_index = bisect.bisect_right(ends, index)
            previous_end = ends[game_index - 1] if game_index else 0
            sampled.append(games[game_index][0][index - previous_end])
        return sampled


def _entity_forward_probe_inputs() -> list[tuple[np.ndarray, np.ndarray]]:
    """Build deterministic cases covering seat masks, card IDs and action counts."""
    contract = MODEL_CONTRACTS["entity-v6"]
    state_size = contract["stateSize"]
    state = np.zeros(state_size, dtype=np.float32)
    state[0] = contract["state"]
    state[1] = 5.0 / 8.0  # five occupied seats; exercise padding and valid seats
    state[5] = 8.0 / 12.0
    player_width = 184
    slot_width = 8
    for player in range(5):
        base = 32 + player * player_width
        state[base] = (5 + player) / 20.0
        state[base + 1] = (3 + player % 4) / 20.0
        state[base + 2] = 4.0 / 8.0
        state[base + 3] = float(player == 0)
        state[base + 4] = float(player == 3)
        state[base + 9] = (10 + player) / 100.0
        for slot in range(6):
            identity = (player * 6 + slot) % 30
            offset = base + 56 + slot * slot_width
            state[offset] = (2 + identity % 7) / 8.0
            state[offset + 1] = (identity % 5 + 1) / 5.0
            state[offset + 2] = (2 + identity % 8) / 10.0
            state[offset + 3] = float(identity + 1)
            state[offset + 4] = float(identity % 2)
            state[offset + 5] = (identity % 4) / 8.0
            state[offset + 6] = (player + 1) / 100.0
            state[offset + 7] = float(identity % 7 == 0)
    hand_start = 32 + 8 * player_width
    if state_size >= hand_start + 30:
        state[hand_start:hand_start + 8] = np.asarray(
            [1 / 5, 1 / 4, 1 / 3, 1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 5],
            dtype=np.float32)

    # Sparse, valid-shaped action vectors avoid the previous random floats,
    # which did not resemble the actual categorical action encoding.
    actions = np.zeros((4, 256), dtype=np.float32)
    action_type_indices = (8, 19, 20, 12)  # build, end turn, income, choose player
    for row, action_type in enumerate(action_type_indices):
        actions[row, 0] = min(contract["action"], 9)
        actions[row, 1 + action_type] = 1.0
        actions[row, 107] = (row + 1) / 9.0
        actions[row, 108] = row / 20.0
        actions[row, 109] = row / 8.0
        norm = float(np.linalg.norm(actions[row]))
        if norm > 1.0:
            actions[row] /= norm
        actions[row, 182] = float(row == 0)
        actions[row, 183] = float(row == 0)
        actions[row, 188] = row / 20.0
        actions[row, 213] = float(row == 2)
    probes = [(state, actions)]

    # A two-seat state forces the transformer to mask the remaining player
    # tokens. Keep self and hand features, but clear all absent-seat records.
    two_seat = state.copy()
    two_seat[1] = 2.0 / 8.0
    two_seat[32 + 2 * player_width:32 + 8 * player_width] = 0.0
    probes.append((two_seat, actions[:1].copy()))

    # Exercise the full eight-seat path and a wider, differently ordered set
    # of candidate actions. Only touch numeric/categorical slots deliberately.
    eight_seat = state.copy()
    eight_seat[1] = 1.0
    for player in range(5, 8):
        base = 32 + player * player_width
        eight_seat[base:base + player_width] = state[32 + (player - 5) * player_width:
                                                       32 + (player - 4) * player_width]
        eight_seat[base] += player / 100.0
    many_actions = np.zeros((11, ACTION_SIZE), dtype=np.float32)
    action_types = (20, 8, 12, 19, 8, 20, 12, 19, 8, 20, 12)
    for row, action_type in enumerate(action_types):
        many_actions[row, 0] = min(contract["action"], 9)
        many_actions[row, 1 + action_type] = 1.0
        many_actions[row, 107] = (row + 1) / 12.0
        many_actions[row, 108] = (row % 5) / 8.0
        many_actions[row, 109] = (row % 7) / 10.0
    probes.append((eight_seat, many_actions))
    return probes


def set_server_native_worker(worker, game_worker=None) -> None:
    """Use the server-owned worker for serial training samplers when available."""
    global _SERVER_NATIVE_WORKER, _SERVER_GAME_WORKER
    _SERVER_NATIVE_WORKER = worker
    _SERVER_GAME_WORKER = game_worker


def _close_sampler_worker() -> None:
    global _SAMPLER_NATIVE_WORKER, _SAMPLER_GAME_WORKER
    if _SAMPLER_NATIVE_WORKER is not None:
        _SAMPLER_NATIVE_WORKER.close()
        _SAMPLER_NATIVE_WORKER = None
    if _SAMPLER_GAME_WORKER is not None:
        _SAMPLER_GAME_WORKER.close()
        _SAMPLER_GAME_WORKER = None


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


def _load_trainer():
    import sys
    if str(TRAINING_DIR) not in sys.path:
        sys.path.insert(0, str(TRAINING_DIR))
    import torch
    import gpu_trainer
    return torch, gpu_trainer


def _entity_parameter_count(profile: str) -> int:
    model_dim, _heads, layers, ff_dim, action_hidden = {
        "fast": (128, 4, 2, 256, 128),
        "balanced": (192, 4, 3, 384, 192),
        "large": (256, 4, 3, 512, 256),
    }[profile]
    dense = lambda inputs, outputs: inputs * outputs + outputs
    player_input = 56 + 16 * (7 + 8)
    global_input = 32 + 256
    total = dense(global_input, model_dim) + dense(player_input, model_dim)
    total += 31 * 8 + dense(player_input + 30, model_dim)
    total += dense(ACTION_SIZE, model_dim)
    total += layers * (4 * dense(model_dim, model_dim) + dense(model_dim, ff_dim) +
                       dense(ff_dim, model_dim) + 4 * model_dim)
    total += dense(model_dim * 2, action_hidden) + dense(action_hidden, 1) + dense(model_dim, 1)
    return total


def _network_count(config: dict, game_number: int, player_count: int) -> int:
    mode = config["selfPlayMode"]
    if mode in ("all-network", "random-batch"):
        return player_count
    if mode == "network-vs-heuristic":
        return max(1, min(player_count, config["networkPlayerCount"] or 1))
    start = max(1, min(player_count, config["curriculumStartPlayers"] or 1))
    end = max(start, min(player_count, config["curriculumEndPlayers"] or player_count))
    increments = max(0, (game_number - 1) // config["curriculumStepGames"])
    return min(end, start + increments)


def _temperature_policy(policy, temperature: float) -> np.ndarray:
    """Apply the training action temperature to an MCTS visit distribution."""
    probs = np.asarray(policy, dtype=np.float64)
    probs = np.maximum(probs, 0.0)
    if probs.size == 0:
        return probs
    temperature = max(1e-6, float(temperature))
    positive = probs > 0
    if not positive.any():
        return np.full(probs.size, 1.0 / probs.size)
    # Work in log space so low temperatures do not overflow.
    logits = np.full(probs.shape, -np.inf, dtype=np.float64)
    logits[positive] = np.log(probs[positive]) / temperature
    logits[positive] -= np.max(logits[positive])
    probs = np.exp(logits)
    return probs / probs.sum()


def _native_worker(config: dict):
    global _SAMPLER_NATIVE_WORKER
    worker_path = config.get("nativeWorkerPath") or os.environ.get("CITADELS_NATIVE_MCTS_WORKER")
    if not worker_path:
        suffix = ".exe" if os.name == "nt" else ""
        candidates = list((ROOT / "native").glob(f"mcts_worker_libtorch-*{suffix}"))
        worker_path = (max(candidates, key=lambda item: item.stat().st_mtime_ns)
                       if candidates else ROOT / "native" / f"mcts_worker_libtorch{suffix}")
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


def _game_worker(config: dict):
    global _SAMPLER_GAME_WORKER
    worker = _SAMPLER_GAME_WORKER or _SERVER_GAME_WORKER
    if worker is not None and worker.process.poll() is None:
        return worker
    if worker is not None and worker is _SAMPLER_GAME_WORKER:
        try:
            worker.close()
        finally:
            _SAMPLER_GAME_WORKER = None
    suffix = ".exe" if os.name == "nt" else ""
    candidates = list((ROOT / "native").glob(f"game_engine-*{suffix}"))
    fallback = max(candidates, key=lambda item: item.stat().st_mtime_ns) if candidates else ROOT / "native" / f"game_engine{suffix}"
    path = config.get("gameEnginePath") or fallback
    _SAMPLER_GAME_WORKER = GameEngineWorker(path)
    atexit.register(_close_sampler_worker)
    return _SAMPLER_GAME_WORKER


def _sample_game(config: dict, game_number: int, stop_event: threading.Event):
    game_started = time.perf_counter()
    seed = (int(config["seed"]) + game_number * 0x9E3779B1) & 0xFFFFFFFF
    rng = np.random.default_rng(seed)
    player_count = int(rng.integers(int(config["minPlayers"]), int(config["maxPlayers"]) + 1))
    discovery = config.get("weaknessRun") or {}
    composition = config.get("batchComposition") if not discovery else None
    if composition:
        player_count = composition["players"]
    player_count = discovery.get("playerCount", player_count)
    network_count = _network_count(config, game_number, player_count)
    if composition:
        network_count = composition["main"] + composition["historical"]
    temperature_progress = (game_number - 1) / max(1, int(config["targetGames"]) - 1)
    training_temperature = (float(config["temperatureStart"]) + temperature_progress *
                           (float(config["temperatureEnd"]) - float(config["temperatureStart"])))
    network_seats = set((game_number - 1 + offset) % player_count for offset in range(network_count))
    learner_seat = discovery.get("learnerSeat", (game_number - 1) % player_count)
    if composition:
        other_seats = [seat for seat in range(player_count) if seat != learner_seat]
        shuffled = np.random.default_rng(seed ^ 0x68E31DA4).permutation(other_seats)
        network_seats = {learner_seat, *(int(seat) for seat in shuffled[:network_count - 1])}
    seats = [{"id": f"train-{game_number}-{i}", "name": f"玩家 {i + 1}", "isBot": True,
              "botType": "neural" if i in network_seats else "npc",
              "botLevel": config["heuristicDifficulty"]} for i in range(player_count)]
    if stop_event.is_set():
        return None
    worker = _native_worker(config)
    seat_policies = assign_seat_policies(config, network_seats,
                                       learner_seat,
                                       np.random.default_rng(seed ^ 0xA511E9B3))
    current_network_seats = {seat for seat, policy in seat_policies.items()
                             if not policy["historical"]}
    game_worker = _game_worker(config)
    game_id = f"training-{os.getpid()}-{game_number}-{seed}"
    state = game_worker.create_game(
        {"seed": int(rng.integers(1, 2**32)), "endDistricts": config["endDistricts"],
                  "charSetMode": config["charSet"], "initialCrownSeat": discovery.get("crownSeat", 0),
                  "startingHand": 4, "startingGold": 2, "seats": seats,
                  "catalog": cards._catalog}, game_id)
    network_ids = {seats[index]["id"] for index in network_seats}
    rows = []
    steps = rounds = 0
    inference_ms = 0.0
    inference_searches = 0
    try:
        while steps < int(config["maxSteps"]):
            if stop_event.is_set():
                game_worker.close_game(game_id)
                return None
            current = game_worker.current(game_id)
            if current.get("gameOver"):
                break
            if int(current.get("round", 1)) > int(config["maxRounds"]):
                break
            actor_id = current.get("playerId")
            if not actor_id:
                raise RuntimeError("游戏主进程未返回当前行动玩家")
            if actor_id not in network_ids:
                advanced = game_worker.advance_npcs(
                    game_id=game_id, network_player_ids=sorted(network_ids), seed=seed + steps,
                    max_steps=int(config["maxSteps"]) - steps,
                    max_rounds=int(config["maxRounds"]))
                for sample in advanced.get("trainingSamples") or []:
                    rows.append({"playerId": sample["playerId"],
                                 "state": np.asarray(sample["state"], dtype=np.float32),
                                 "actions": np.zeros((0, ACTION_SIZE), dtype=np.float32),
                                 "pi": np.zeros(0, dtype=np.float32),
                                 "reward": None, "valueMask": None})
                advanced_state = advanced.get("state") or {}
                if (int(advanced.get("steps", 0)) == 0 and not advanced.get("gameOver") and
                        int(advanced_state.get("round", 1)) <= int(config["maxRounds"])):
                    raise RuntimeError("游戏主进程没有推进 NPC 回合")
                steps += int(advanced.get("steps", 0))
                state = advanced_state
                rounds = int(state.get("round", rounds))
                continue
            decision = game_worker.decision(game_id)
            state = decision["state"]
            actor_id = decision["playerId"]
            actor_seat = next(index for index, seat in enumerate(seats) if seat["id"] == actor_id)
            actor_policy = seat_policies[actor_seat]
            historical = actor_policy["historical"]
            evaluation = discovery.get("evaluation", False)
            direct_training = discovery.get("directTraining", False) and not historical
            collect = not historical and not evaluation
            actions = decision.get("actions") or []
            if not actions:
                raise RuntimeError(f"游戏主进程返回空合法动作：phase={state.get('phase')} player={actor_id}")
            particle_result = worker.determinize(
                state=state, player_id=actor_id, count=config["mctsParticles"],
                seed=int(rng.integers(1, 2**32)), belief=config.get("mctsBelief", True))
            particles = particle_result["particles"]
            particle_weights = particle_result["weights"]
            if not particles or len(particles) != len(particle_weights):
                raise RuntimeError("C++ 确定化返回的局面与信念权重数量不一致")
            search_started = time.perf_counter()
            search_result = worker.search(
                state=particles[0], particles=particles[1:], root_player_id=actor_id,
                legal_actions=actions, particle_weights=particle_weights,
                model_path=actor_policy["modelPath"], model_version=actor_policy["modelVersion"], profile=config["profile"],
                architecture=config["networkArchitecture"], device=config["device"],
                simulations=(1 if len(actions) == 1 else config["mctsSimulations"]),
                max_depth=config["mctsMaxDepth"],
                c_puct=config["mctsC_puct"], dirichlet_alpha=(0 if historical or discovery else config["mctsDirichletAlpha"]),
                dirichlet_epsilon=(0 if historical or discovery else config["mctsDirichletEpsilon"]), seed=seed + steps,
                batch_size=config.get("mctsBatchSize", 32),
                action_encoding_version=actor_policy["actionEncodingVersion"],
                include_training_features=collect, policy_only=direct_training)
            policy = np.asarray(search_result["policy"], dtype=np.float32)
            inference_ms += float(search_result.get("inferenceMs") or
                                  (time.perf_counter() - search_started) * 1000)
            inference_searches += 1
            state_features = search_result.get("stateFeatures")
            action_features = search_result.get("actionFeatures")
            if collect and (state_features is None or action_features is None):
                raise RuntimeError("MCTS 未返回训练所需的状态/动作特征")
            if collect:
                rows.append({"playerId": actor_id,
                             "state": np.asarray(state_features, dtype=np.float32),
                             "actions": np.asarray(action_features, dtype=np.float32),
                             "pi": policy, "reward": None, "valueMask": None})
            probs = _temperature_policy(policy, 1.0 if historical or discovery else training_temperature)
            # Held-out opponents use the same clean, stochastic policy as pool
            # opponents; matched seeds make baseline/candidate cases reproducible.
            choice = int(rng.choice(len(actions), p=probs))
            if collect and direct_training:
                rows[-1]["chosenAction"] = choice
                rows[-1]["behaviorProbability"] = float(probs[choice])
            action = actions[choice]
            game_worker.apply(game_id=game_id, player_id=actor_id, action=action,
                              return_state=False)
            steps += 1
            rounds = int(decision.get("round", rounds))
        current = game_worker.current(game_id, include_rewards=True)
        state = game_worker.snapshot(game_id)
        completed = bool(current.get("gameOver"))
        if completed and current.get("valueObjective") != VALUE_OBJECTIVE:
            raise RuntimeError("游戏主进程的价值目标不是 win-first-v1，请重新构建并启动引擎")
        rounds = max(rounds, int(current.get("round") or 0), int(state.get("round") or 0))
        if not completed:
            # Policy targets are still useful, but an unfinished game has no
            # terminal outcome. Drop its rows rather than inventing value labels.
            rows.clear()
        for row in rows:
            player_index = next(i for i, seat in enumerate(seats) if seat["id"] == row["playerId"])
            row["reward"], row["valueMask"] = _terminal_value_targets(current, player_index, len(seats))
        game_worker.close_game(game_id)
    except Exception:
        try:
            game_worker.close_game(game_id)
        except Exception:
            pass
        raise
    colors = {"yellow", "blue", "green", "red", "purple"}
    scores = []
    for index, player in enumerate(state.get("players", [])):
        city = player.get("city") or []
        base = sum(int(card.get("scoreValue", card.get("cost", 0))) for card in city)
        bonus = sum(len(card.get("museum") or []) + int(bool(card.get("beautified"))) for card in city)
        have = {card.get("color") for card in city}
        ghosts = sum(card.get("purpleEffect") == "anyColorScore" and
                     int(card.get("builtRound", 0)) != int(state.get("round", 0)) for card in city)
        if colors.issubset(have) or len(colors - have) <= ghosts:
            bonus += 3
        if int(state.get("firstToFinish", -1)) == index:
            bonus += 4
        elif len(city) >= int(config["endDistricts"]):
            bonus += 2
        scores.append(base + bonus)
    highest = max(scores, default=0)
    winners = [i for i, score in enumerate(scores) if score == highest] if completed else []
    network_indices = sorted(current_network_seats)
    network_reward = (float(np.mean([current["rewards"][i] for i in network_indices]))
                      if completed else None)
    network_win = (sum(i in winners for i in network_indices) / max(1, len(network_indices))
                   if completed else None)
    network_score = (float(np.mean([scores[i] for i in network_indices])) if scores and completed else None)
    native_result = {"rows": rows, "steps": steps, "rounds": rounds,
                     "playerCount": player_count, "gameNumber": game_number,
                     "networkPlayerCount": len(current_network_seats), "completed": completed,
                     "totalNetworkPlayerCount": network_count,
                     "historicalPlayers": network_count - len(current_network_seats),
                     "heuristicPlayers": player_count - network_count,
                     "batchComposition": composition,
                     "historicalCheckpoints": [seat_policies[i]["checkpoint"] for i in sorted(network_seats)
                                               if seat_policies[i]["historical"]],
                     "temperature": training_temperature,
                     "inferenceMs": inference_ms, "inferenceSearches": inference_searches,
                     "networkReward": network_reward, "networkWin": network_win,
                     "networkScore": network_score, "winners": winners,
                     "scores": scores}
    if discovery:
        native_result["targetFirst"] = discovery["targetSeat"] in winners if completed else None
        native_result["challengerFirst"] = learner_seat in winners if completed else None
    native_result.update({"samplerPid": os.getpid(), "fallbacks": 0,
                          "gameMs": (time.perf_counter() - game_started) * 1000,
                          "inferenceMs": native_result.get("inferenceMs", 0.0)})
    return native_result


def _initialize_sampler(config: dict, stop_event) -> None:
    """Install lightweight sampler state; native worker owns search/inference."""
    global _SAMPLER_CONFIG, _SAMPLER_STOP
    _SAMPLER_CONFIG = config
    _SAMPLER_STOP = stop_event


def _sample_game_in_worker(task):
    if _SAMPLER_CONFIG is None or _SAMPLER_STOP is None:
        raise RuntimeError("自对弈进程尚未初始化")
    game_number, composition = task if isinstance(task, tuple) else (task, None)
    config = {**_SAMPLER_CONFIG, "batchComposition": composition}
    return _sample_game(config, int(game_number), _SAMPLER_STOP)


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
    def __init__(self, data_dir: str | Path | None = None, native_worker=None, game_worker=None):
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
        self.native_worker = native_worker
        self.game_worker = game_worker
        set_server_native_worker(native_worker, game_worker)
        self._log_seq = 0
        self._status = {"state": "idle", "running": False, "stopping": False,
                        "preparing": False, "completedGames": 0, "finishedGames": 0, "targetGames": 0,
                        "startedAt": None, "endedAt": None, "point": None,
                        "history": [], "checkpoint": "", "error": "", "logs": [],
                        "profiles": {name: _entity_parameter_count(name)
                                     for name in ("fast", "balanced", "large")},
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

    def _check_entity_forward_parity(self, torch, architecture: str, profile: str,
                                     device, model_path: str, action_version: int,
                                     worker_path: str) -> None:
        if architecture != "entity-v6":
            raise ValueError("训练只支持 entity-v6，拒绝运行未经校验的架构")
        model = self._model
        cases = _entity_forward_probe_inputs()
        state_size = int(cases[0][0].size)
        device_name = "cuda" if getattr(device, "type", "cpu") == "cuda" else "cpu"
        worker = self.native_worker
        owns_worker = worker is None
        if owns_worker:
            worker = NativeMctsWorker(worker_path)
        self._log(f"前向一致性检查：架构={architecture}，state={state_size}，"
                  f"多场景={len(cases)}组（动作数={','.join(str(len(actions)) for _, actions in cases)}）…")
        was_training = model.training
        model.eval()
        try:
            python_outputs = []
            with torch.inference_mode():
                for state, actions in cases:
                    state_tensor = torch.from_numpy(state).unsqueeze(0).to(device)
                    action_tensor = torch.from_numpy(actions).unsqueeze(0).to(device)
                    mask = torch.ones((1, actions.shape[0]), dtype=torch.bool, device=device)
                    py_logits, py_values = model(state_tensor, action_tensor, mask)
                    python_outputs.append((
                        py_logits[0].detach().float().cpu().numpy(),
                        py_values[0].detach().float().cpu().numpy()))
            cpp = worker.forward_probe(
                probes=[{"stateFeatures": state.tolist(), "actionFeatures": actions.tolist()}
                        for state, actions in cases],
                model_path=model_path, profile=profile, architecture=architecture,
                device=device_name, action_encoding_version=action_version)
            cpp_outputs = cpp.get("results")
            if not isinstance(cpp_outputs, list) or len(cpp_outputs) != len(cases):
                raise RuntimeError("C++ 前向检查样本数不匹配："
                                   f"Python={len(cases)} / C++={len(cpp_outputs) if isinstance(cpp_outputs, list) else 'invalid'}")
            max_abs = 0.0
            max_prob_diff = 0.0
            for case_index, ((py_logits, py_values), native_output) in enumerate(zip(python_outputs, cpp_outputs), 1):
                cpp_logits = np.asarray(native_output.get("logits"), dtype=np.float32)
                cpp_values = np.asarray(native_output.get("values"), dtype=np.float32)
                if cpp_logits.shape != py_logits.shape or cpp_values.shape != py_values.shape:
                    raise RuntimeError(
                        f"前向输出形状不一致（样本{case_index}）："
                        f"policy Python={py_logits.shape}/C++={cpp_logits.shape}，"
                        f"value Python={py_values.shape}/C++={cpp_values.shape}")
                if not all(np.isfinite(array).all() for array in (py_logits, py_values, cpp_logits, cpp_values)):
                    raise RuntimeError(f"前向输出包含 NaN/Inf（样本{case_index}），已中止训练")
                logits_diff = np.abs(py_logits - cpp_logits)
                values_diff = np.abs(py_values - cpp_values)
                logits_scale = np.maximum(np.abs(py_logits), np.abs(cpp_logits))
                values_scale = np.maximum(np.abs(py_values), np.abs(cpp_values))
                logits_ok = np.all(logits_diff <= 5e-4 + 5e-4 * logits_scale)
                values_ok = np.all(values_diff <= 5e-4 + 5e-4 * values_scale)
                py_probs = torch.softmax(torch.from_numpy(py_logits), dim=-1).numpy()
                cpp_probs = torch.softmax(torch.from_numpy(cpp_logits), dim=-1).numpy()
                probability_diff = np.abs(py_probs - cpp_probs)
                max_abs = max(max_abs, float(logits_diff.max(initial=0.0)),
                              float(values_diff.max(initial=0.0)))
                max_prob_diff = max(max_prob_diff, float(probability_diff.max(initial=0.0)))
                if not logits_ok or not values_ok or float(probability_diff.max(initial=0.0)) > 5e-5:
                    logit_at = int(np.argmax(logits_diff)) if logits_diff.size else -1
                    value_at = int(np.argmax(values_diff)) if values_diff.size else -1
                    raise RuntimeError(
                        f"Python 与 LibTorch 前向不一致（样本{case_index}，动作数={len(py_logits)}）："
                        f"policy maxAbs={float(logits_diff.max(initial=0.0)):.7g}@{logit_at}，"
                        f"value maxAbs={float(values_diff.max(initial=0.0)):.7g}@{value_at}，"
                        f"policyProb maxAbs={float(probability_diff.max(initial=0.0)):.7g}；"
                        "容差 logits/value=5e-4+5e-4×|output|、probability=5e-5；已中止训练")
            self._log(f"前向一致性检查通过：{len(cases)}组输入，logits/value 最大绝对差={max_abs:.7g}，"
                      f"策略概率最大差={max_prob_diff:.7g}。")
        finally:
            model.train(was_training)
            if owns_worker:
                worker.close()

    def status(self) -> dict:
        with self._lock:
            result = copy.deepcopy(self._status)
            result["pid"] = os.getpid() if result["running"] else None
            config = result.get("config") or {}
            profile = config.get("profile", "balanced")
            result["profiles"] = {name: _entity_parameter_count(name)
                                  for name in ("fast", "balanced", "large")}
            result["parameterCount"] = int(result.get("parameterCount") or
                                           result["profiles"].get(profile, 0))
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
                                 "preparing": True, "completedGames": 0, "finishedGames": 0,
                                 "targetGames": int(config["targetGames"]),
                                 "startedAt": datetime.now(timezone.utc).isoformat(), "endedAt": None,
                                 "point": None, "history": [], "checkpoint": "", "error": "",
                                 "weaknessSearch": None,
                                 "batchComposition": None,
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
        last_weakness_search = 0
        sampler_pool = None
        native_model_dir = None
        replay_buffer = RecentReplayBuffer(max_games=config["replayBufferGames"])
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
            with self._lock:
                self._status["parameterCount"] = sum(parameter.numel() for parameter in self._model.parameters())
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
                resume_contract = validate_checkpoint_contract(checkpoint, architecture)
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
                saved_game = games
                last_weakness_search = games
                with self._lock:
                    self._status["completedGames"] = games
                self._log(f"从 checkpoint 续训：{resume_path.name}（{games} 局）")
                if metadata.get("valueObjective") != VALUE_OBJECTIVE:
                    self._log("旧检查点将按争第一目标续训：90% 夺冠 + 10% 名次；价值头需要继续训练适应新目标")
            self._log("价值训练目标：90% 夺冠 + 10% 名次（win-first-v1）")
            self._model.eval()
            self._optimizer = torch.optim.Adam(self._model.parameters(), lr=config["learningRate"])
            if resume_path:
                optimizer_path = resume_path.with_name(resume_path.name.replace(".json.gz", ".optimizer.pt"))
                if optimizer_path.is_file():
                    self._optimizer.load_state_dict(torch.load(optimizer_path, map_location=self._device,
                                                               weights_only=True))
                    # Keep Adam moments from the checkpoint, but honor the
                    # learning rate explicitly selected for this resumed run.
                    for group in self._optimizer.param_groups:
                        group["lr"] = float(config["learningRate"])
            if resume_path and trainer.migrate_action_encoding(
                    self._model, self._optimizer, resume_contract["action"]):
                self._log("动作编码迁移 v9→v10：新增建筑实例特征；新输入列及 Adam 动量置零，保留旧策略前向结果。")
            suffix = ".exe" if os.name == "nt" else ""
            candidates = list((ROOT / "native").glob(f"mcts_worker_libtorch-*{suffix}"))
            default_worker = (max(candidates, key=lambda item: item.stat().st_mtime_ns)
                              if candidates else ROOT / "native" / f"mcts_worker_libtorch{suffix}")
            worker_path = (config.get("nativeWorkerPath") or
                           str(getattr(self.native_worker, "executable", "")) or
                           os.environ.get("CITADELS_NATIVE_MCTS_WORKER") or
                           str(default_worker))
            if not Path(worker_path).is_file():
                raise FileNotFoundError(f"找不到 C++ LibTorch MCTS worker：{worker_path}")
            native_model_dir = tempfile.TemporaryDirectory(prefix="citadels-native-model-")
            config["nativeWorkerPath"] = str(worker_path)
            game_candidates = list((ROOT / "native").glob(f"game_engine-*{suffix}"))
            default_game = (max(game_candidates, key=lambda item: item.stat().st_mtime_ns)
                            if game_candidates else ROOT / "native" / f"game_engine{suffix}")
            config["gameEnginePath"] = str(getattr(self.game_worker, "executable", "") or default_game)
            config["nativeModelPath"] = str(Path(native_model_dir.name) / "model.bin")
            self._model.save_flat(config["nativeModelPath"])
            historical_pool = HistoricalPolicyPool(
                self.data_dir, Path(native_model_dir.name),
                config["historicalPoolSize"] if config["historicalOpponentProbability"] > 0 else 0,
                config["profile"], sum(parameter.numel() for parameter in self._model.parameters()), self._log)
            historical_pool.refresh()
            config["historicalPoolManifest"] = str(historical_pool.manifest)
            def weakness_progress(state):
                with self._lock:
                    self._status["weaknessSearch"] = state
            weakness_search = WeaknessSearch(
                torch, trainer, self._device, config, self.data_dir, Path(native_model_dir.name),
                _sample_game, _training_data, self._stop, self._log, weakness_progress)
            action_version = MODEL_CONTRACTS[architecture]["action"]
            self._check_entity_forward_parity(
                torch, architecture, config["profile"], self._device,
                config["nativeModelPath"], action_version, worker_path)
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
            sampler_count = int(config["workers"])
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
                      f"训练温度={config['temperatureStart']}→{config['temperatureEnd']}，" +
                      f"c_puct={config['mctsC_puct']}，Dirichlet α={config['mctsDirichletAlpha']} " +
                      f"ε={config['mctsDirichletEpsilon']}；LibTorch 前向推理")
            self._log(f"Replay buffer：最近最多 {replay_buffer.max_games} 局；无固定字节上限，"
                      "内存用量随样本大小增长；每批最多按新样本数等量抽取旧样本")
            totals = {"steps": 0, "gameMs": 0.0, "inferenceMs": 0.0,
                      "inferenceSearches": 0, "rounds": 0, "fallbacks": 0,
                      "incompleteGames": 0, "finishedGames": 0,
                      "winSeatsByPlayers": {}}
            recent_network_metrics = RecentNetworkMetrics()
            metrics_started = time.perf_counter()
            while games < config["targetGames"] and not self._stop.is_set():
                if self._device.type == "cuda":
                    torch.cuda.reset_peak_memory_stats(self._device)
                rows: list[dict] = []
                completed_game_rows: list[list[dict]] = []
                batch_metrics = []
                batch_results = []
                batch_count = int(min(config["batchGames"], config["targetGames"] - games))
                game_numbers = [games + offset + 1 for offset in range(batch_count)]
                composition = random_batch_composition(config, game_numbers[0], bool(historical_pool.entries))
                batch_config = {**config, "batchComposition": composition}
                if composition:
                    self._log(f"批次随机阵容：{composition['players']} 人；当前模型 {composition['main']}，"
                              f"历史策略 {composition['historical']}，启发式 {composition['heuristic']}")
                with self._lock:
                    self._status["batchComposition"] = composition
                self._log(f"开始采样批次：第 {game_numbers[0]}–{game_numbers[-1]} 局（共 {batch_count} 局）…")
                if sampler_pool:
                    self._model.save_flat(config["nativeModelPath"])
                    sampled_games = sampler_pool.imap_unordered(
                        _sample_game_in_worker, [(number, composition) for number in game_numbers], chunksize=1)
                else:
                    def serial_samples():
                        self._model.save_flat(config["nativeModelPath"])
                        for game_number in game_numbers:
                            if self._stop.is_set():
                                break
                            self._log(f"正在采样第 {game_number}/{config['targetGames']} 局…")
                            yield _sample_game(batch_config, game_number, self._stop)
                    sampled_games = serial_samples()
                sampler_pids = set()
                for result in sampled_games:
                    if result is None:
                        break
                    games += 1
                    sampler_pids.add(int(result["samplerPid"]))
                    rows.extend(result["rows"])
                    if result["completed"] and result["rows"]:
                        completed_game_rows.append(result["rows"])
                    batch_results.append(result)
                    totals["steps"] += result["steps"]
                    totals["inferenceMs"] += result["inferenceMs"]
                    totals["inferenceSearches"] += result["inferenceSearches"]
                    totals["fallbacks"] += result["fallbacks"]
                    seat_count = result["playerCount"]
                    if result["completed"]:
                        totals["finishedGames"] += 1
                        totals["gameMs"] += result["gameMs"]
                        totals["rounds"] += result["rounds"]
                        seat_bucket = totals["winSeatsByPlayers"].setdefault(
                            str(seat_count), {"games": 0, "wins": [0] * seat_count})
                        seat_bucket["games"] += 1
                        for winning_seat in result["winners"]:
                            if 0 <= winning_seat < seat_count:
                                seat_bucket["wins"][winning_seat] += 1
                        recent_network_metrics.add(seat_count, result["networkReward"],
                                                   result["networkWin"])
                    else:
                        totals["incompleteGames"] += 1
                        self._log(f"第 {result['gameNumber']} 局触及步数/回合上限，未产生终局标签；已丢弃该局样本。")
                    with self._lock:
                        self._status["completedGames"] = games
                        self._status["finishedGames"] = totals["finishedGames"]
                        elapsed_minutes = max(1e-9, (time.perf_counter() - metrics_started) / 60)
                        finished_games = totals["finishedGames"]
                        self._status["point"] = {"game": games, "networkReward": result["networkReward"],
                            "networkWinRate": result["networkWin"], "networkScore": result["networkScore"],
                            "networkByPlayers": recent_network_metrics.snapshot(),
                            "networkPlayers": result["totalNetworkPlayerCount"],
                            "currentNetworkPlayers": result["networkPlayerCount"],
                            "historicalPlayers": result["historicalPlayers"],
                            "heuristicPlayers": result["heuristicPlayers"],
                            "batchComposition": result["batchComposition"],
                            "historicalCheckpoints": result["historicalCheckpoints"],
                            "historicalPoolCount": len(historical_pool.entries),
                            "temperature": result["temperature"],
                            "steps": totals["steps"],
                            "avgGameMs": totals["gameMs"] / finished_games if finished_games else None,
                            "avgInferenceMs": totals["inferenceMs"] / max(1, totals["inferenceSearches"]),
                            "inferenceSearches": totals["inferenceSearches"],
                            "incompleteGames": totals["incompleteGames"],
                            "finishedGames": totals["finishedGames"],
                            "avgRounds": totals["rounds"] / finished_games if finished_games else None,
                            "avgScore": result["networkScore"],
                            "gamesPerMinute": games / elapsed_minutes,
                            "attemptsPerMinute": games / elapsed_minutes,
                            "finishedGamesPerMinute": finished_games / elapsed_minutes,
                            "fallbacks": totals["fallbacks"],
                            "samplerPids": sorted(sampler_pids),
                            # CUDA allocations are in this Python trainer, not the separate
                            # LibTorch MCTS worker; do not present them as total GPU memory.
                            "gpuMemoryMB": None,
                            "trainerGpuMemoryMB": (torch.cuda.max_memory_allocated(self._device) / (1024 ** 2)
                                                   if self._device.type == "cuda" else 0),
                            "winSeatsByPlayers": copy.deepcopy(totals["winSeatsByPlayers"])}
                    self._log(f"自对弈进度：已完成 {games}/{config['targetGames']} 局")
                    if games % 10 == 0 or games == config["targetGames"]:
                        self._log(f"已完成 {games}/{config['targetGames']} 局；样本 {len(rows)}")
                if self._stop.is_set():
                    break
                if rows:
                    replay_rng = np.random.default_rng(
                        (int(config["seed"]) ^ (games * 0x9E3779B1)) & 0xFFFFFFFF)
                    replay_rows = replay_buffer.sample(len(rows), replay_rng)
                    for game_rows in completed_game_rows:
                        replay_buffer.add_game(game_rows)
                    training_rows = rows + replay_rows
                    self._log(
                        f"采样批次完成：新样本 {len(rows)} 条 + replay {len(replay_rows)} 条；"
                        f"buffer {replay_buffer.game_count} 局 / {replay_buffer.samples} 条 / "
                        f"{replay_buffer.bytes / (1024 * 1024):.1f} MiB，正在更新…")
                    data = _training_data(torch, training_rows)
                    self._model.train()
                    batch_metrics = trainer.train_mcts_distillation(
                        self._model, self._optimizer, self._device, data,
                        int(config["trainingEpochs"]), int(config["miniBatch"]))
                    self._model.eval()
                    self._log(f"更新完成：有效策略决策样本 {batch_metrics['policySamples']} 条（含 epoch 重复）；"
                              f"单动作样本 {batch_metrics['forcedActionSamples']} 条仅训练价值头。")
                    batch_metrics["game"] = games
                    batch_metrics["freshSamples"] = len(rows)
                    batch_metrics["replaySamples"] = len(replay_rows)
                    batch_metrics["replayBufferGames"] = replay_buffer.game_count
                    batch_metrics["replayBufferSamples"] = replay_buffer.samples
                    batch_metrics["replayBufferBytes"] = replay_buffer.bytes
                    with self._lock:
                        self._status["point"] = {**(self._status.get("point") or {}), **batch_metrics}
                        self._status["history"].append(copy.deepcopy(self._status["point"]))
                        self._status["history"] = self._status["history"][-400:]
                if not self._stop.is_set() and discovery_due(games, last_weakness_search, config):
                    weakness_search.run(self._model, games, list(historical_pool.entries.values()))
                    last_weakness_search = games
                    historical_pool.refresh()
                if _checkpoint_due(games, saved_game, config["checkpointEvery"],
                                   config["targetGames"], self._stop.is_set()):
                    self._log(f"正在保存 checkpoint（{games} 局）…")
                    self._save_checkpoint(config, games)
                    historical_pool.refresh()
                    with self._lock:
                        if self._status.get("point") is not None:
                            self._status["point"]["historicalPoolCount"] = len(historical_pool.entries)
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
            contract = MODEL_CONTRACTS[architecture]
            state_version = contract["state"]
            action_version = contract["action"]
            payload = {"createdAt": datetime.now(timezone.utc).isoformat(), "game": game_number,
                       "config": config, "encoding": {"state": state_version, "action": action_version},
                       "model": {"version": 1, "architecture": architecture,
                                 "valueObjective": VALUE_OBJECTIVE,
                                 "profile": config["profile"], "stateSize": int(self._model.state_size)
                                 if hasattr(self._model, "state_size") else 672,
                                 "actionSize": ACTION_SIZE, "parameterCount": len(weights),
                                 "encodingVersion": state_version, "flat": weights.tolist()},
                       "history": self._status.get("history", [])[-400:]}
            if self._status.get("weaknessSearch"):
                payload["weaknessSearchStatus"] = self._status["weaknessSearch"]
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
