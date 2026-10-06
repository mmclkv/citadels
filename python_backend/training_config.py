"""Training configuration normalization shared by the Python runtime/API."""

from __future__ import annotations

import math
import os
from pathlib import Path

PROFILES = {"fast", "balanced", "large"}
ARCHITECTURES = {"entity-v6"}


def _number(value, fallback=0.0) -> float:
    if value is None:
        return fallback
    try:
        if isinstance(value, str) and not value.strip():
            return 0.0
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def _clamp_or(value, low, high, fallback):
    number = _number(value)
    if not number:
        number = fallback
    return max(low, min(high, number))


def _clamp_integer(value, low: int, high: int, fallback: int) -> int | float:
    number = _number(value, math.nan)
    if not math.isfinite(number):
        return fallback
    # Match JS Math.round (rather than Python's ties-to-even round).
    return max(low, min(high, math.floor(number + 0.5)))


def sanitize_config(raw: dict | None = None) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    requested_architecture = raw.get("networkArchitecture")
    if requested_architecture not in (None, "", "entity-v6"):
        raise ValueError(f"仅支持 entity-v6 网络架构，当前配置为：{requested_architecture}")
    min_players = _clamp_or(raw.get("minPlayers"), 2, 8, 4)
    max_players = max(min_players, _clamp_or(raw.get("maxPlayers"), min_players, 8, min_players))
    cpu_count = os.cpu_count() or 1
    default_workers = max(1, cpu_count - 2)
    seed = math.floor(_number(raw.get("seed")) or 20260913)
    resume = Path(str(raw.get("resumeCheckpoint") or "").replace("\\", "/")).name
    def finite_clamp(key, low, high, fallback):
        if key not in raw:
            return fallback
        value = 0 if raw[key] is None else _number(raw[key], math.nan)
        return max(low, min(high, value)) if math.isfinite(value) else fallback

    def finite_integer(key, low, high, fallback):
        if key not in raw:
            return fallback
        return _clamp_integer(0 if raw[key] is None else raw[key], low, high, fallback)

    return {
        "targetGames": _clamp_or(raw.get("targetGames"), 1, math.inf, 10_000),
        "minPlayers": min_players, "maxPlayers": max_players,
        "charSet": raw.get("charSet") if raw.get("charSet") in ("base", "dark", "mixed", "random") else "random",
        "endDistricts": int(_number(raw.get("endDistricts"))) if _number(raw.get("endDistricts")) in (7, 8) else 8,
        "profile": raw.get("profile") if raw.get("profile") in PROFILES else "balanced",
        "networkArchitecture": "entity-v6",
        "rulesEngine": "cpp", "mctsEngine": "cpp",
        "neuralNetworkFramework": "libtorch", "backend": "python",
        "device": raw.get("device") if raw.get("device") in ("cuda", "cpu") else ("cpu" if raw.get("backend") == "cpu" else "cuda"),
        "learningRate": _clamp_or(raw.get("learningRate"), 1e-6, math.inf, 0.0003),
        "batchGames": _clamp_or(raw.get("batchGames"), 1, math.inf, 4),
        "trainingEpochs": _clamp_or(raw.get("trainingEpochs"), 1, math.inf, 2),
        "miniBatch": _clamp_or(raw.get("miniBatch"), 32, math.inf, 256),
        "replayBufferGames": finite_integer("replayBufferGames", 0, math.inf, 128),
        "workers": _clamp_or(raw.get("workers"), 1, math.inf, default_workers),
        "checkpointEvery": _clamp_or(raw.get("checkpointEvery"), 1, math.inf, 100),
        "seed": seed,
        "maxSteps": _clamp_or(raw.get("maxSteps"), 1000, math.inf, 60000),
        "maxRounds": _clamp_or(raw.get("maxRounds"), 1, math.inf, 100),
        "temperatureStart": _clamp_or(raw.get("temperatureStart"), 0.2, math.inf, 1.1),
        "temperatureEnd": _clamp_or(raw.get("temperatureEnd"), 0.15, math.inf, 0.65),
        "resumeCheckpoint": resume,
        "mctsSimulations": _clamp_or(raw.get("mctsSimulations"), 1, math.inf, 500),
        "mctsC_puct": _clamp_or(raw.get("mctsC_puct"), 0, math.inf, 1.0),
        "mctsDirichletAlpha": finite_clamp("mctsDirichletAlpha", 0, 1, 0.3),
        "mctsDirichletEpsilon": finite_clamp("mctsDirichletEpsilon", 0, 1, 0.03),
        "mctsMaxDepth": _clamp_or(raw.get("mctsMaxDepth"), 10, math.inf, 700),
        "mctsBatchSize": finite_integer("mctsBatchSize", 1, math.inf, 32),
        "mctsParticles": finite_integer("mctsParticles", 1, math.inf, 4),
        "mctsBelief": raw.get("mctsBelief") is not False,
        "selfPlayMode": ("network-vs-cfr" if raw.get("selfPlayMode") == "network-vs-heuristic" else
                         raw.get("selfPlayMode") if raw.get("selfPlayMode") in ("all-network", "network-vs-cfr", "curriculum") else "all-network"),
        "networkPlayerCount": finite_integer("networkPlayerCount", 0, max_players, 0),
        "curriculumStartPlayers": finite_integer("curriculumStartPlayers", 1, max_players, 1),
        "curriculumEndPlayers": finite_integer("curriculumEndPlayers", 0, max_players, 0),
        "curriculumStepGames": finite_integer("curriculumStepGames", 1, math.inf, 1000),
    }
