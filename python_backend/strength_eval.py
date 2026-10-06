"""Isolated paired checkpoint/selection arena using the production C++ workers.

No server, optimizer, checkpoint, room or production process is modified.
Run with: python -m python_backend.strength_eval --help
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import tempfile
import time
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "python_backend"

from . import cards
from .game_engine_worker import GameEngineWorker
from .native_worker import NativeMctsWorker
from .neural import NeuralPolicy
from .policy_selection import select_search_action


@dataclass(frozen=True)
class ArenaConfig:
    players: tuple[int, ...] = (4, 5, 6, 7, 8)
    cycles: int = 2
    seed: int = 20261007
    simulations: int = 500
    particles: int = 4
    depth: int = 700
    batch: int = 32
    c_puct: float = 1.0
    device: str = "cpu"
    max_steps: int = 3000
    max_rounds: int = 100
    repeat_limit: int = 20
    char_set: str = "random"
    opponent_search_ms: int = 0  # deterministic static hard policy by default
    diagnostics: bool = False


def schedule(config):
    if not config.players or len(set(config.players)) != len(config.players) or any(n < 2 or n > 8 for n in config.players):
        raise ValueError("players must contain distinct counts between 2 and 8")
    if any(value <= 0 for value in (config.cycles, config.simulations, config.particles,
                                   config.depth, config.batch, config.max_steps,
                                   config.max_rounds, config.repeat_limit)):
        raise ValueError("arena counts and limits must be positive")
    if not math.isfinite(config.c_puct) or config.c_puct < 0 or config.opponent_search_ms < 0:
        raise ValueError("invalid exploration or opponent budget")
    return [{"case": f"n{n}-c{cycle}-s{seat}", "players": n, "cycle": cycle, "seat": seat,
             "seed": (config.seed ^ ((cycle + 1) * 0x9E3779B1) ^ (n * 0x85EBCA6B)) & 0xFFFFFFFF,
             "crown": cycle % n}
            for cycle in range(config.cycles) for n in config.players for seat in range(n)]


def state_identity(state):
    visible = {key: value for key, value in state.items()
               if key not in ("log", "logs", "events", "rngState")}
    return hashlib.sha256(json.dumps(visible, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def distribution_entropy(values):
    values = [float(value) for value in values]
    total = sum(values)
    if not values or any(not math.isfinite(v) or v < 0 for v in values) or not math.isfinite(total) or total <= 0:
        raise ValueError("invalid diagnostic policy distribution")
    return -sum((v / total) * math.log(v / total) for v in values if v > 0)


def value_calibration(predictions, absolute_rewards, seat):
    """Network vectors are relative to the decision actor, rewards absolute."""
    if not predictions:
        return None
    n = len(absolute_rewards)
    target = [absolute_rewards[(seat + relative) % n] for relative in range(n)]
    if any(len(vector) < n or not all(math.isfinite(v) for v in vector[:n]) for vector in predictions):
        raise ValueError("invalid multiplayer value diagnostic")
    return {'vectorMSE': statistics.mean((vector[i] - target[i]) ** 2 for vector in predictions for i in range(n)),
            'ownMAE': statistics.mean(abs(vector[0] - target[0]) for vector in predictions),
            'outsideRangeFraction': statistics.mean(abs(vector[i]) > 1 for vector in predictions for i in range(n))}


def run_game(engine, worker, policy, case, selection, config):
    game_id = "arena-" + case["case"]
    player_id = f"p{case['seat']}"
    started = time.perf_counter()
    steps = decisions = 0
    seen = defaultdict(int)
    failure = None
    network_values, search_values, network_entropies, search_entropies = [], [], [], []
    result = {**case, "selection": selection, "completed": False, "first": False,
              "winShare": 0, "reward": None, "rank": None}
    try:
        engine.create_game({"seed": case["seed"], "charSetMode": config.char_set,
                            "initialCrownSeat": case["crown"], "endDistricts": 8,
                            "startingHand": 4, "startingGold": 2, "catalog": cards._catalog,
                            "seats": [{"id": f"p{i}", "isBot": True,
                                       "botType": "neural" if i == case["seat"] else "npc",
                                       "botLevel": "hard"} for i in range(case["players"])]}, game_id)
        while True:
            current = engine.current(game_id)
            if current.get("gameOver"):
                outcome = engine.current(game_id, include_rewards=True)
                rewards = outcome["rewards"]
                reward = float(rewards[case["seat"]])
                first = reward >= 1 - 1e-6
                winners = sum(value >= 1 - 1e-6 for value in rewards)
                result.update(completed=True, reward=reward, first=first,
                              winShare=1 / winners if first else 0,
                              rank=round(1 + (1 - reward) * (case["players"] - 1) / 2))
                if config.diagnostics:
                    result['networkCalibration'] = value_calibration(network_values, rewards, case['seat'])
                    result['searchCalibration'] = value_calibration(search_values, rewards, case['seat'])
                break
            if steps >= config.max_steps or current["round"] > config.max_rounds:
                failure = "step/round limit"
                break
            if current.get("playerId") != player_id:
                advanced = engine._request("advance_npcs", gameId=game_id,
                    networkPlayerIds=[player_id], seed=(case["seed"] + steps) & 0xFFFFFFFF,
                    maxSteps=min(128, config.max_steps - steps), maxRounds=config.max_rounds,
                    includeTrainingFeatures=False,
                    heuristicMcts={"timeBudgetMs": config.opponent_search_ms})
                steps += int(advanced["steps"])
                if not advanced["steps"] and not advanced.get("gameOver"):
                    failure = "NPC did not advance"
                    break
                continue
            decision = engine.decision(game_id)
            state, actions = decision["state"], decision["actions"]
            digest = state_identity(state)
            seen[digest] += 1
            if seen[digest] > config.repeat_limit:
                failure = "repeated state"
                break
            if not actions:
                failure = "empty legal actions"
                break
            if len(actions) == 1:
                action = actions[0]
            else:
                seed = (case["seed"] + decisions * 0x9E3779B1) & 0xFFFFFFFF
                samples = ({'particles': [state], 'weights': [1.]} if selection == 'direct' else
                           worker.determinize(state=state, player_id=player_id, count=config.particles,
                                              seed=seed, belief=True))
                search = worker.search(state=samples["particles"][0], particles=samples["particles"][1:],
                    root_player_id=player_id, legal_actions=actions, particle_weights=samples["weights"],
                    model_path=policy.model_path, model_version=1, profile=policy.profile,
                    architecture=policy.architecture, device=config.device, simulations=config.simulations,
                    max_depth=config.depth, c_puct=config.c_puct, dirichlet_alpha=0,
                    dirichlet_epsilon=0, seed=seed ^ 0xA511E9B3, batch_size=config.batch,
                    action_encoding_version=policy.action_version, policy_only=selection == 'direct',
                    include_root_diagnostics=config.diagnostics)
                if len(search["policy"]) != len(actions):
                    raise RuntimeError("search/action count mismatch")
                if config.diagnostics:
                    network_values.append(search['networkValueVector'])
                    search_values.append(search['valueVector'])
                    network_entropies.append(distribution_entropy(search['networkPolicy']))
                    search_entropies.append(distribution_entropy(search['policy']))
                action = actions[select_search_action(search["policy"], random.Random(seed),
                                                       'argmax' if selection == 'direct' else selection)]
                decisions += 1
            engine.apply(game_id=game_id, player_id=player_id, action=action, return_state=False)
            steps += 1
        result["rounds"] = current.get("round")
    except Exception as error:
        failure = f"{type(error).__name__}: {error}"
    finally:
        try:
            engine.close_game(game_id)
        except Exception:
            pass
    result.update(steps=steps, decisions=decisions, seconds=time.perf_counter() - started, failure=failure)
    if config.diagnostics:
        result.update(networkEntropy=statistics.mean(network_entropies) if network_entropies else None,
                      searchEntropy=statistics.mean(search_entropies) if search_entropies else None)
    return result


def _wilson(wins, count):
    if not count:
        return None
    p, z = wins / count, 1.95996398454
    denominator = 1 + z * z / count
    center = (p + z * z / (2 * count)) / denominator
    radius = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator
    return [center - radius, center + radius]


def summarize(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["variant"], row["players"])].append(row)
    output = []
    for (variant, players), group in sorted(grouped.items()):
        completed = [row for row in group if row["completed"]]
        wins = sum(row["first"] for row in completed)
        summary = {"variant": variant, "players": players, "attempted": len(group),
                       "completed": len(completed), "failed": len(group) - len(completed),
                       "wins": wins, "firstRateAllAttempts": wins / len(group),
                       "firstRateCompleted": wins / len(completed) if completed else None,
                       "completedFirstRate95CI": _wilson(wins, len(completed)),
                       "meanReward": statistics.mean(row["reward"] for row in completed) if completed else None,
                       "meanRank": statistics.mean(row["rank"] for row in completed) if completed else None}
        for source in ('networkCalibration', 'searchCalibration'):
            diagnostics = [row[source] for row in completed if row.get(source)]
            summary[source] = {key: statistics.mean(d[key] for d in diagnostics)
                               for key in ('vectorMSE', 'ownMAE', 'outsideRangeFraction')} if diagnostics else None
        output.append(summary)
    return output


def paired_comparison(rows, left, right, expected_cases):
    pairs = defaultdict(dict)
    expected = {case["case"]: case for case in expected_cases}
    if len(expected) != len(expected_cases):
        raise ValueError("duplicate scheduled case")
    for row in rows:
        if row["variant"] in (left, right):
            if row["case"] not in expected or any(row[key] != expected[row["case"]][key]
                    for key in ("players", "cycle", "seat", "seed", "crown")):
                raise ValueError("arena case differs from fixed schedule")
            if row["variant"] in pairs[row["case"]]:
                raise ValueError("duplicate arena case/variant")
            pairs[row["case"]][row["variant"]] = row
    blocks = defaultdict(list)
    differences = []
    for case_id, pair in pairs.items():
        if left in pair and right in pair and pair[left]["completed"] and pair[right]["completed"]:
            delta = pair[left]["reward"] - pair[right]["reward"]
            differences.append(delta)
            case = expected[case_id]
            blocks[(case["players"], case["cycle"])].append(delta)
    # Seats sharing one initial seed are correlated. Only complete seed blocks
    # contribute to the uncertainty estimate, not each seat as independent data.
    block_means = [statistics.mean(values) for (players, _), values in blocks.items()
                   if len(values) == players]
    mean = statistics.mean(differences) if differences else None
    interval = None
    if len(block_means) >= 30:
        half = 1.96 * statistics.stdev(block_means) / math.sqrt(len(block_means))
        block_mean = statistics.mean(block_means)
        interval = [block_mean - half, block_mean + half]
    return {"left": left, "right": right, "cases": len(expected), "completedPairs": len(differences),
            "missingOrFailedPairs": len(expected) - len(differences), "meanRankRewardDelta": mean,
            "completeSeedBlocks": len(block_means), "approxSeedBlock95CI": interval,
            "promotionEligible": len(differences) >= 100 and len(differences) == len(expected)
                and interval is not None and interval[0] > 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--game-engine", required=True, type=Path)
    parser.add_argument("--mcts-worker", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--selection", choices=("both", "argmax", "sample"), default="both")
    parser.add_argument("--players", nargs="+", type=int, default=[4, 5, 6, 7, 8])
    parser.add_argument("--cycles", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--simulations", type=int, default=500)
    parser.add_argument("--particles", type=int, default=4)
    parser.add_argument("--depth", type=int, default=700)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--max-steps", type=int, default=3000)
    parser.add_argument("--max-rounds", type=int, default=100)
    parser.add_argument("--char-set", choices=("base", "dark", "mixed", "random"), default="random")
    parser.add_argument("--opponent-search-ms", type=int, default=0)
    parser.add_argument("--direct-policy", action='store_true', help='add raw network argmax control without MCTS')
    parser.add_argument("--diagnostics", action='store_true', help='record policy entropy and terminal value calibration')
    args = parser.parse_args(argv)
    config = ArenaConfig(players=tuple(args.players), cycles=args.cycles, seed=args.seed,
                         simulations=args.simulations, particles=args.particles, depth=args.depth,
                         batch=args.batch, device=args.device, max_steps=args.max_steps,
                         max_rounds=args.max_rounds, char_set=args.char_set,
                         opponent_search_ms=args.opponent_search_ms, diagnostics=args.diagnostics)
    cases = schedule(config)
    selections = ("argmax", "sample") if args.selection == "both" else (args.selection,)
    if args.direct_policy:
        selections += ('direct',)
    models = [("candidate", args.checkpoint)] + ([("baseline", args.baseline)] if args.baseline else [])
    variants = [f"{label}:{selection}" for label, _ in models for selection in selections]
    binary_hashes = {"gameEngine": _sha(args.game_engine), "mctsWorker": _sha(args.mcts_worker)}
    environment = dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED="1" if config.opponent_search_ms else "0")
    rows = []
    # Exclusive creation prevents accidental replacement of earlier evidence.
    with args.output.open("x", encoding="utf-8") as output, tempfile.TemporaryDirectory(prefix="citadels-arena-") as directory:
        def emit(record):
            line = json.dumps(record, ensure_ascii=False)
            output.write(line + "\n"); output.flush()
            print(line, flush=True)
        snapshots = []
        for label, path in models:
            raw = path.read_bytes()
            frozen = Path(directory) / f"{label}.json.gz"
            frozen.write_bytes(raw)
            snapshots.append((label, frozen, {"label": label, "path": str(path.resolve()),
                                               "sha256": hashlib.sha256(raw).hexdigest()}))
        emit({"type": "manifest", "version": 1, "config": asdict(config), "cases": cases,
              "variants": variants, "binaries": binary_hashes,
              "checkpoints": [metadata for _, _, metadata in snapshots], "rootNoise": 0,
              "opponent": "static-hard" if not config.opponent_search_ms else "hard-mcts",
              "opponentReproducible": not bool(config.opponent_search_ms),
              "searchOpponentModel": "static-native-npc; not a nested heuristic MCTS"})
        try:
            for label, frozen, _ in snapshots:
                # Separate workers per model prevent cross-checkpoint tree/cache leakage.
                engine = worker = policy = None
                try:
                    engine = GameEngineWorker(args.game_engine, env=environment)
                    worker = NativeMctsWorker(args.mcts_worker)
                    policy = NeuralPolicy(str(frozen), device=config.device, worker=worker)
                    if policy.error:
                        raise RuntimeError(policy.error)
                    for case in cases:
                        for selection in selections:
                            row = run_game(engine, worker, policy, case, selection, config)
                            row.update(type="game", variant=f"{label}:{selection}", actionEncoding=policy.action_version)
                            rows.append(row); emit(row)
                            if engine.process.poll() is not None or worker.process.poll() is not None:
                                raise RuntimeError("arena worker exited; remaining cases were not attempted")
                finally:
                    if engine: engine.close()
                    if worker: worker.close()
                    if policy and policy._model_dir: policy._model_dir.cleanup()
        finally:
            comparisons = []
            for label, _ in models:
                if 'argmax' in selections and 'sample' in selections:
                    comparisons.append(paired_comparison(rows, f"{label}:argmax", f"{label}:sample", cases))
                if 'direct' in selections:
                    for selection in selections:
                        if selection != 'direct':
                            comparisons.append(paired_comparison(rows, f'{label}:{selection}', f'{label}:direct', cases))
            if args.baseline:
                for selection in selections:
                    comparisons.append(paired_comparison(rows, f"candidate:{selection}", f"baseline:{selection}", cases))
            emit({"type": "summary", "plannedGames": len(cases) * len(variants), "attemptedGames": len(rows),
                  "results": summarize(rows), "paired": comparisons,
                  "note": "No model is automatically promoted or deployed; incomplete comparisons are not a strength claim."})


if __name__ == "__main__":
    main()
