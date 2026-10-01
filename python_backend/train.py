"""Run one Python self-play training job from a JSON config file."""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python_backend.training_runtime import TrainingManager  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Citadels Python self-play trainer")
    parser.add_argument("config", nargs="?", type=Path,
                        default=ROOT / "training" / "gpu-train-config.json",
                        help="训练 JSON 配置（默认 training/gpu-train-config.json）")
    parser.add_argument("--data-dir", type=Path, default=ROOT / "training-data",
                        help="checkpoint 输出目录（默认 training-data）")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError("配置根节点必须是 JSON 对象")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"[train] 无法读取配置 {args.config}: {exc}", file=sys.stderr, flush=True)
        return 2

    manager = TrainingManager(args.data_dir)

    def request_stop(_signum, _frame):
        print("[train] 收到停止信号，正在保存并停止……", flush=True)
        manager.stop()

    signal.signal(signal.SIGINT, request_stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, request_stop)
    try:
        manager.start(config)
    except (ValueError, RuntimeError) as exc:
        print(f"[train] 启动失败: {exc}", file=sys.stderr, flush=True)
        return 2

    last_seq = 0
    while True:
        status = manager.status()
        for entry in status.get("logs", []):
            if entry["seq"] > last_seq:
                print(entry["text"], flush=True)
                last_seq = entry["seq"]
        if not status["running"]:
            if status["state"] == "completed":
                print(f"[train] 完成：{status['completedGames']} 局；checkpoint={status['checkpoint']}",
                      flush=True)
                return 0
            if status["state"] == "stopped":
                print(f"[train] 已停止：{status['completedGames']} 局；checkpoint={status['checkpoint']}",
                      flush=True)
                return 130
            print(f"[train] 失败：{status.get('error') or status['state']}", file=sys.stderr, flush=True)
            return 1
        time.sleep(0.25)


if __name__ == "__main__":
    raise SystemExit(main())
