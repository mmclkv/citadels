"""Persistent JSON-line bridge to the native LibTorch MCTS search worker."""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path


class NativeMctsWorker:
    def __init__(self, executable: str | Path):
        self.executable = Path(executable).resolve()
        if not self.executable.is_file():
            raise FileNotFoundError(f"找不到 C++ LibTorch MCTS worker：{self.executable}")
        import torch

        environment = os.environ.copy()
        torch_lib = str(Path(torch.__file__).resolve().parent / "lib")
        environment["PATH"] = torch_lib + os.pathsep + environment.get("PATH", "")
        if os.name != "nt":
            environment["LD_LIBRARY_PATH"] = (
                torch_lib + os.pathsep + environment.get("LD_LIBRARY_PATH", ""))
        self.process = subprocess.Popen(
            [str(self.executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=environment)
        self._lock = threading.Lock()
        self._request_id = 0

    def forward_probe(self, *, probes: list[dict],
                      model_path: str, profile: str, architecture: str, device: str,
                      action_encoding_version: int) -> dict:
        """Run deterministic raw-feature probes through one LibTorch model instance."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "forward_probe", "probes": probes,
                       "modelPath": model_path, "profile": profile,
                       "architecture": architecture, "device": device,
                       "actionEncodingVersion": int(action_encoding_version)}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ MCTS worker 未返回前向一致性检查结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ MCTS worker 前向检查返回了无效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ MCTS worker 前向检查响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("LibTorch 前向一致性检查失败：" + str(result.get("error", "未知错误")))
            if result.get("t") != "forward_probe_result":
                raise RuntimeError("C++ MCTS worker 前向检查响应类型不支持")
            return result

    def search(self, *, state: dict, particles: list[dict], root_player_id: str,
               legal_actions: list[dict], particle_weights: list[float],
               model_path: str, model_version: int, profile: str, architecture: str,
               device: str, simulations: int, max_depth: int, c_puct: float,
               dirichlet_alpha: float, dirichlet_epsilon: float, seed: int,
               batch_size: int = 32, action_encoding_version: int = 10,
               include_training_features: bool = False, policy_only: bool = False,
               include_root_diagnostics: bool = False) -> dict:
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {
                "id": request_id, "state": state, "particles": particles,
                "rootPlayerId": root_player_id, "legalActions": legal_actions,
                "particleWeights": particle_weights,
                "gpuEvaluator": True, "inferenceBackend": "libtorch",
                "architecture": architecture, "profile": profile, "device": device,
                "actionEncodingVersion": int(action_encoding_version), "modelPath": model_path,
                "modelVersion": int(model_version), "simulations": int(simulations),
                "maxDepth": int(max_depth), "cPuct": float(c_puct),
                "includeTrainingFeatures": bool(include_training_features),
                "policyOnly": bool(policy_only), "includeRootDiagnostics": bool(include_root_diagnostics),
                "dirichletAlpha": float(dirichlet_alpha),
                "dirichletEpsilon": float(dirichlet_epsilon),
                "seed": int(seed), "batchSize": int(batch_size),
            }
            assert self.process.stdin is not None and self.process.stdout is not None
            try:
                self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
                self.process.stdin.flush()
            except BrokenPipeError as error:
                try:
                    self.process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
                stderr = self.process.stderr.read()[-2000:] if self.process.stderr else ""
                raise RuntimeError(
                    "C++ MCTS worker 在接收搜索请求前退出 "
                    f"（exit={self.process.poll()}；stderr={stderr}）") from error
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ MCTS worker 未返回结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ MCTS worker 返回了无效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ MCTS worker 响应 ID 不匹配")
            if result.get("t") == "error":
                detail = str(result.get("error", "未知错误"))
                if "未知网络架构" in detail:
                    detail += "；当前 worker 二进制版本过旧，请用本仓库 native/mcts_worker.cpp 和当前 LibTorch 工具链重新编译"
                raise RuntimeError("C++ MCTS worker 错误：" + detail)
            if result.get("t") != "search_result":
                raise RuntimeError("C++ MCTS worker 响应类型不支持")
            self._validate_search_encoding(result, action_encoding_version)
            if policy_only and result.get("policyOnly") is not True:
                raise RuntimeError("C++ worker 不支持纯网络评测；请重新编译，不能把搜索结果当成网络输出")
            if include_root_diagnostics and ("networkPolicy" not in result or "networkValueVector" not in result):
                raise RuntimeError("C++ worker 不支持根节点诊断；请重新编译")
            if result.get("fallback"):
                native_types = ",".join(result.get("nativeActionTypes") or [])
                supplied_types = ",".join(result.get("suppliedActionTypes") or [])
                phase = state.get("phase", "?")
                turn = state.get("turn") or {}
                pending = (turn.get("pending") or {}).get("kind", "")
                role = turn.get("charId", "")
                native_details = json.dumps(result.get("nativeActionDetails") or [],
                                            ensure_ascii=False, separators=(",", ":"))
                supplied_details = json.dumps(result.get("suppliedActionDetails") or [],
                                              ensure_ascii=False, separators=(",", ":"))
                raise RuntimeError(
                    "C++ MCTS 内部合法动作与传入动作不一致 "
                    f"（index={result.get('mismatchIndex')}, "
                    f"native={result.get('nativeActionCount')}[{native_types}], "
                    f"supplied={len(legal_actions)}[{supplied_types}], "
                    f"phase={phase}, role={role}, pending={pending}, "
                    f"nativeDetails={native_details}, suppliedDetails={supplied_details}）")
            policy = result.get("policy")
            if not isinstance(policy, list) or len(policy) != len(legal_actions):
                raise RuntimeError("C++ MCTS 返回的策略长度与合法动作数不一致")
            return result

    @staticmethod
    def _validate_search_encoding(result: dict, requested: int) -> None:
        returned = result.get("actionEncodingVersion")
        supported = result.get("supportedActionEncodingVersion")
        # Legacy v9 workers did not echo their encoding; retain compatibility
        # only for v9 checkpoints, never silently feed v10 to an old encoder.
        if requested == 9 and returned is None:
            return
        if returned != requested or not isinstance(supported, int) or supported < requested:
            raise RuntimeError("C++ MCTS worker 动作编码版本不匹配；请重新编译 worker 后再启动新训练")

    def determinize(self, *, state: dict, player_id: str, count: int,
                    seed: int, belief: bool = True) -> dict:
        """Sample hidden-information worlds in C++ without invoking Python rules."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "determinize", "state": state,
                       "playerId": player_id, "count": int(count), "seed": int(seed),
                       "belief": bool(belief)}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ worker 确定化隐藏信息后未返回结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ worker 确定化响应不是有效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ worker determinize 响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ 隐藏信息确定化失败：" + str(result.get("error", "未知错误")))
            particles, weights = result.get("particles"), result.get("weights")
            if (result.get("t") != "determinize_result" or not isinstance(particles, list) or
                    not particles or not isinstance(weights, list) or len(particles) != len(weights)):
                raise RuntimeError("C++ worker 确定化响应字段无效")
            return result

    def close(self) -> None:
        process = self.process
        try:
            if process.poll() is None and process.stdin and process.stdout:
                with self._lock:
                    process.stdin.close()
            if process.poll() is None:
                process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
