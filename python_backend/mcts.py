"""Information-set Monte-Carlo tree search with shared statistics across particles."""
from __future__ import annotations

import copy
import json
import math
import random
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .game import apply_action, get_available_actions
from .scoring import compute_scores
from .views import sanitize


@dataclass
class SearchNode:
    player: int
    actions: list[dict]
    priors: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    value_vector: np.ndarray = field(default_factory=lambda: np.zeros(8, dtype=np.float32))
    total: np.ndarray = field(default_factory=lambda: np.zeros(8, dtype=np.float64))
    visits: int = 0
    expanded: bool = False
    # Per action, multiple hidden worlds can lead to different observations.
    children: list[dict[str, "SearchNode"]] = field(default_factory=list)


@dataclass
class SearchResult:
    actions: list[dict]
    policy: np.ndarray
    value_vector: np.ndarray
    visits: int
    expansions: int
    nodes: int
    particles_used: int


def current_actor_index(state: dict) -> int | None:
    if state.get("phase") == "draft" and state.get("draft"):
        draft = state["draft"]
        index = draft.get("stepIdx", 0)
        steps = draft.get("steps") or []
        return steps[index]["player"] if index < len(steps) else None
    if state.get("reaction"):
        return state["reaction"]["playerIdx"]
    if state.get("roundConfirm"):
        return next((i for i, confirmed in enumerate(state["roundConfirm"]["confirmed"])
                     if not confirmed), None)
    turn = state.get("turn")
    return turn.get("playerIdx") if turn else None


def _relative_slot(perspective: int, target: int, player_count: int) -> int:
    return (target - perspective) % player_count if player_count else 0


def _terminal_values(state: dict, perspective: int) -> np.ndarray:
    scores = state.get("scores") or compute_scores(state)
    count = len(scores)
    result = np.zeros(8, dtype=np.float32)
    rewards = []
    for row in scores:
        rank = sum(other["total"] > row["total"] for other in scores)
        rewards.append(1.0 if count == 1 else 1.0 - 2.0 * rank / (count - 1))
    for relative in range(min(8, count)):
        result[relative] = rewards[(perspective + relative) % count]
    return result


