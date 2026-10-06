"""Shared live/arena selection of the native MCTS visit distribution."""
import math


def select_search_action(policy, rng, selection="sample"):
    values = [float(value) for value in policy]
    total = sum(values)
    if not values or any(not math.isfinite(value) or value < 0 for value in values) or not math.isfinite(total) or total <= 0:
        raise ValueError("MCTS returned an invalid visit distribution")
    if selection == "argmax":
        # Stable legal-action order breaks ties reproducibly.
        return max(range(len(values)), key=values.__getitem__)
    if selection == "sample":
        return rng.choices(range(len(values)), weights=values, k=1)[0]
    raise ValueError(f"unknown search selection: {selection}")
