"""Persistent IPC client for the authoritative, state-owning C++ game engine."""

from __future__ import annotations

import json
import subprocess
import threading
import uuid
from pathlib import Path


class GameEngineWorker:
    def __init__(self, executable: str | Path, *, env: dict[str, str] | None = None):
        self.executable = Path(executable).resolve()
        self.process = subprocess.Popen(
            [str(self.executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=env)
        self._lock = threading.RLock()
        self._request_id = 0

    def _request(self, mode: str, **fields):
        with self._lock:
            if self.process.poll() is not None:
                raise RuntimeError(f"C++ 游戏主进程已退出（exit={self.process.returncode}）")
            self._request_id += 1
            request_id = str(self._request_id)
            request = {"id": request_id, "mode": mode, **fields}
            assert self.process.stdin is not None and self.process.stdout is not None
            self.process.stdin.write(json.dumps(request, ensure_ascii=False,
                                                separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("C++ 游戏主进程未返回响应")
            try:
                result = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError("C++ 游戏主进程返回了无效 JSON") from error
            if result.get("id") != request_id:
                raise RuntimeError("C++ 游戏主进程响应 ID 不匹配")
            if result.get("t") == "error":
                raise RuntimeError("C++ 游戏主进程拒绝请求：" + str(result.get("error", "未知错误")))
            return result

    def create_game(self, new_game: dict, game_id: str | None = None) -> dict:
        game_id = game_id or uuid.uuid4().hex
        result = self._request("create", gameId=game_id, newGame=new_game)
        return result["state"]

    def snapshot(self, game_id: str) -> dict:
        return self._request("snapshot", gameId=game_id)["state"]

    def current(self, game_id: str, *, include_rewards: bool = False) -> dict:
        return self._request("current", gameId=game_id, includeRewards=include_rewards)

    def decision(self, game_id: str) -> dict:
        return self._request("decision", gameId=game_id)

    def advance_npcs(self, *, game_id: str, network_player_ids: list[str],
                     seed: int, max_steps: int, max_rounds: int) -> dict:
        return self._request("advance_npcs", gameId=game_id,
                             networkPlayerIds=network_player_ids, seed=int(seed),
                             maxSteps=int(max_steps), maxRounds=int(max_rounds),
                             includeTrainingFeatures=True)

    def legal_actions(self, *, game_id: str, player_id: str) -> dict:
        return self._request("actions", gameId=game_id, playerId=player_id)

    def decide_npc(self, *, game_id: str, player_id: str, seed: int = 1,
                   heuristic_mcts: dict | None = None):
        return self._request("npc", gameId=game_id, playerId=player_id,
                             seed=int(seed), heuristicMcts=heuristic_mcts or {}).get("action")

    def apply(self, *, game_id: str, player_id: str, action: dict,
              return_state: bool = True) -> dict:
        result = self._request("apply", gameId=game_id, playerId=player_id,
                               action=action, returnState=return_state)
        return result.get("state") if return_state else result

    def close_game(self, game_id: str) -> None:
        self._request("close", gameId=game_id)

    def close(self) -> None:
        process = self.process
        try:
            if process.poll() is None and process.stdin:
                process.stdin.close()
            process.wait(timeout=4)
        except (OSError, subprocess.TimeoutExpired):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
