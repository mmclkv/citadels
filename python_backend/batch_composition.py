"""Reproducible per-game mixtures, stratified inside each training batch."""
import numpy as np


def random_batch_composition(config: dict, first_game: int, history_available: bool) -> dict | None:
    if config["selfPlayMode"] != "random-batch":
        return None
    seed = (int(config["seed"]) ^ (int(first_game) * 0x9E3779B1) ^ 0xB5297A4D) & 0xFFFFFFFF
    rng = np.random.default_rng(seed)
    count = int(rng.integers(int(config["minPlayers"]), int(config["maxPlayers"]) + 1))
    # Uniform over feasible integer compositions, with a mandatory learner seat.
    choices = [(main, history, count - main - history)
               for main in range(1, count + 1) for history in range(count - main + 1)]
    main, history, heuristic = choices[int(rng.integers(len(choices)))]
    if not history_available or not config["historicalPoolSize"] or config["historicalOpponentProbability"] <= 0:
        main += history
        history = 0
    return {"firstGame": first_game, "players": count, "main": main,
            "historical": history, "heuristic": heuristic}


def balanced_game_compositions(config, game_numbers, history_available):
    """Balance player counts and rotate non-learner types in groups of three.

    The first complete trio at each player count contains the three pure
    opponent anchors. Further trios draw a random mixture and its rotations,
    giving equal seat totals for all opponent types, apart from partial trios.
    Shuffle before assigning games, so consecutive games need not share a mix.
    """
    if config['selfPlayMode'] != 'random-batch':
        return [None] * len(game_numbers)
    if not game_numbers:
        return []
    seed = (int(config['seed']) ^ (int(game_numbers[0]) * 0x9E3779B1) ^ 0x68E31DA4) & 0xFFFFFFFF
    rng = np.random.default_rng(seed)
    counts = list(range(int(config['minPlayers']), int(config['maxPlayers']) + 1))
    rng.shuffle(counts)
    sizes = {n: len(game_numbers) // len(counts) for n in counts}
    for n in counts[:len(game_numbers) % len(counts)]: sizes[n] += 1
    plans = []
    history_enabled = history_available and config['historicalPoolSize'] and config['historicalOpponentProbability'] > 0
    for n, amount in sizes.items():
        slots = n - 1
        choices = [(a,b,slots-a-b) for a in range(slots+1) for b in range(slots-a+1)]
        local = []
        while len(local) < amount:
            triple = (slots,0,0) if not local and amount >= 3 else choices[int(rng.integers(len(choices)))]
            rotations = [triple, triple[1:]+triple[:1], triple[2:]+triple[:2]]
            rng.shuffle(rotations)
            for main, history, heuristic in rotations[:amount-len(local)]:
                if not history_enabled: main, history = main + history, 0
                local.append(dict(players=n,main=main+1,historical=history,heuristic=heuristic))
        plans.extend(local)
    rng.shuffle(plans)
    return [dict(plan, firstGame=number) for number, plan in zip(game_numbers, plans)]


def composition_summary(plans):
    active = [p for p in plans if p is not None]
    if not active: return None
    return dict(mode='per-game-balanced-v1',games=len(active),
                playerCounts={str(n):sum(p['players']==n for p in active) for n in sorted({p['players'] for p in active})},
                **{key:sum(p[key] for p in active) for key in ('main','historical','heuristic')})
