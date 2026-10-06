"""Run the native tabular MCCFR trainer: python -m python_backend.train_cfr."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.cfr_runtime import ROOT, build_cfr_worker, rules_contract


def main() -> None:
    parser = argparse.ArgumentParser(description="C++ outcome-sampling MCCFR (no PyTorch/LibTorch)")
    parser.add_argument("--iterations", type=int, default=1000, help="Additional iterations; each updates all seats")
    parser.add_argument("--min-players", type=int, default=4)
    parser.add_argument("--max-players", type=int, default=8)
    parser.add_argument("--end-districts", type=int, default=8)
    parser.add_argument("--characters", choices=("base", "dark", "random"), default="random")
    parser.add_argument("--exploration", type=float, default=0.6)
    parser.add_argument("--max-steps", type=int, default=60000)
    parser.add_argument("--save-every", type=int, default=10)
    parser.add_argument("--seed", type=int, default=20260913)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "training-data/cfr/current.jsonl")
    args = parser.parse_args()
    if (not 1 <= args.iterations <= 0x7fffffff or not 2 <= args.min_players <= args.max_players <= 8 or
            not 1 <= args.end_districts <= 0x7fffffff or not 1 <= args.max_steps <= 0x7fffffff or
            not 1 <= args.save_every <= 0x7fffffff or
            not 0 < args.exploration <= 1 or not 0 <= args.seed <= 0x7fffffff):
        parser.error("Invalid player range, iterations, exploration, step limit, seed or save interval")
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    executable, environment = build_cfr_worker()
    # A training job must not preload the server's inference checkpoint.
    environment.pop("CITADELS_CFR_POLICY", None)
    request = {"mode": "train", "contract": rules_contract(), "iterations": args.iterations,
               "minPlayers": args.min_players, "maxPlayers": args.max_players,
               "endDistricts": args.end_districts, "charSetMode": args.characters,
               "exploration": args.exploration, "maxSteps": args.max_steps,
               "saveEvery": args.save_every, "seed": args.seed,
               "resume": str(args.resume.resolve()) if args.resume else "", "output": str(args.output),
               "catalog": json.loads((ROOT / "python_backend/catalog.json").read_text(encoding="utf-8"))}
    # C++ writes checkpoints by atomic replacement; interruption leaves the
    # previous complete checkpoint intact. stderr is inherited, never undrained.
    lock_path = args.output.with_suffix(args.output.suffix + ".lock")
    try:
        lock = lock_path.open("x", encoding="utf-8")
    except FileExistsError:
        raise RuntimeError(f"CFR 输出文件正在被其他任务使用：{lock_path}；若任务已异常退出，请确认后删除锁文件") from None
    try:
        _run(executable, environment, request)
    finally:
        lock.close()
        lock_path.unlink(missing_ok=True)
    print(f"CFR 策略已保存：{args.output}", flush=True)


def _run(executable, environment, request) -> None:
    with subprocess.Popen([str(executable)], cwd=ROOT, env=environment, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1) as process:
        try:
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":")) + "\n")
            process.stdin.close()
            completed = False
            for line in process.stdout:
                result = json.loads(line)
                if result.get("t") == "error":
                    raise RuntimeError(result.get("error", "CFR training failed"))
                if result.get("t") == "cfr_done": completed = True
                if result.get("t") == "cfr_progress":
                    print(f"迭代 {result['iterations']:,} | 完整采样 {result['episodes']:,} 局 | "
                          f"信息集 {result['informationSets']:,} | 未终局丢弃 {result['truncated']:,}", flush=True)
            if process.wait() or not completed:
                raise RuntimeError("CFR trainer exited without completing the task")
        except BaseException:
            process.terminate()
            process.wait(timeout=10)
            raise


if __name__ == "__main__":
    main()
