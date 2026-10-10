"""Bounded, immutable inference snapshots shared by self-play samplers."""
from __future__ import annotations

import gzip
import json
import os
import re
from pathlib import Path

import numpy as np

from .model_contract import MODEL_CONTRACTS, validate_checkpoint_contract


class HistoricalPolicyPool:
    def __init__(self, checkpoint_dir: Path, runtime_dir: Path, capacity: int,
                 profile: str, parameter_count: int, log=lambda message: None):
        self.checkpoint_dir = Path(checkpoint_dir)
        self.directory = Path(runtime_dir) / "historical"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.manifest = self.directory / "pool.json"
        self.capacity = max(0, int(capacity))
        self.profile = profile
        self.parameter_count = parameter_count
        self.log = log
        self.entries: dict[str, dict] = {}
        self.rejected: set[str] = set()
        self.revision = 0
        self.published = False

    def _load(self, path: Path) -> dict:
        with gzip.open(path, "rb") as handle:
            raw = handle.read(512 * 1024 * 1024 + 1)
        if len(raw) > 512 * 1024 * 1024:
            raise ValueError("解压后超过 512 MB")
        checkpoint = json.loads(raw)
        if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("model"), dict):
            raise ValueError("存档格式无效")
        if not isinstance(checkpoint.get("encoding", {}), dict):
            raise ValueError("编码格式无效")
        metadata = checkpoint.get("model") or {}
        contract = validate_checkpoint_contract(checkpoint, "entity-v6")
        if contract != MODEL_CONTRACTS["entity-v6"]:
            raise ValueError("旧建筑编码需先迁移，不能加入新编码训练的历史池")
        if metadata.get("profile") != self.profile:
            raise ValueError("网络规模不匹配")
        if metadata.get("valueObjective") != "win-first-v1":
            raise ValueError("价值目标不是争第一")
        specialist = "-opponent-" in path.name
        admission = checkpoint.get("weaknessSearch")
        if specialist and (not isinstance(admission, dict) or admission.get("accepted") is not True):
            raise ValueError("针对性对手未通过入池验证")
        values = np.asarray(metadata.get("flat") or [], dtype="<f4")
        if (values.ndim != 1 or values.size != self.parameter_count or
                metadata.get("parameterCount") != self.parameter_count or
                not np.isfinite(values).all()):
            raise ValueError("权重数量或数值无效")
        self.revision += 1
        target = self.directory / f"policy-{self.revision}.bin"
        values.tofile(target)
        return {"checkpoint": path.name, "modelPath": str(target),
                "modelVersion": self.revision, "actionEncodingVersion": contract["action"],
                "kind": "weakness-opponent" if specialist else "historical"}

    def refresh(self) -> list[dict]:
        paths = [path for path in self.checkpoint_dir.glob("checkpoint-*.json.gz")
                 if re.fullmatch(r"checkpoint-[\w-]+\.json\.gz", path.name)]
        paths.sort(key=lambda path: (path.stat().st_mtime_ns, path.name))
        # Half recent snapshots, half spaced across the older history. Invalid
        # selections are backfilled, so incompatible imports cannot crowd out peers.
        specialists = [path for path in paths if "-opponent-" in path.name]
        ordinary = [path for path in paths if "-opponent-" not in path.name]
        reserved = min(len(specialists), max(1, self.capacity // 4), self.capacity)
        history_capacity = self.capacity - reserved
        recent = (history_capacity + 1) // 2
        older = ordinary[:-recent] if recent else ordinary
        archive = history_capacity - recent
        spaced = ([older[int(index)] for index in np.linspace(0, len(older) - 1,
                                                            min(archive, len(older)))]
                  if archive and older else [])
        preferred = list(reversed(specialists)) if reserved else []
        preferred += list(reversed(ordinary[-recent:])) if recent else []
        preferred += spaced + list(reversed(ordinary))
        selected = {}
        admitted_specialists = 0
        for path in preferred:
            if len(selected) >= self.capacity:
                break
            if path.name in selected or path.name in self.rejected:
                continue
            if "-opponent-" in path.name and admitted_specialists >= reserved:
                continue
            try:
                selected[path.name] = self.entries.get(path.name) or self._load(path)
                admitted_specialists += int(selected[path.name]["kind"] == "weakness-opponent")
            except (OSError, ValueError, TypeError, KeyError, OverflowError) as exc:
                self.rejected.add(path.name)
                self.log(f"历史池跳过 {path.name}：{exc}")
        entries = list(selected.values())
        pending = self.manifest.with_suffix(".tmp")
        pending.write_text(json.dumps({"policies": entries}), encoding="utf-8")
        os.replace(pending, self.manifest)
        # refresh runs between batches; no sampler still uses evicted snapshots.
        for name, entry in self.entries.items():
            if name not in selected:
                Path(entry["modelPath"]).unlink(missing_ok=True)
        if not self.published or list(selected) != list(self.entries):
            self.log(f"历史策略池：{len(entries)}/{self.capacity} 个版本；" +
                     ("、".join(selected) or "暂无兼容存档，使用当前模型"))
        self.entries = selected
        self.published = True
        return entries


def assign_seat_policies(config: dict, network_seats: set[int], learner_seat: int,
                         rng) -> dict[int, dict]:
    """Keep one rotating learner; sample and freeze other seats for the whole game."""
    current = {"modelPath": str(config["nativeModelPath"]),
               "modelVersion": Path(config["nativeModelPath"]).stat().st_mtime_ns % 2_000_000_000,
               "actionEncodingVersion": MODEL_CONTRACTS[config["networkArchitecture"]]["action"],
               "checkpoint": "", "historical": False}
    policies = []
    probability = config.get("historicalOpponentProbability", 0.5)
    if config.get("historicalPoolSize", 8) and probability > 0 and config.get("historicalPoolManifest"):
        policies = json.loads(Path(config["historicalPoolManifest"]).read_text(encoding="utf-8"))["policies"]
    discovery = config.get("weaknessRun")
    if discovery:
        target = discovery["targetSeat"]
        policies = discovery["backgroundPolicies"]
        result = {}
        for seat in sorted(network_seats):
            if seat == learner_seat:
                result[seat] = dict(current)
            elif seat == target:
                result[seat] = {**discovery["targetPolicy"], "historical": True}
            elif policies and rng.random() < 0.5:
                result[seat] = {**policies[int(rng.integers(len(policies)))], "historical": True}
            else:
                result[seat] = {**discovery["targetPolicy"], "historical": True}
        return result
    result = {}
    composition = config.get("batchComposition")
    if composition:
        others = sorted(network_seats - {learner_seat})
        amount = min(int(composition["historical"]), len(others)) if policies else 0
        history_seats = set(rng.choice(others, size=amount, replace=False)) if amount else set()
        for seat in sorted(network_seats):
            result[seat] = ({**policies[int(rng.integers(len(policies)))], "historical": True}
                            if seat in history_seats else dict(current))
        return result
    for seat in sorted(network_seats):
        if policies and seat != learner_seat and rng.random() < probability:
            result[seat] = {**policies[int(rng.integers(len(policies)))], "historical": True}
        else:
            result[seat] = dict(current)
    return result
