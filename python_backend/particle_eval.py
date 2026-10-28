"""Paired production-worker arena for hidden-information particle sampling.

Compares the current four-particle sampler, flat 32-particle sampling, and
role-stratified 32-particle sampling with the learned belief network disabled.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import replace
import json
from pathlib import Path
import random
import statistics

from . import cards
from .game_engine_worker import GameEngineWorker
from .native_worker import NativeMctsWorker
from .neural import NeuralPolicy
from .strength_eval import ArenaConfig, run_game, schedule, paired_comparison, _sha


VARIANTS = ("flat4", "flat32", "role32")


def _role_key(world: dict, viewer_id: str) -> tuple:
    players = world.get("players", [])
    viewer = next(i for i, player in enumerate(players) if player.get("id") == viewer_id)
    turn = world.get("turn") or {}
    hidden = []
    for index, player in enumerate(players):
        visible = set(player.get("played", []))
        if turn.get("playerIdx") == index and turn.get("phase") != "setup":
            visible.add(turn.get("charId"))
        roles = tuple(sorted(role for role in player.get("chars", []) if role not in visible))
        if roles:
            hidden.append((index, roles))
    draft = world.get("draft") or {}
    face_down = tuple(sorted(draft.get("faceDown", [])))
    return viewer, tuple(hidden), face_down


def _role_stratified(pool: dict, count: int, seed: int) -> dict:
    worlds, weights = pool["particles"], pool["weights"]
    groups = defaultdict(list)
    for index, world in enumerate(worlds):
        if float(weights[index]) > 0:
            groups[_role_key(world, pool["viewerId"])].append(index)
    masses = {key: sum(float(weights[i]) for i in indices) for key, indices in groups.items()}
    total = sum(masses.values())
    if not groups or not total:
        raise RuntimeError("role stratifier received no positive-weight worlds")
    rng = random.Random(seed)
    keys = list(groups)
    cumulative = []
    running = 0.0
    for key in keys:
        running += masses[key]
        cumulative.append(running)
    start = rng.random() * total / count
    selected_keys = []
    for i in range(count):
        point = start + i * total / count
        selected_keys.append(keys[next(j for j, edge in enumerate(cumulative) if point < edge)])
    allocations = Counter(selected_keys)

    selected = []
    # For each role stratum, draw the hand hypotheses from that stratum's
    # conditional native proposal, using its public-fact likelihood weights.
    for key, amount in allocations.items():
        candidates = list(groups[key])
        local_weights = [float(weights[i]) for i in candidates]
        for _ in range(amount):
            draw = rng.random() * sum(local_weights)
            chosen = len(candidates) - 1
            for j, weight in enumerate(local_weights):
                draw -= weight
                if draw < 0:
                    chosen = j
                    break
            selected.append(worlds[candidates[chosen]])
    rng.shuffle(selected)
    return {"particles": selected, "weights": [1.0] * len(selected),
            "uniqueRoleHypotheses": len(allocations), "proposalCount": len(worlds)}


def _patch_sampler(worker, mode: str, counters: Counter):
    native = worker.determinize

    def sample(*, state, player_id, count, seed, belief=True):
        if mode != "role32":
            result = native(state=state, player_id=player_id, count=count,
                            seed=seed, belief=True)
            counters["proposals"] += len(result["particles"])
            counters["roleHypotheses"] += len({_role_key(w, player_id) for w in result["particles"]})
            return result
        proposal_count = max(128, count * 4)
        proposal = native(state=state, player_id=player_id, count=proposal_count,
                          seed=seed, belief=True)
        proposal["viewerId"] = player_id
        result = _role_stratified(proposal, count, seed ^ 0x7F4A7C15)
        counters["proposals"] += result["proposalCount"]
        counters["roleHypotheses"] += result["uniqueRoleHypotheses"]
        return result

    worker.determinize = sample
    return native


def run(output: Path, engine_path: Path, worker_path: Path, policy_path: Path,
        cycles: int = 4, seed: int = 2026101903, simulations: int = 500,
        depth: int = 2000,
        players=(5, 6, 7, 8), scale_simulations_by_particles: bool = False,
        cycle_only: int | None = None, seat_parity: int | None = None,
        resume: bool = False):
    config = ArenaConfig(players=tuple(players), cycles=cycles, seed=seed,
                         simulations=simulations, particles=4, depth=depth,
                         batch=32, device="cpu", char_set="random")
    cases = schedule(config)
    if cycle_only is not None:
        cases = [case for case in cases if case["cycle"] == cycle_only]
        if not cases:
            raise ValueError(f"no cases for cycle {cycle_only}; cycles={cycles}")
    if seat_parity is not None:
        if seat_parity not in (0, 1):
            raise ValueError("seat parity must be 0 or 1")
        cases = [case for case in cases if case["seat"] % 2 == seat_parity]
        if not cases:
            raise ValueError(f"no cases for seat parity {seat_parity}")
    output.parent.mkdir(parents=True, exist_ok=True)
    if resume:
        if not output.is_dir():
            raise FileNotFoundError(f"cannot resume missing output directory: {output}")
    else:
        output.mkdir(parents=True, exist_ok=False)
    rows = []
    completed_pairs = set()
    games_path = output / "games.jsonl"
    if resume and games_path.is_file():
        case_by_id = {case["case"]: case for case in cases}
        with games_path.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                row = json.loads(line)
                case = case_by_id.get(row.get("case"))
                if (case is None or row.get("variant") not in VARIANTS
                        or row.get("seed") != case["seed"]
                        or row.get("players") != case["players"]
                        or row.get("seat") != case["seat"]):
                    raise ValueError(f"saved game row {line_number} does not match this schedule")
                pair = (row["case"], row["variant"])
                if pair in completed_pairs:
                    raise ValueError(f"duplicate saved game row: {pair}")
                particle_count = 4 if row["variant"] == "flat4" else 32
                expected_simulations = (simulations * particle_count // 4
                                        if scale_simulations_by_particles else simulations)
                if row.get("simulations") != expected_simulations:
                    raise ValueError(f"saved game row {line_number} has a different simulation budget")
                completed_pairs.add(pair)
                rows.append(row)
    engine, worker = GameEngineWorker(engine_path), NativeMctsWorker(worker_path)
    policy = NeuralPolicy(checkpoint=policy_path, worker=worker, device="cpu")
    if policy.error:
        raise RuntimeError(policy.error)
    if getattr(policy, "belief_policy", None):
        policy.belief_policy.disable()
    try:
        for case in cases:
            for variant in VARIANTS:
                if (case["case"], variant) in completed_pairs:
                    continue
                mode = "role32" if variant == "role32" else "flat"
                particle_count = 4 if variant == "flat4" else 32
                variant_simulations = (simulations * particle_count // 4
                                       if scale_simulations_by_particles else simulations)
                arena_config = replace(config, particles=particle_count,
                                       simulations=variant_simulations)
                counters = Counter()
                native_sampler = _patch_sampler(worker, mode, counters)
                try:
                    row = run_game(engine, worker, policy, case, "sample", arena_config)
                finally:
                    worker.determinize = native_sampler
                row.update(variant=variant, particleSampling=mode,
                           simulations=variant_simulations, maxDepth=depth,
                           beliefNetwork=False, proposalWorldsPerGame=counters["proposals"],
                           roleHypothesesPerGame=counters["roleHypotheses"])
                rows.append(row)
                completed_pairs.add((case["case"], variant))
                with games_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(json.dumps({"case": case["case"], "variant": variant,
                                  "completed": row["completed"], "first": row["first"],
                                  "reward": row["reward"], "seconds": round(row["seconds"], 1),
                                  "failure": row["failure"]}, ensure_ascii=False), flush=True)
        config_record = {**config.__dict__, "simulationSelection": "sample",
                         "beliefNetwork": False, "roleProposalCount": 128,
                         "scaleSimulationsByParticles": scale_simulations_by_particles,
                         "cycleOnly": cycle_only,
                         "seatParity": seat_parity,
                         "simulationsPerVariant": {
                             "flat4": simulations,
                             "flat32": simulations * 8 if scale_simulations_by_particles else simulations,
                             "role32": simulations * 8 if scale_simulations_by_particles else simulations,
                         },
                         "opponents": "fixed hard static NPC policy", "weight": str(policy_path.resolve()),
                         "weightSha256": _sha(policy_path), "engine": str(engine_path.resolve()),
                         "engineSha256": _sha(engine_path), "worker": str(worker_path.resolve()),
                         "workerSha256": _sha(worker_path), "cases": cases,
                         "variants": list(VARIANTS)}
        (output / "metadata.json").write_text(json.dumps(config_record, ensure_ascii=False, indent=2), encoding="utf-8")
        summaries = []
        for variant in VARIANTS:
            group = [r for r in rows if r["variant"] == variant and r["completed"]]
            summaries.append({"variant": variant, "games": len(group),
                "firsts": sum(r["first"] for r in group),
                "firstRate": statistics.mean(r["first"] for r in group) if group else None,
                "winShares": sum(r["winShare"] for r in group),
                "winShareRate": statistics.mean(r["winShare"] for r in group) if group else None,
                "meanReward": statistics.mean(r["reward"] for r in group) if group else None,
                "meanRank": statistics.mean(r["rank"] for r in group) if group else None,
                "meanSeconds": statistics.mean(r["seconds"] for r in group) if group else None,
                "meanProposalWorldsPerGame": statistics.mean(r["proposalWorldsPerGame"] for r in group) if group else None,
                "meanRoleHypothesesPerGame": statistics.mean(r["roleHypothesesPerGame"] for r in group) if group else None})
        comparisons = [paired_comparison(rows, a, b, cases)
                       for a, b in (("flat4", "flat32"), ("flat32", "role32"), ("flat4", "role32"))]
        report = {"plannedGamesPerVariant": len(cases),
                  "completedByVariant": {v: sum(r["completed"] for r in rows if r["variant"] == v) for v in VARIANTS},
                  "summaries": summaries, "pairedComparisons": comparisons}
        (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    finally:
        engine.close()
        worker.close()
        if policy and policy._model_dir:
            policy._model_dir.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--engine", required=True, type=Path)
    parser.add_argument("--worker", required=True, type=Path)
    parser.add_argument("--policy", type=Path, default=Path(__file__).resolve().parents[1] / "models/policy-default.json.gz")
    parser.add_argument("--cycles", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2026101903)
    parser.add_argument("--simulations", type=int, default=500)
    parser.add_argument("--depth", type=int, default=2000)
    parser.add_argument("--scale-simulations-by-particles", action="store_true")
    parser.add_argument("--cycle-only", type=int,
                        help="run only this cycle from the full paired schedule (for parallel execution)")
    parser.add_argument("--seat-parity", type=int, choices=(0, 1),
                        help="run only even or odd seats in the selected cycle")
    parser.add_argument("--resume", action="store_true",
                        help="continue in an existing output directory, skipping saved case/variant pairs")
    parser.add_argument("--players", nargs="+", type=int, default=[5, 6, 7, 8])
    args = parser.parse_args()
    run(args.output, args.engine, args.worker, args.policy, args.cycles,
        args.seed, args.simulations, args.depth, args.players,
        args.scale_simulations_by_particles, args.cycle_only, args.seat_parity,
        args.resume)


if __name__ == "__main__":
    main()
