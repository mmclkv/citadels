"""Soft particle weighting from public observations of opponents' decisions."""
from __future__ import annotations

import math

DEFAULT_DECAY = 0.15
MIN_WEIGHT = 1e-6


def collect_constraints(observations: list | None, viewer_index: int) -> list[dict]:
    constraints = []
    if not isinstance(observations, list):
        return constraints
    for index, observation in enumerate(observations):
        if not isinstance(observation, dict) or index == viewer_index:
            continue
        try:
            gold = float(observation.get("gold", 0))
        except (TypeError, ValueError, OverflowError):
            gold = 0
        if not gold >= 1:
            continue
        try:
            hand_size = float(observation.get("handSize") or 0)
        except (TypeError, ValueError, OverflowError):
            hand_size = 0
        constraints.append({"playerIdx": index, "gold": gold,
            "handSize": hand_size,
            "freeColors": observation.get("freeColors")
            if isinstance(observation.get("freeColors"), list) else []})
    return constraints


def count_violations(particle: dict, constraints: list[dict]) -> int:
    violations = 0
    players = particle.get("players") if isinstance(particle, dict) else None
    for constraint in constraints:
        index = constraint["playerIdx"]
        player = players[index] if isinstance(players, list) and index < len(players) else None
        hand = player.get("hand") if isinstance(player, dict) else None
        if not isinstance(hand, list) or not hand:
            continue
        costs = []
        for card in hand:
            if not isinstance(card, dict) or card.get("color") in constraint["freeColors"]:
                continue
            try:
                cost = float(card.get("cost") or 0)
            except (TypeError, ValueError, OverflowError):
                cost = 0
            costs.append(cost if math.isfinite(cost) else 0)
        costs.sort()
        drawn = max(0, len(hand) - constraint["handSize"])
        for cost in costs[min(int(drawn), len(costs)):]:
            if cost <= constraint["gold"]:
                violations += 1
    return violations


def belief_weights(particles: list[dict], viewer_id: str,
                   decay: float = DEFAULT_DECAY) -> list[float]:
    try:
        decay = float(decay)
    except (TypeError, ValueError, OverflowError):
        decay = DEFAULT_DECAY
    if not math.isfinite(decay):
        decay = DEFAULT_DECAY
    weights = [1.0] * len(particles)
    if not particles or decay >= 1:
        return weights
    players = particles[0].get("players") or []
    viewer_index = next((i for i, player in enumerate(players)
                         if player.get("id") == viewer_id), -1)
    constraints = collect_constraints(particles[0].get("observations"), viewer_index)
    if not constraints:
        return weights
    for index, particle in enumerate(particles):
        try:
            value = decay ** count_violations(particle, constraints)
        except (OverflowError, ValueError):
            value = 0
        weights[index] = max(MIN_WEIGHT, value)
    return weights


def belief_diagnostics(particles: list[dict], viewer_id: str) -> dict:
    if not particles:
        return {"constraints": 0, "violations": [], "totalViolations": 0}
    players = particles[0].get("players") or []
    viewer_index = next((i for i, player in enumerate(players)
                         if player.get("id") == viewer_id), -1)
    constraints = collect_constraints(particles[0].get("observations"), viewer_index)
    violations = [count_violations(particle, constraints) for particle in particles]
    return {"constraints": len(constraints), "violations": violations,
            "totalViolations": sum(violations), "distinct": len(set(violations))}
