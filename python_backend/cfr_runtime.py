"""Build/configuration helpers only; CFR math and game simulation live in C++."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def rules_contract() -> str:
    # Content-based, so checkpoints move between Linux/Windows checkouts.
    digest = hashlib.sha256(b"citadels-mccfr-v2:abstract:baseline:tremble:competition-rank:latent-seed")
    for path in sorted([*(ROOT / "native").glob("*.hpp"), ROOT / "native/cfr_worker.cpp",
                        ROOT / "native/game_engine_worker.cpp"]):
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
    catalog = json.loads((ROOT / "python_backend/catalog.json").read_text(encoding="utf-8"))
    digest.update(json.dumps(catalog, sort_keys=True, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8"))
    return digest.hexdigest()


def build_cfr_worker(log=print):
    from .native_worker_manager import NativeWorkerManager
    manager = NativeWorkerManager(log=log)
    compiler, environment, devcmd = manager._compiler_environment()
    executable = manager._build_game_engine(compiler, environment, devcmd,
                                            source_name="cfr_worker.cpp", stem="cfr_worker")
    return executable, environment
