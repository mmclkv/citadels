"""Local entity-transformer inference for Python-hosted bot seats."""

from __future__ import annotations

import gzip
import json
import os
import random
import time
from pathlib import Path

import numpy as np

from .encoding import encode_action, encode_state
from .game import get_available_actions
from .views import sanitize
from .belief import belief_weights
from .determinize import determinize
from .mcts import InformationSetMCTS


class NeuralPolicy:
    def __init__(self, checkpoint: str | None = None, profile: str | None = None,
                 device: str | None = None, tta_variants: int | None = None,
                 max_inference_ms: int | None = None):
        if checkpoint is not None:
            self.checkpoint = checkpoint
        else:
            self.checkpoint = os.environ.get(
                "CITADELS_NEURAL_CHECKPOINT", str(Path(__file__).resolve().parents[1] / "models" / "policy-default.json.gz"))
        self.profile = profile or os.environ.get("CITADELS_NEURAL_PROFILE", "")
        self.device_name = device or os.environ.get("CITADELS_NEURAL_DEVICE", "auto")
        self.tta_variants = max(1, min(64, int(tta_variants or os.environ.get(
            "CITADELS_NEURAL_TTA_VARIANTS", "64"))))
        self.max_inference_ms = max(1, int(max_inference_ms or os.environ.get(
            "CITADELS_NEURAL_MAX_INFERENCE_MS", "1800")))
        self.last_inference = {"variants": 0, "timedOut": False, "durationMs": 0}
        self.architecture = os.environ.get("CITADELS_NEURAL_ARCHITECTURE", "entity-v5")
        self.action_version = 8
        self.model = None
        self.device = None
        self.error = ""
        self._last_mcts = {"determinizations": 0, "beliefDecay": 0.15,
                           "defaultSimulations": 500, "defaultMaxDepth": 700,
                           "maxSimulations": 2000, "maxDepthCap": 700,
                           "visits": 0, "expansions": 0}
        self._load()

    def _load(self) -> None:
        if not self.checkpoint:
            self.error = "请设置 CITADELS_NEURAL_CHECKPOINT 指向 entity-v5 checkpoint 或 flat 权重文件"
            return
        path = Path(self.checkpoint).expanduser().resolve()
        if not path.is_file():
            self.error = f"找不到策略网络权重：{path}"
            return
        try:
            import sys
            root = Path(__file__).resolve().parents[1]
            sys.path.insert(0, str(root / "training"))
            import torch
            from entity_transformer import EntityTransformerNet
            self.device = torch.device("cuda" if self.device_name in ("auto", "cuda") and torch.cuda.is_available() else "cpu")
            if self.device_name == "cuda" and self.device.type != "cuda":
                raise RuntimeError("配置要求 CUDA，但 PyTorch CUDA 不可用")
            if path.suffix.lower() == ".gz":
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    checkpoint = json.load(handle)
                metadata = checkpoint.get("model") or {}
                self.architecture = metadata.get("architecture") or "flat"
                if self.architecture not in ("entity-v1", "entity-v2", "entity-v3", "entity-v4", "entity-v5"):
                    raise ValueError(f"不支持的 checkpoint 网络架构：{self.architecture}")
                self.profile = self.profile or metadata.get("profile") or (checkpoint.get("config") or {}).get("profile") or "balanced"
                self.action_version = int((checkpoint.get("encoding") or {}).get("action") or 8)
                weights = np.asarray(metadata.get("flat") or [], dtype=np.float32)
                if len(weights) != metadata.get("parameterCount"):
                    raise ValueError("checkpoint 参数数量与元数据不符")
                import tempfile
                with tempfile.NamedTemporaryFile(prefix="citadels-policy-", suffix=".bin", delete=False) as out:
                    weights.tofile(out)
                    flat_path = Path(out.name)
                try:
                    model = EntityTransformerNet(self.profile, architecture=self.architecture)
                    model.load_flat(str(flat_path))
                finally:
                    flat_path.unlink(missing_ok=True)
            else:
                self.profile = self.profile or "large"
                model = EntityTransformerNet(self.profile, architecture=self.architecture)
                model.load_flat(str(path))
            model.to(self.device)
            model.eval()
            self.model = model
            self.checkpoint = str(path)
            self.error = ""
        except Exception as exc:  # model/config errors are surfaced by status, not server startup
            self.model = None
            self.error = str(exc)

    def status(self) -> dict:
        return {"configured": self.model is not None, "checkpoint": self.checkpoint,
                "architecture": self.architecture, "profile": self.profile,
                "device": str(self.device) if self.device is not None else "",
                "game": 0, "message": "策略网络已就绪" if self.model is not None else self.error,
                "tta": {"variants": getattr(self, "tta_variants", 64),
                        "maxInferenceMs": getattr(self, "max_inference_ms", 1800),
                        "lastInference": dict(getattr(self, "last_inference", {})) or None},
                "mcts": dict(self._last_mcts)}

    @staticmethod
    def _expand(state: dict, player_id: str, actions: list[dict]) -> list[dict]:
        player = next(p for p in state["players"] if p["id"] == player_id)
        hand = player["hand"]
        pending = (state.get("turn") or {}).get("pending") or {}
        result: list[dict] = []
        for action in actions:
            if action.get("disabled"):
                continue
            kind = action.get("type")
            if kind == "lab":
                result.extend({**action, "discardUid": card["uid"]} for card in hand)
            elif kind == "museum":
                result.extend({**action, "cardUid": card["uid"]} for card in hand)
            elif kind == "choose_cards" and pending.get("kind") == "bishop_repay":
                pool = [card for card in hand if card["uid"] != pending.get("uid")]
                count = pending.get("amount", 0)
                if count <= len(pool):
                    from itertools import combinations
                    result.extend({**action, "uids": [c["uid"] for c in group]}
                                  for group in combinations(pool, count))
            elif kind == "choose_cards" and pending.get("kind") == "magician_redraw":
                cursor = pending.get("cursor", 0)
                if cursor < len(hand):
                    card = hand[cursor]
                    result.extend(({"type": kind, "uid": card["uid"], "mode": mode})
                                  for mode in ("skip", "use"))
                else:
                    result.append({**action, "uids": []})
            else:
                result.append(action)
        # Keep first occurrence, matching JS uniqueActions' stable order.
        unique = []
        seen = set()
        for action in result:
            key = json.dumps(action, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if key not in seen:
                seen.add(key)
                unique.append(action)
        return unique

    def _evaluate(self, state: dict, player_index: int, candidates: list[dict]):
        logits, value_vector = self._forward(state, player_index, candidates)
        shifted = logits - np.max(logits)
        priors = np.exp(shifted)
        priors /= max(float(priors.sum()), 1e-30)
        return priors.astype(np.float32), value_vector

    def _forward(self, state: dict, player_index: int, candidates: list[dict]):
        import torch
        player_id = state["players"][player_index]["id"]
        view = sanitize(state, player_id)
        state_vector, context = encode_state(view, player_id, self.architecture)
        action_vectors = [encode_action(action, context, self.action_version) for action in candidates]
        states = torch.from_numpy(state_vector.copy()).to(self.device).unsqueeze(0)
        action_tensor = torch.from_numpy(np.stack(action_vectors)).to(self.device).unsqueeze(0)
        with torch.inference_mode():
            logits, values = self.model(states, action_tensor)
            logits = logits[0].detach().cpu().numpy().astype(np.float32)
            value_vector = values[0].detach().cpu().numpy().astype(np.float32)
        return logits, value_vector

    @staticmethod
    def _augmented_view(view: dict, player_id: str, variant: int) -> dict:
        if variant == 0:
            return view
        seed_text = ":".join(str(value) for value in
                              (view.get("roomId") or "", view.get("round") or 0,
                               view.get("phase") or "", player_id, variant))
        hash_value = 2166136261
        encoded = seed_text.encode("utf-16-le", errors="surrogatepass")
        for offset in range(0, len(encoded), 2):
            code_unit = encoded[offset] | encoded[offset + 1] << 8
            hash_value = ((hash_value ^ code_unit) * 16777619) & 0xFFFFFFFF
        random_state = hash_value

        def next_random() -> float:
            nonlocal random_state
            value = (random_state + 0x6D2B79F5) & 0xFFFFFFFF
            random_state = value
            mixed = (((value ^ (value >> 15)) * (1 | value)) & 0xFFFFFFFF)
            second = (((mixed ^ (mixed >> 7)) * (61 | mixed)) & 0xFFFFFFFF)
            mixed = ((mixed + second) & 0xFFFFFFFF) ^ mixed
            return ((mixed ^ (mixed >> 14)) & 0xFFFFFFFF) / 4294967296

        def js_shuffle(values: list) -> list:
            shuffled = list(values)
            for index in range(len(shuffled) - 1, 0, -1):
                other = int(next_random() * (index + 1))
                shuffled[index], shuffled[other] = shuffled[other], shuffled[index]
            return shuffled

        result = dict(view)
        result["players"] = []
        for player in view.get("players", []):
            updated = dict(player)
            if isinstance(player.get("city"), list):
                updated["city"] = js_shuffle(player["city"])
            if player.get("id") == player_id and isinstance(player.get("hand"), list):
                updated["hand"] = js_shuffle(player["hand"])
            result["players"].append(updated)
        turn = view.get("turn")
        pending = (turn or {}).get("pending") if isinstance(turn, dict) else None
        if isinstance(pending, dict) and isinstance(pending.get("cards"), list):
            result["turn"] = dict(turn)
            result["turn"]["pending"] = dict(pending)
            result["turn"]["pending"]["cards"] = js_shuffle(pending["cards"])
        return result

    def _evaluate_tta(self, state: dict, player_index: int,
                      candidates: list[dict]) -> np.ndarray:
        player_id = state["players"][player_index]["id"]
        view = sanitize(state, player_id)
        deadline = time.monotonic() + self.max_inference_ms / 1000
        aggregate = np.zeros(len(candidates), dtype=np.float64)
        completed = 0
        started = time.monotonic()
        for variant in range(self.tta_variants):
            if completed and time.monotonic() >= deadline:
                break
            augmented = self._augmented_view(view, player_id, variant)
            logits, _ = self._forward_view(augmented, player_id, candidates)
            aggregate += logits
            completed += 1
        shifted = aggregate - np.max(aggregate)
        priors = np.exp(shifted)
        priors /= max(float(priors.sum()), 1e-30)
        self.last_inference = {"variants": completed, "timedOut": completed < self.tta_variants,
                               "durationMs": round((time.monotonic() - started) * 1000, 2)}
        return priors.astype(np.float32)

    def _forward_view(self, view: dict, player_id: str, candidates: list[dict]):
        import torch
        state_vector, context = encode_state(view, player_id, self.architecture)
        action_vectors = [encode_action(action, context, self.action_version) for action in candidates]
        states = torch.from_numpy(state_vector.copy()).to(self.device).unsqueeze(0)
        action_tensor = torch.from_numpy(np.stack(action_vectors)).to(self.device).unsqueeze(0)
        with torch.inference_mode():
            logits, values = self.model(states, action_tensor)
        return (logits[0].detach().cpu().numpy().astype(np.float32),
                values[0].detach().cpu().numpy().astype(np.float32))

    def _root_particles(self, state: dict, player_id: str, actions: list[dict],
                        count: int, rng: random.Random) -> list[dict]:
        baseline = json.dumps(actions, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        particles = []
        for _ in range(count * 3):
            if len(particles) >= count:
                break
            try:
                candidate = determinize(state, player_id, rng.random)
                available = get_available_actions(candidate, player_id).get("actions") or []
                legal = self._expand(candidate, player_id, available)
                signature = json.dumps(legal, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                if signature == baseline:
                    particles.append(candidate)
            except (KeyError, IndexError, TypeError, ValueError):
                continue
        return particles

    def decide(self, state: dict, player_id: str, available: dict | None = None,
               mcts: dict | None = None) -> dict:
        if self.model is None:
            raise RuntimeError(self.error or "策略网络未加载")
        import torch
        actions = (available or get_available_actions(state, player_id)).get("actions") or []
        candidates = self._expand(state, player_id, actions)
        if not candidates:
            raise RuntimeError("当前局面没有可评估的合法行动")
        simulations = max(0, min(2000, int((mcts or {}).get("simulations") or 0)))
        if simulations:
            max_depth = max(1, min(700, int((mcts or {}).get("maxDepth") or 700)))
            particle_count = max(1, min(8, int((mcts or {}).get("particles") or 4)))
            decay = 0.15 if (mcts or {}).get("belief", True) is not False else 1.0
            rng = random.Random()
            particles = self._root_particles(state, player_id, candidates, particle_count, rng)
            if particles:
                weights = belief_weights(particles, player_id, decay)
                player_index = next(i for i, player in enumerate(state["players"])
                                    if player["id"] == player_id)
                search = InformationSetMCTS(self._evaluate, simulations=simulations,
                    max_depth=max_depth, c_puct=1.0,
                    seed=rng.randrange(0, 2**32)).search(particles, player_id, candidates, weights)
                if len(search.policy) == len(candidates) and float(search.policy.sum()) > 0:
                    selected = int(rng.choices(range(len(candidates)), weights=search.policy.tolist(), k=1)[0])
                    self._last_mcts = {"determinizations": len(particles), "beliefDecay": decay,
                        "defaultSimulations": 500, "defaultMaxDepth": 700,
                        "maxSimulations": 2000, "maxDepthCap": 700,
                        "visits": search.visits, "expansions": search.expansions}
                    return candidates[selected]
        player_index = next(i for i, player in enumerate(state["players"])
                            if player["id"] == player_id)
        priors = self._evaluate_tta(state, player_index, candidates)
        selected = int(np.argmax(priors))
        return candidates[selected]
