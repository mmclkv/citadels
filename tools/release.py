"""Explicit local releases and isolated, pinned production checkouts."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.versioning import (ROOT, VERSION_PATTERN, git, release_commit,
                                       require_stable, validate_version, version_info)


def create_tag(root: Path, version: str) -> str:
    version = validate_version(version)
    if (root / "VERSION").read_text(encoding="utf-8").strip() != version:
        raise ValueError("请先将 VERSION 改为目标版本并提交")
    if git(root, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("存在未提交的已跟踪文件，请先测试并提交")
    if git(root, "show", "HEAD:VERSION") != version:
        raise ValueError("VERSION 必须已包含在当前提交中")
    tag = "v" + version
    tags = git(root, "tag", "--list").splitlines()
    if tag in tags:
        raise ValueError("版本标签已存在，禁止覆盖或移动")
    previous = [tuple(map(int, item[1:].split("."))) for item in tags
                if item.startswith("v") and VERSION_PATTERN.fullmatch(item[1:])]
    if previous and tuple(map(int, version.split("."))) <= max(previous):
        raise ValueError("新稳定版必须高于已有版本；回滚请使用 checkout")
    git(root, "tag", "-a", tag, "-m", "Citadels " + version)
    return tag


def checkout_release(root: Path, tag: str, destination: Path) -> dict:
    commit = release_commit(root, tag)
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("目标目录已存在，请选择新的发布目录；不会覆盖现有服务器")
    git(root, "worktree", "add", "--detach", str(destination), commit, timeout=300)
    info = version_info(destination)
    require_stable(info)
    if info["commit"] != commit or info["tag"] != tag:
        raise ValueError("检出后的发布身份校验失败")
    return info


def main() -> int:
    parser = argparse.ArgumentParser(description="稳定版发布、查询与独立检出（不自动推送或重启）")
    parser.add_argument("--repo", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    tag = commands.add_parser("tag", help="测试并提交后，显式创建不可覆盖的稳定版标签")
    tag.add_argument("version")
    checkout = commands.add_parser("checkout", help="部署或回滚到指定稳定版")
    checkout.add_argument("tag")
    checkout.add_argument("directory", type=Path)
    checkout.add_argument("--fetch", action="store_true", help="先从 origin 获取标签，不强制覆盖")
    args = parser.parse_args()
    try:
        if args.command == "status":
            print(json.dumps(version_info(args.repo), ensure_ascii=False, indent=2))
        elif args.command == "tag":
            name = create_tag(args.repo, args.version)
            print(f"已创建 {name}；发布到 GitHub：git push origin {name}")
        else:
            if args.fetch:
                git(args.repo, "fetch", "origin", "--tags", timeout=300)
            info = checkout_release(args.repo, args.tag, args.directory)
            print(json.dumps(info, ensure_ascii=False, indent=2))
            print(f"发布目录：{args.directory.resolve()}")
            print("使用共享 Python 运行该目录的 python_backend/run.py，并传入 --require-stable")
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        print("发布失败：" + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
