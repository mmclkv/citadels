"""Train independent best-response candidates and admit held-out improvements."""
from __future__ import annotations

import copy
import gzip
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .model_contract import MODEL_CONTRACTS


def discovery_due(games: int, last_search: int, config: dict) -> bool:
    interval = int(config["weaknessSearchEvery"])
    return (interval > 0 and config["historicalPoolSize"] > 0 and
            config["historicalOpponentProbability"] > 0 and
            games // interval > last_search // interval)


def evaluate_pairs(pairs: list[dict], expected: int) -> dict:
    complete = [pair for pair in pairs if pair["baseline"]["completed"] and pair["candidate"]["completed"]]
    improved = sum(bool(p["baseline"]["targetFirst"]) and not p["candidate"]["targetFirst"] for p in complete)
    worsened = sum(not p["baseline"]["targetFirst"] and bool(p["candidate"]["targetFirst"]) for p in complete)
    discordant = improved + worsened
    # Exact one-sided paired sign test (McNemar): each discordant result has
    # probability 1/2 under no directional improvement. No asymptotic shortcut.
    p_value = sum(math.comb(discordant, k) for k in range(improved, discordant + 1)) / 2 ** discordant if discordant else 1.0
    count = len(complete)
    baseline_own = sum(bool(p["baseline"]["challengerFirst"]) for p in complete)
    candidate_own = sum(bool(p["candidate"]["challengerFirst"]) for p in complete)
    accepted = (count == expected and count > 0 and improved > worsened and
                p_value <= 0.05 and candidate_own > baseline_own)
    return {"accepted": accepted, "completePairs": count, "expectedPairs": expected,
            "improvedPairs": improved, "worsenedPairs": worsened, "pValue": p_value,
            "baselineTargetFirstRate": sum(bool(p["baseline"]["targetFirst"]) for p in complete) / max(1, count),
            "candidateTargetFirstRate": sum(bool(p["candidate"]["targetFirst"]) for p in complete) / max(1, count),
            "baselineChallengerFirstRate": baseline_own / max(1, count),
            "candidateChallengerFirstRate": candidate_own / max(1, count)}


def train_response_policy(torch, trainer, model, optimizer, device, rows, training_data,
                          epochs, batch_size, stop_event):
    """On-policy clipped policy gradient for the challenger's own win-first return.

    Unlike main-model distillation, sampled actions here came directly from the
    candidate network, so stored behavior probabilities are valid PPO denominators.
    """
    data = training_data(torch, rows)
    actions = np.asarray([row["chosenAction"] for row in rows], dtype=np.int64)
    old_probs = np.asarray([row["behaviorProbability"] for row in rows], dtype=np.float32)
    advantages = np.zeros(len(rows), dtype=np.float32)
    model.eval()  # Preserve the behavior policy's inference mode while differentiating.
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            indices = np.arange(start, min(len(rows), start + batch_size))
            batch = trainer.build_minibatch(data, indices, device)
            _, values = model(batch["states"], batch["actions"], batch["masks"])
            advantages[indices] = (batch["rewards"][:, 0] - values[:, 0]).cpu().numpy()
    updates = 0
    for _ in range(epochs):
        for indices in torch.randperm(len(rows)).split(batch_size):
            if stop_event.is_set():
                return updates
            ids = indices.numpy()
            batch = trainer.build_minibatch(data, ids, device)
            logits, values = model(batch["states"], batch["actions"], batch["masks"])
            probabilities = torch.softmax(logits, dim=-1)
            chosen = torch.as_tensor(actions[ids], device=device)
            selected = probabilities.gather(1, chosen[:, None]).squeeze(1)
            old = torch.as_tensor(old_probs[ids], device=device).clamp_min(1e-12)
            ratio = selected / old
            advantage = torch.as_tensor(advantages[ids], device=device)
            valid = batch["masks"].sum(dim=1) > 1
            count = valid.sum().clamp_min(1)
            objective = torch.minimum(ratio * advantage, ratio.clamp(0.8, 1.2) * advantage)
            policy_loss = -(objective * valid).sum() / count
            entropy = -(probabilities * probabilities.clamp_min(1e-12).log()).sum(dim=1)
            entropy = (entropy * valid).sum() / count
            value_loss = (((values - batch["rewards"]) ** 2 * batch["value_masks"]).sum(dim=1) /
                          batch["value_masks"].sum(dim=1).clamp_min(1)).mean()
            loss = policy_loss + 0.5 * value_loss - 0.01 * entropy
            if not torch.isfinite(loss):
                raise RuntimeError("针对性对手训练产生非有限损失")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            if not torch.isfinite(norm):
                raise RuntimeError("针对性对手训练产生非有限梯度")
            optimizer.step()
            updates += 1
    return updates


class WeaknessSearch:
    def __init__(self, torch, trainer, device, config, data_dir, runtime_dir,
                 sample_game, training_data, stop_event, log, progress=lambda state: None):
        self.torch, self.trainer, self.device = torch, trainer, device
        self.config = config
        self.data_dir, self.directory = Path(data_dir), Path(runtime_dir) / "weakness"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.sample_game, self.training_data = sample_game, training_data
        self.stop, self.log, self.progress = stop_event, log, progress

    def _case(self, index, seed, target, backgrounds, evaluation):
        config = {**self.config, "seed": seed, "selfPlayMode": "all-network"}
        counts = list(range(int(config["minPlayers"]), int(config["maxPlayers"]) + 1))
        count = counts[index % len(counts)]
        cycle = index // len(counts)
        learner = (cycle + seed) % count
        target_seat = (learner + 1 + (cycle // count + seed // count) % (count - 1)) % count
        config["weaknessRun"] = {"playerCount": count, "learnerSeat": learner,
                                 "targetSeat": target_seat, "crownSeat": (cycle // count + seed // 17) % count,
                                 "targetPolicy": target, "backgroundPolicies": backgrounds,
                                 "evaluation": evaluation, "directTraining": not evaluation}
        return config

    def run(self, incumbent, main_games, backgrounds):
        seed = (int(self.config["seed"]) ^ (main_games * 0x85EBCA6B)) & 0xFFFFFFFF
        count = int(self.config["weaknessTrainingGames"])
        expected = int(self.config["weaknessEvaluationPairs"])
        directory = self.directory / f"cycle-{main_games}"
        directory.mkdir(exist_ok=True)
        target_path = directory / "target.bin"
        baseline_path, candidate_path = directory / "baseline.bin", directory / "candidate.bin"
        incumbent.save_flat(str(target_path))
        contract = MODEL_CONTRACTS[self.config["networkArchitecture"]]
        target = {"modelPath": str(target_path), "modelVersion": main_games,
                  "checkpoint": f"frozen-main-{main_games}", "actionEncodingVersion": contract["action"]}
        report = {"mainGames": main_games, "seed": seed, "accepted": False,
                  "trainingGames": 0, "trainingCompletedGames": 0, "updates": 0, "pairs": []}
        self.log(f"寻找弱点：冻结主模型第 {main_games} 局版本；训练 {count} 局，验证 {expected} 对")
        devices = [self.device.index if self.device.index is not None else self.torch.cuda.current_device()] if self.device.type == "cuda" else []
        with self.torch.random.fork_rng(devices=devices):
            self.torch.random.default_generator.manual_seed(seed)
            for device_index in devices:
                self.torch.cuda.default_generators[device_index].manual_seed(seed)
            candidate = copy.deepcopy(incumbent)
            candidate.save_flat(str(baseline_path))
            optimizer = self.torch.optim.Adam(candidate.parameters(), lr=self.config["learningRate"])
            for start in range(0, count, int(self.config["batchGames"])):
                if self.stop.is_set():
                    break
                candidate.save_flat(str(candidate_path))
                rows = []
                for index in range(start, min(count, start + int(self.config["batchGames"]))):
                    config = self._case(index, seed, target, backgrounds, False)
                    config["nativeModelPath"] = str(candidate_path)
                    result = self.sample_game(config, index + 1, self.stop)
                    if result is None:
                        break
                    report["trainingGames"] += 1
                    if result["completed"]:
                        report["trainingCompletedGames"] += 1
                        rows.extend(result["rows"])
                    self.progress({"phase": "training", "mainGames": main_games,
                                   "games": report["trainingGames"], "total": count})
                if rows and not self.stop.is_set():
                    report["updates"] += train_response_policy(
                        self.torch, self.trainer, candidate, optimizer, self.device, rows,
                        self.training_data, int(self.config["trainingEpochs"]),
                        int(self.config["miniBatch"]), self.stop)
            candidate.save_flat(str(candidate_path))
            # Disjoint seed stream and no training updates during held-out evaluation.
            evaluation_seed = seed ^ 0xD1B54A35
            if report["updates"] and not self.stop.is_set():
                for index in range(expected):
                    pair = {}
                    for name, path in (("baseline", baseline_path), ("candidate", candidate_path)):
                        config = self._case(index, evaluation_seed, target, backgrounds, True)
                        config["nativeModelPath"] = str(path)
                        result = self.sample_game(config, index + 1, self.stop)
                        if result is None:
                            break
                        pair[name] = {key: result[key] for key in
                                      ("completed", "playerCount", "targetFirst", "challengerFirst")}
                    if len(pair) != 2:
                        break
                    case = config["weaknessRun"]
                    pair["case"] = {"gameNumber": index + 1, "seed": evaluation_seed,
                                    **{key: case[key] for key in
                                       ("playerCount", "learnerSeat", "targetSeat", "crownSeat")}}
                    report["pairs"].append(pair)
                    self.progress({"phase": "evaluating", "mainGames": main_games,
                                   "games": len(report["pairs"]), "total": expected})
            report.update(evaluate_pairs(report["pairs"], expected))
            report["cancelled"] = self.stop.is_set()
            if report["cancelled"]:
                report["accepted"] = False
            if report["accepted"]:
                self.data_dir.mkdir(parents=True, exist_ok=True)
                name = f"checkpoint-{main_games:06d}-opponent-{seed}.json.gz"
                weights = np.fromfile(candidate_path, dtype="<f4")
                payload = {"createdAt": datetime.now(timezone.utc).isoformat(), "game": main_games,
                           "config": {key: value for key, value in self.config.items()
                                      if key not in ("nativeModelPath", "historicalPoolManifest", "weaknessRun")},
                           "encoding": {"state": contract["state"], "action": contract["action"]},
                           "model": {"version": 1, "architecture": "entity-v6", "profile": self.config["profile"],
                                     "stateSize": contract["stateSize"], "actionSize": contract["actionSize"],
                                     "valueObjective": "win-first-v1", "encodingVersion": contract["state"],
                                     "parameterCount": int(weights.size), "flat": weights.tolist()},
                           "weaknessSearch": report}
                pending = self.data_dir / (name + ".tmp")
                pending.write_bytes(gzip.compress(json.dumps(payload, ensure_ascii=False).encode()))
                os.replace(pending, self.data_dir / name)
                report["checkpoint"] = name
        reports = self.data_dir / "weakness-search"
        reports.mkdir(parents=True, exist_ok=True)
        report_path = reports / f"report-{main_games}-{seed}.json"
        pending = report_path.with_suffix(".tmp")
        pending.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(pending, report_path)
        self.progress({"phase": "cancelled" if report["cancelled"] else "completed", **report})
        self.log(f"弱点验证：{report['completePairs']}/{expected} 对；p={report['pValue']:.4f}；" +
                 ("通过，加入对手池" if report["accepted"] else "未通过，不入池"))
        for path in (target_path, baseline_path, candidate_path):
            path.unlink(missing_ok=True)
        directory.rmdir()
        return report
