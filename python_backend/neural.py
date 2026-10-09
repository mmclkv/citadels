"""Thin live-policy adapter to the native MCTS and LibTorch worker."""

from __future__ import annotations

import array
import gzip
import json
import math
import os
import random
import tempfile
from pathlib import Path

import numpy as np

from .model_contract import MODEL_CONTRACTS, validate_checkpoint_contract
from .policy_selection import select_search_action

class NeuralPolicy:
    def __init__(self, checkpoint: str | None = None, profile: str | None = None,
                 device: str | None = None, tta_variants: int | None = None,
                 max_inference_ms: int | None = None, worker=None):
        if checkpoint is not None:
            self.checkpoint = checkpoint
        else:
            self.checkpoint = os.environ.get(
                "CITADELS_NEURAL_CHECKPOINT", str(Path(__file__).resolve().parents[1] / "models" / "policy-default.json.gz"))
        self.profile = profile or os.environ.get("CITADELS_NEURAL_PROFILE", "")
        self.device_name = device or os.environ.get("CITADELS_NEURAL_DEVICE", "auto")
        if self.device_name == "auto":
            self.device_name = "cuda"
        self.architecture = "entity-v6"
        self.action_version = MODEL_CONTRACTS["entity-v6"]["action"]
        self.worker = worker
        self.model_path = ""
        self._model_dir = None
        self.error = ""
        self._last_mcts = {"determinizations": 0, "beliefDecay": 0.5,
                           "defaultSimulations": 5000, "defaultMaxDepth": 2000,
                           "visits": 0, "expansions": 0}
        self._load()

    def _load(self) -> None:
        if self.worker is None:
            self.error = "C++ LibTorch MCTS worker 未启动"
            return
        if not self.checkpoint:
            self.error = "请设置 CITADELS_NEURAL_CHECKPOINT 指向策略网络 checkpoint"
            return
        path = Path(self.checkpoint).expanduser().resolve()
        if not path.is_file():
            self.error = f"找不到策略网络权重：{path}"
            return
        try:
            profile = self.profile
            if path.suffix.lower() == ".gz":
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    checkpoint = json.load(handle)
                metadata = checkpoint.get("model") or {}
                self.architecture = metadata.get("architecture") or ""
                if self.architecture != "entity-v6":
                    raise ValueError(f"仅支持 entity-v6 checkpoint，当前权重架构为：{self.architecture or '未声明'}")
                contract = validate_checkpoint_contract(checkpoint, self.architecture)
                checkpoint_profile = metadata.get("profile") or (checkpoint.get("config") or {}).get("profile") or "balanced"
                if checkpoint_profile not in ("fast", "balanced", "large"):
                    raise ValueError(f"不支持的 checkpoint profile：{checkpoint_profile}")
                if profile and profile != checkpoint_profile:
                    raise ValueError(
                        f"指定的 profile={profile} 与 checkpoint profile={checkpoint_profile} 不匹配")
                self.profile = checkpoint_profile
                self.action_version = contract["action"]
                weights = metadata.get("flat") or []
                if len(weights) != metadata.get("parameterCount"):
                    raise ValueError("checkpoint 参数数量与元数据不符")
                if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in weights):
                    raise ValueError("checkpoint 权重包含非有限数值")
                self._model_dir = tempfile.TemporaryDirectory(prefix="citadels-live-policy-")
                self.model_path = str(Path(self._model_dir.name) / "model.bin")
                values = array.array("f", (float(value) for value in weights))
                with open(self.model_path, "wb") as output:
                    values.tofile(output)
            else:
                raise ValueError("仅支持包含架构与编码元数据的 entity-v6 JSON checkpoint")
            self.checkpoint = str(path)
            self.error = ""
        except Exception as exc:  # model/config errors are surfaced by status, not server startup
            self.model_path = ""
            self.error = str(exc)

    def status(self) -> dict:
        return {"configured": bool(self.worker and self.model_path), "checkpoint": self.checkpoint,
                "architecture": self.architecture, "profile": self.profile,
                "device": self.device_name,
                "game": 0, "message": "策略网络已就绪" if self.worker and self.model_path else self.error,
                "tta": {"variants": 0, "maxInferenceMs": 0, "lastInference": None},
                "mcts": dict(self._last_mcts)}

    def _root_particles(self, state: dict, player_id: str, count: int,
                        seed: int, belief: bool) -> dict:
        if not self.worker or not hasattr(self.worker, "determinize"):
            raise RuntimeError("策略网络要求 C++ worker 提供隐藏信息确定化接口")
        return self.worker.determinize(state=state, player_id=player_id, count=count,
                                       seed=seed, belief=belief)

    def decide(self, state: dict, player_id: str, available: dict | None = None,
               mcts: dict | None = None, *, diagnostics: dict | None = None) -> dict:
        if not self.worker or not self.model_path:
            raise RuntimeError(self.error or "策略网络未加载")
        if not isinstance(available, dict):
            raise RuntimeError("策略网络必须接收 C++ 游戏引擎生成的合法动作")
        candidates = available.get("actions") or []
        if not candidates:
            raise RuntimeError("当前局面没有可评估的合法行动")
        options = mcts or {}
        simulations = max(1, int(options.get("simulations", 5000)))
        max_depth = max(1, int(options.get("maxDepth", 2000)))
        particle_count = max(1, int(options.get("particles", 4)))
        belief = options.get("belief", True) is not False
        decay = 0.5 if belief else 1.0
        rng = random.Random()
        sampled = self._root_particles(state, player_id, particle_count,
                                       rng.randrange(0, 2**32), belief)
        particles = sampled["particles"]
        if not particles:
            raise RuntimeError("无法为当前局面生成合法的隐藏信息确定化样本")
        weights = sampled["weights"]
        result = self.worker.search(
            state=particles[0], particles=particles[1:], root_player_id=player_id,
            legal_actions=candidates, particle_weights=weights,
            model_path=self.model_path, model_version=Path(self.model_path).stat().st_mtime_ns % 2_000_000_000,
            profile=self.profile, architecture=self.architecture, device=self.device_name,
            simulations=simulations, max_depth=max_depth, c_puct=float(options.get("cPuct", 1.0)),
            # Root noise is a self-play exploration mechanism; live play keeps a clean prior.
            dirichlet_alpha=0.3, dirichlet_epsilon=0.0,
            seed=rng.randrange(0, 2**32), batch_size=int(options.get("batchSize", 32)),
            action_encoding_version=self.action_version)
        policy = np.asarray(result["policy"], dtype=np.float64)
        if policy.size != len(candidates) or not np.isfinite(policy).all() or policy.sum() <= 0:
            raise RuntimeError("C++ MCTS 返回了无效策略分布")
        # Live play takes the strongest search action; self-play controls exploration separately.
        selection = options.get("selection", "argmax")
        selected = select_search_action(policy, rng, selection)
        mcts_stats = {"determinizations": result.get("particlesUsed", len(particles)),
                      "beliefDecay": decay, "visits": result.get("visits", 0),
                      "expansions": result.get("expansions", 0),
                      "simulations": simulations, "maxDepth": max_depth, "selection": selection}
        self._last_mcts = mcts_stats
        if diagnostics is not None:
            diagnostics.update({"method": "native-mcts", "profile": self.profile,
                                "architecture": self.architecture, "device": self.device_name,
                                "actionEncodingVersion": self.action_version,
                                "mcts": dict(mcts_stats)})
        return candidates[selected]
