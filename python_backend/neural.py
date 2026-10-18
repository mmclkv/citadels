"""Thin live-policy adapter to the native MCTS and LibTorch worker."""

from __future__ import annotations

import array
import gzip
import json
import math
import os
import random
import tempfile
import time
from pathlib import Path

import numpy as np

from .model_contract import MODEL_CONTRACTS, validate_checkpoint_contract
from .policy_selection import select_search_action
from .belief import BeliefPolicy

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
        self.state_version = MODEL_CONTRACTS["entity-v6"]["state"]
        self.action_version = MODEL_CONTRACTS["entity-v6"]["action"]
        self.worker = worker
        self.belief_policy = BeliefPolicy()
        self.model_path = ""
        self._model_dir = None
        self.error = ""
        self._last_mcts = {"determinizations": 0, "beliefDecay": 0.5,
                           "automatic": True, "timeBudgetMs": 10000,
                           "defaultSimulations": 2_147_483_647, "defaultMaxDepth": 700,
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
                self.state_version = contract["state"]
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
                "stateEncodingVersion": self.state_version, "actionEncodingVersion": self.action_version,
                "device": self.device_name,
                "game": 0, "message": "策略网络已就绪" if self.worker and self.model_path else self.error,
                "tta": {"variants": 0, "maxInferenceMs": 0, "lastInference": None},
                "mcts": dict(self._last_mcts),
                "beliefNetwork": self.belief_policy.status() if hasattr(self, 'belief_policy') else {"configured": False}}

    def observe_belief(self, state):
        if hasattr(self, 'belief_policy'):
            self.belief_policy.update(state)

    def _root_particles(self, state: dict, player_id: str, count: int,
                        seed: int, belief: bool) -> dict:
        if not self.worker or not hasattr(self.worker, "determinize"):
            raise RuntimeError("策略网络要求 C++ worker 提供隐藏信息确定化接口")
        if hasattr(self, 'belief_policy'):
            return self.belief_policy.sample(self.worker, state, player_id, count, seed, belief)
        return self.worker.determinize(state=state, player_id=player_id, count=count,
                                       seed=seed, belief=belief)

    def decide(self, state: dict, player_id: str, available: dict | None = None,
               mcts: dict | None = None, *, diagnostics: dict | None = None) -> dict:
        if not self.worker or not self.model_path:
            raise RuntimeError(self.error or "策略网络未加载")
        if not isinstance(available, dict):
            raise RuntimeError("策略网络必须接收 C++ 游戏引擎生成的合法动作")
        # Human navigation remains available in the UI; a policy committing to
        # the Den must finish paying instead of reopening the same decision.
        candidates = [a for a in available.get("actions") or []
                      if not (a.get("type") == "district_effect" and a.get("name") == "thieves_cancel")]
        if not candidates:
            raise RuntimeError("当前局面没有可评估的合法行动")
        options = mcts or {}
        automatic = options.get("advancedEnabled", any(
            key in options for key in ("simulations", "maxDepth", "particles"))) is False
        time_budget_ms = max(1 if automatic else 0, int(options.get("timeBudgetMs", 10000 if automatic else 0)))
        # Do not estimate throughput: the native deadline ends automatic search.
        simulations = 2_147_483_647 if automatic else max(1, int(options.get("simulations", 5000)))
        max_depth = min(2000, max(64, time_budget_ms * 7 // 100)) if automatic else max(1, int(options.get("maxDepth", 2000)))
        particle_count = 4 if automatic else max(1, int(options.get("particles", 4)))
        if len(candidates) == 1:
            stats = {"automatic": automatic, "timeBudgetMs": time_budget_ms,
                     "simulations": simulations, "maxDepth": max_depth,
                     "determinizations": 0, "visits": 0, "expansions": 0, "forced": True}
            self._last_mcts = stats
            if diagnostics is not None:
                diagnostics.update({"method": "forced-action", "mcts": dict(stats)})
            return candidates[0]
        belief = options.get("belief", True) is not False
        decay = 0.5 if belief else 1.0
        rng = random.Random()
        started = time.perf_counter()
        progressive = options.get("progressiveParticles", True) is not False
        scorer = None
        mixture = 0.
        log_weights = None
        if progressive and hasattr(self, "belief_policy"):
            try:
                frozen = self.belief_policy.candidate_scorer(state, player_id, belief)
                if frozen is not None:
                    scorer, mixture = frozen
            except Exception as error:
                self.belief_policy.error = str(error)
        sample_seed = rng.randrange(0, 2**32)
        if scorer is not None:
            sampled = self.worker.determinize(state=state, player_id=player_id,
                count=particle_count, seed=sample_seed, belief=False)
            try:
                log_weights = scorer(sampled["particles"])
            except Exception as error:
                self.belief_policy.error = str(error)
                scorer = None; mixture = 0.
                sampled = self.worker.determinize(state=state, player_id=player_id,
                    count=particle_count, seed=sample_seed, belief=belief)
        else:
            # Progressive learned sampling uses the scorer above; unsupported
            # private phases keep the same native proposal for every batch.
            sampled = (self.worker.determinize(state=state, player_id=player_id,
                count=particle_count, seed=sample_seed, belief=belief) if progressive else
                self._root_particles(state, player_id, particle_count, sample_seed, belief))
        particles = sampled["particles"]
        if not particles:
            raise RuntimeError("无法为当前局面生成合法的隐藏信息确定化样本")
        weights = sampled["weights"]
        initial_sampling_ms = (time.perf_counter()-started)*1000
        remaining_ms = max(1, math.ceil(time_budget_ms-initial_sampling_ms)) if time_budget_ms else 0
        result = self.worker.search(
            state=particles[0], particles=particles[1:], root_player_id=player_id,
            legal_actions=candidates, particle_weights=weights,
            model_path=self.model_path, model_version=Path(self.model_path).stat().st_mtime_ns % 2_000_000_000,
            profile=self.profile, architecture=self.architecture, device=self.device_name,
            simulations=simulations, max_depth=max_depth, c_puct=float(options.get("cPuct", 1.0)),
            # Root noise is a self-play exploration mechanism; live play keeps a clean prior.
            dirichlet_alpha=0.3, dirichlet_epsilon=0.0,
            seed=rng.randrange(0, 2**32), batch_size=int(options.get("batchSize", 32)),
            action_encoding_version=self.action_version,
            time_budget_ms=remaining_ms, progressive_particles=progressive,
            root_belief=belief, root_log_weights=log_weights,
            root_prior_mixture=mixture, root_candidate_scorer=scorer,
            share_information_history=options.get("shareInformationHistory", True) is not False)
        policy = np.asarray(result["policy"], dtype=np.float64)
        if policy.size != len(candidates) or not np.isfinite(policy).all() or policy.sum() <= 0:
            raise RuntimeError("C++ MCTS 返回了无效策略分布")
        # Live play samples the clean visit distribution without adding root noise.
        selection = options.get("selection", "sample")
        selected = select_search_action(policy, rng, selection)
        mcts_stats = {"determinizations": result.get("particlesUsed", len(particles)),
                      "beliefDecay": decay, "visits": result.get("visits", 0),
                      "expansions": result.get("expansions", 0),
                      "simulations": simulations, "maxDepth": max_depth, "selection": selection,
                      "timeBudgetMs": time_budget_ms, "automatic": automatic}
        mcts_stats.update({"shareInformationHistory": options.get("shareInformationHistory", True) is not False,
            "progressiveParticles": progressive,
            "particleProposals": result.get("particleProposals", len(particles)),
            "particleDuplicates": result.get("particleDuplicates", 0),
            "particleRefreshes": result.get("particleRefreshes", 0),
            "particleEss": result.get("particleEss"),
            "particleLimit": result.get("particleLimit"),
            "particleSamplingMs": initial_sampling_ms + result.get("particleSamplingMs", 0),
            "particleSamplingError": result.get("particleSamplingError", ""),
            "totalMs": (time.perf_counter()-started)*1000})
        self._last_mcts = mcts_stats
        if diagnostics is not None:
            diagnostics.update({"method": "native-mcts", "profile": self.profile,
                                "architecture": self.architecture, "device": self.device_name,
                                "actionEncodingVersion": self.action_version,
                                "mcts": dict(mcts_stats)})
        return candidates[selected]
