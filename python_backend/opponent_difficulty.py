"""Reproducible per-game opponent levels; never consume the game/deal RNG."""
import numpy as np

def heuristic_levels(difficulty, players, seed):
    if difficulty != "random":
        if difficulty not in ("easy", "normal", "hard"):
            raise ValueError("Unknown heuristic difficulty")
        return [difficulty] * players
    rng = np.random.default_rng((int(seed) ^ 0xD1B54A35) & 0xFFFFFFFF)
    return [str(x) for x in rng.choice(("easy", "normal", "hard"), size=players)]