def information_set_key(state: dict, player_index: int) -> str:
    """Canonical observable state + legal actions; hidden cards never enter the key."""
    player_id = state["players"][player_index]["id"]
    view = sanitize(state, player_id)
    from .neural import NeuralPolicy
    legal = NeuralPolicy._expand(state, player_id,
                                 get_available_actions(state, player_id).get("actions") or [])
    canonical = {"player": player_index, "view": view, "actions": legal}
    return json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class InformationSetMCTS:
    def __init__(self, evaluator: Callable[[dict, int, list[dict]], tuple[list[float], list[float]]],
                 simulations: int = 100, max_depth: int = 400, c_puct: float = 1.0,
                 max_nodes: int = 20000, seed: int = 1,
                 dirichlet_alpha: float = 0.0, dirichlet_epsilon: float = 0.0):
        self.evaluator = evaluator
        self.simulations = max(0, int(simulations))
        self.max_depth = max(1, int(max_depth))
        self.c_puct = float(c_puct)
        self.max_nodes = max(1, int(max_nodes))
        self.rng = random.Random(seed)
        self.dirichlet_alpha = max(0.0, float(dirichlet_alpha))
        self.dirichlet_epsilon = min(1.0, max(0.0, float(dirichlet_epsilon)))
        self.player_count = 0
        self.expansions = 0
        self.node_count = 0
        self.root_id = ""

    def _expand(self, node: SearchNode, state: dict) -> None:
        if node.expanded:
            return
        if not node.actions:
            node.priors = np.zeros(0, dtype=np.float32)
            node.expanded = True
            return
        priors, values = self.evaluator(state, node.player, node.actions)
        priors = np.asarray(priors, dtype=np.float64).reshape(-1)
        if len(priors) != len(node.actions) or not np.all(np.isfinite(priors)) or np.sum(priors) <= 0:
            priors = np.ones(len(node.actions), dtype=np.float64) / len(node.actions)
        else:
            priors = np.maximum(priors, 0)
            priors /= np.sum(priors)
        vector = np.asarray(values, dtype=np.float32).reshape(-1)
        node.value_vector[:] = 0
        node.value_vector[:min(8, len(vector))] = vector[:8]
        node.priors = priors.astype(np.float32)
        node.children = [{} for _ in node.actions]
        node.expanded = True
        self.expansions += 1

    def _select(self, node: SearchNode) -> int:
        parent_visits = max(1, node.visits)
        best_index, best_score = 0, -float("inf")
        for index, children in enumerate(node.children):
            visits = sum(child.visits for child in children.values())
            q_total = 0.0
            for child in children.values():
                slot = _relative_slot(child.player, node.player, self.player_count)
                if child.visits:
                    q_total += child.total[slot]
            q = q_total / visits if visits else 0.0
            prior = float(node.priors[index]) if index < len(node.priors) else 0.0
            u = self.c_puct * prior * math.sqrt(parent_visits) / (1 + visits)
            score = q + u + (1e-5 * self.rng.random() if visits == 0 else 0.0)
            if score > best_score:
                best_index, best_score = index, score
        return best_index

    def _backup(self, path: list[SearchNode], values: np.ndarray, leaf_player: int) -> None:
        for node in path:
            if not self.player_count:
                node.total[0] += values[0] * (1 if node.player == leaf_player else -1)
            else:
                for relative in range(min(8, self.player_count)):
                    target = (node.player + relative) % self.player_count
                    node.total[relative] += values[_relative_slot(leaf_player, target, self.player_count)]
            node.visits += 1

    def _sample_particle(self, particles: list[dict], weights: list[float] | None) -> dict:
        if len(particles) == 1:
            return particles[0]
        if weights and len(weights) == len(particles) and any(weight > 0 for weight in weights):
            return self.rng.choices(particles, weights=[max(0, float(w)) for w in weights], k=1)[0]
        return self.rng.choice(particles)

    def search(self, particles: list[dict], root_player_id: str, root_actions: list[dict],
               particle_weights: list[float] | None = None) -> SearchResult:
        from .neural import NeuralPolicy
        if not particles:
            return SearchResult(root_actions, np.zeros(len(root_actions), dtype=np.float32),
                                np.zeros(8, dtype=np.float32), 0, 0, 0, 0)
        first = particles[0]
        root_index = next((i for i, player in enumerate(first["players"])
                           if player["id"] == root_player_id), -1)
        if root_index < 0:
            raise ValueError("MCTS 根玩家不在局面中")
        self.player_count = len(first["players"])
        self.expansions = 0
        self.node_count = 1
        self.root_id = root_player_id
        root = SearchNode(root_index, copy.deepcopy(root_actions))
        self._expand(root, first)
        if self.dirichlet_alpha > 0 and self.dirichlet_epsilon > 0 and len(root.priors) > 1:
            noise = np.asarray([self.rng.gammavariate(self.dirichlet_alpha, 1.0)
                                for _ in range(len(root.priors))], dtype=np.float64)
            total_noise = float(noise.sum())
            if total_noise > 0:
                noise /= total_noise
                root.priors = ((1 - self.dirichlet_epsilon) * root.priors +
                               self.dirichlet_epsilon * noise).astype(np.float32)

        for _ in range(self.simulations):
            state = copy.deepcopy(self._sample_particle(particles, particle_weights))
            node = root
            path = [root]
            leaf_values = None
            leaf_player = node.player
            for _depth in range(self.max_depth):
                if state.get("phase") == "gameover":
                    leaf_values = _terminal_values(state, node.player)
                    leaf_player = node.player
                    break
                actor = current_actor_index(state)
                if actor is None:
                    leaf_values = node.value_vector
                    leaf_player = node.player
                    break
                if not node.expanded:
                    self._expand(node, state)
                    leaf_values = node.value_vector
                    leaf_player = node.player
                    break
                if not node.actions:
                    leaf_values = node.value_vector
                    leaf_player = node.player
                    break
                action_index = self._select(node)
                action = node.actions[action_index]
                result = apply_action(state, state["players"][actor]["id"], action)
                if not result.get("ok"):
                    leaf_values = node.value_vector
                    leaf_player = node.player
                    break
                next_actor = current_actor_index(state)
                if state.get("phase") == "gameover":
                    leaf_values = _terminal_values(state, actor)
                    leaf_player = actor
                    break
                if next_actor is None:
                    leaf_values = node.value_vector
                    leaf_player = node.player
                    break
                key = information_set_key(state, next_actor)
                child = node.children[action_index].get(key)
                if child is None:
                    if self.node_count >= self.max_nodes:
                        leaf_values = node.value_vector
                        leaf_player = node.player
                        break
                    next_id = state["players"][next_actor]["id"]
                    next_actions = NeuralPolicy._expand(state, next_id,
                        get_available_actions(state, next_id).get("actions") or [])
                    child = SearchNode(next_actor, copy.deepcopy(next_actions))
                    node.children[action_index][key] = child
                    self.node_count += 1
                node = child
                path.append(node)
            if leaf_values is None:
                leaf_values = node.value_vector
                leaf_player = node.player
            self._backup(path, leaf_values, leaf_player)

        policy = np.zeros(len(root.actions), dtype=np.float32)
        for index, variants in enumerate(root.children):
            policy[index] = sum(child.visits for child in variants.values())
        total_visits = int(np.sum(policy))
        if total_visits:
            policy /= total_visits
        elif len(root.priors) == len(policy):
            policy = root.priors.copy()
        if root.visits:
            value = (root.total / root.visits).astype(np.float32)
        else:
            value = root.value_vector.copy()
        return SearchResult(root.actions, policy, value, total_visits,
                            self.expansions, self.node_count, len(particles))
