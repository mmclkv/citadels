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
        self.process = subprocess.Popen(
            [str(self.executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=environment)
        self._lock = threading.Lock()
        self._request_id = 0

    def search(self, *, state: dict, particles: list[dict], root_player_id: str,
               legal_actions: list[dict], particle_weights: list[float],
               model_path: str, model_version: int, profile: str, architecture: str,
               device: str, simulations: int, max_depth: int, c_puct: float,
               dirichlet_alpha: float, dirichlet_epsilon: float, seed: int,
               batch_size: int = 32, action_encoding_version: int = 8,
               include_training_features: bool = False) -> dict:
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
            if result.get("fallback"):
                native_types = ",".join(result.get("nativeActionTypes") or [])
                supplied_types = ",".join(result.get("suppliedActionTypes") or [])
                phase = state.get("phase", "?")
                turn = state.get("turn") or {}
                pending = (turn.get("pending") or {}).get("kind", "")
                role = turn.get("charId", "")
                raise RuntimeError(
                    "C++ MCTS 内部合法动作与传入动作不一致 "
                    f"（index={result.get('mismatchIndex')}, "
                    f"native={result.get('nativeActionCount')}[{native_types}], "
                    f"supplied={len(legal_actions)}[{supplied_types}], "
                    f"phase={phase}, role={role}, pending={pending}）")
            policy = result.get("policy")
            if not isinstance(policy, list) or len(policy) != len(legal_actions):
                raise RuntimeError("C++ MCTS 返回的策略长度与合法动作数不一致")
            return result

    def apply(self, *, state: dict, player_id: str, action: dict) -> dict:
        """Apply one authoritative game action in the native C++ rules engine."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "apply", "state": state,
                       "playerId": player_id, "action": action}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ worker 执行动作后未返回状态")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ worker 返回了无效状态 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ worker apply 响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ 游戏引擎拒绝行动：" + str(result.get("error", "未知错误")))
            if result.get("t") != "apply_result" or not isinstance(result.get("state"), dict):
                raise RuntimeError("C++ worker 未返回 apply_result 状态")
            return result["state"]

    def create_game(self, new_game: dict) -> dict:
        """Create and deal a live game through the native C++ game engine."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "create", "newGame": new_game}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ worker 创建游戏后未返回状态")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ worker 返回了无效开局状态") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ worker create 响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ 游戏引擎创建开局失败：" + str(result.get("error", "未知错误")))
            if result.get("t") != "create_result" or not isinstance(result.get("state"), dict):
                raise RuntimeError("C++ worker 未返回 create_result 状态")
            return result["state"]

    def legal_actions(self, *, state: dict, player_id: str) -> dict:
        """Get available actions from the authoritative native game rules."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "actions", "state": state,
                       "playerId": player_id}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ worker 查询合法动作后未返回结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ worker 合法动作响应不是有效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ worker legal_actions 响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ 游戏引擎查询合法动作失败：" + str(result.get("error", "未知错误")))
            if result.get("t") != "legal_actions_result" or not isinstance(result.get("actions"), list):
                raise RuntimeError("C++ worker 未返回 legal_actions_result")
            return result

    def decide_npc(self, *, state: dict, player_id: str, seed: int = 1) -> dict | None:
        """Select an action in C++ using the native rules' canonical legal list."""
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": "npc", "state": state,
                       "playerId": player_id, "seed": int(seed)}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ worker NPC 决策后未返回结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ worker NPC 决策响应不是有效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ worker NPC 响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ NPC 决策失败：" + str(result.get("error", "未知错误")))
            if result.get("t") != "npc_result":
                raise RuntimeError("C++ worker 未返回 npc_result")
            action = result.get("action")
            if action is not None and not isinstance(action, dict):
                raise RuntimeError("C++ worker NPC 动作格式无效")
            return action

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

    def selfplay(self, *, network_player_ids: list[str], model_path: str,
                 model_version: int, profile: str, architecture: str, device: str,
                 simulations: int, max_depth: int, c_puct: float,
                 dirichlet_alpha: float, dirichlet_epsilon: float, seed: int,
                 batch_size: int = 32, max_rounds: int = 1000,
                 max_steps: int = 60000, action_encoding_version: int = 8,
                 particles: int = 4,
                 belief: bool = True,
                 state: dict | None = None, new_game: dict | None = None) -> dict:
        """Run one complete game with C++ rules/search and return trainer rows."""
        if (state is None) == (new_game is None):
            raise ValueError("C++ 自对弈必须且只能指定 state 或 new_game")
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ MCTS worker 已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {
                "id": request_id, "mode": "selfplay",
                "networkPlayerIds": network_player_ids,
                "gpuEvaluator": True, "inferenceBackend": "libtorch",
                "architecture": architecture, "profile": profile, "device": device,
                "actionEncodingVersion": int(action_encoding_version), "modelPath": model_path,
                "modelVersion": int(model_version), "simulations": int(simulations),
                "maxDepth": int(max_depth), "cPuct": float(c_puct),
                "dirichletAlpha": float(dirichlet_alpha),
                "dirichletEpsilon": float(dirichlet_epsilon),
                "seed": int(seed), "batchSize": int(batch_size),
                "particles": int(particles),
                "belief": bool(belief),
                "maxRounds": int(max_rounds), "maxSteps": int(max_steps),
            }
            if state is not None:
                request["state"] = state
            else:
                request["newGame"] = new_game
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
                    "C++ MCTS worker 在接收自对弈请求前退出 "
                    f"（exit={self.process.poll()}；stderr={stderr}）") from error
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ MCTS worker 未返回自对弈结果")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ MCTS worker 自对弈结果不是有效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ MCTS worker 自对弈响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ MCTS worker 自对弈错误：" + str(result.get("error", "未知错误")))
            if result.get("t") != "selfplay_result":
                raise RuntimeError("C++ MCTS worker 响应类型不是 selfplay_result")
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
