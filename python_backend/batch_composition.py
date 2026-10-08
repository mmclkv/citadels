"""Reproducible opponent counts sampled once at each main-training batch."""
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
