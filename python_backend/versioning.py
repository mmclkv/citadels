"""Release identity: development branches never implicitly become production."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")


def git(root: Path, *args: str, timeout: float = 10) -> str:
    return subprocess.check_output(
        ["git", "-C", str(root), *args], text=True, encoding="utf-8",
        stderr=subprocess.PIPE, timeout=timeout).strip()


def validate_version(value: str) -> str:
    if not VERSION_PATTERN.fullmatch(value):
        raise ValueError("版本号必须为 X.Y.Z，例如 0.1.0（不带 v）")
    return value


def release_commit(root: Path, tag: str) -> str:
    """Only annotated, correctly versioned release tags may be deployed."""
    version = validate_version(tag.removeprefix("v"))
    if tag != "v" + version:
        raise ValueError("稳定版必须使用 vX.Y.Z 标签")
    ref = "refs/tags/" + tag
    if git(root, "cat-file", "-t", ref) != "tag":
        raise ValueError("稳定版必须是附注标签，不能是分支或轻量标签")
    commit = git(root, "rev-parse", ref + "^{commit}")
    if git(root, "show", commit + ":VERSION") != version:
        raise ValueError("标签版本与提交中的 VERSION 不一致")
    return commit


def version_info(root: Path = ROOT) -> dict:
    base = validate_version((root / "VERSION").read_text(encoding="utf-8").strip())
    commit = None
    dirty = False
    stable = False
    tag = None
    try:
        # Do not mistake an enclosing checkout for this application repository.
        if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root.resolve():
            raise ValueError("不是独立仓库")
        commit = git(root, "rev-parse", "HEAD")
        dirty = bool(git(root, "status", "--porcelain", "--untracked-files=no"))
        branch = git(root, "rev-parse", "--abbrev-ref", "HEAD")
        candidate = "v" + base
        if branch == "HEAD" and not dirty and release_commit(root, candidate) == commit:
            stable, tag = True, candidate
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    suffix = ("g" + commit[:12]) if commit else "unknown"
    version = base if stable else base + "-dev+" + suffix + (".dirty" if dirty else "")
    return {"version": version, "baseVersion": base,
            "channel": "stable" if stable else "development",
            "commit": commit, "tag": tag, "dirty": dirty}


def require_stable(info: dict) -> None:
    if info["channel"] != "stable":
        raise ValueError("拒绝启动非稳定版：请使用 tools/release.py checkout 检出的干净发布目录")
