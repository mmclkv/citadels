"""Build (when stale) and supervise the server-owned LibTorch MCTS worker."""

from __future__ import annotations

import json
import ctypes
import os
import shutil
import subprocess
import threading
from pathlib import Path

from .native_worker import NativeMctsWorker

ROOT = Path(__file__).resolve().parents[1]
NATIVE_DIR = ROOT / "native"
WORKER = NATIVE_DIR / "mcts_worker_libtorch.exe"
STAMP = NATIVE_DIR / "mcts_worker_libtorch.build.json"


def _worker_sources() -> list[Path]:
    return [NATIVE_DIR / "mcts_worker.cpp", *sorted(NATIVE_DIR.glob("*.hpp"))]


class NativeWorkerManager:
    def __init__(self, log=print) -> None:
        self.log = log
        self.process: subprocess.Popen | None = None
        self.worker: NativeMctsWorker | None = None
        self._lock = threading.RLock()
        self.compiler = ""
        self.rebuilt = False

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def _compiler_environment(self) -> tuple[str, dict[str, str], str]:
        compiler = os.environ.get("CITADELS_CLANGXX") or shutil.which("clang++")
        if not compiler:
            raise RuntimeError("找不到 clang++；请将 clang++ 加入 PATH 或设置 CITADELS_CLANGXX")
        devcmd_candidates = [
            Path(os.environ.get("VSINSTALLDIR", "")) / "Common7" / "Tools" / "VsDevCmd.bat",
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/Community/Common7/Tools/VsDevCmd.bat"),
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/BuildTools/Common7/Tools/VsDevCmd.bat"),
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/Professional/Common7/Tools/VsDevCmd.bat"),
        ]
        devcmd = next((path for path in devcmd_candidates if path.is_file()), None)
        if not devcmd:
            raise RuntimeError("clang++ 的 MSVC 目标需要 Visual Studio VsDevCmd.bat 和 link.exe")
        short_path = ctypes.create_unicode_buffer(32768)
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        if not get_short_path(str(devcmd), short_path, len(short_path)):
            raise RuntimeError("无法解析 VsDevCmd.bat 的 Windows 短路径")
        # Keep compiler invocation in the same cmd process as VsDevCmd. Merely
        # exporting its environment to Python and spawning clang separately can
        # yield a linked exe that exits with STATUS_ENTRYPOINT_NOT_FOUND.
        return str(compiler), os.environ.copy(), short_path.value

    def _build_identity(self, compiler: str, torch_version: str) -> dict:
        return {"compiler": str(Path(compiler).resolve()).lower(), "torch": torch_version,
                "compilerMtimeNs": Path(compiler).stat().st_mtime_ns,
                "target": "x86_64-pc-windows-msvc", "standard": "c++20",
                "sources": {path.name: path.stat().st_mtime_ns for path in _worker_sources()}}

    def _is_current(self, identity: dict) -> bool:
        try:
            if not WORKER.is_file() or not STAMP.is_file():
                return False
            if json.loads(STAMP.read_text(encoding="utf-8")) != identity:
                return False
            return WORKER.stat().st_mtime_ns >= max(path.stat().st_mtime_ns for path in _worker_sources())
        except (OSError, ValueError, TypeError):
            return False

    def _build(self, compiler: str, environment: dict[str, str], torch_root: Path,
               devcmd: str) -> None:
        output = NATIVE_DIR / f"mcts_worker_libtorch_tmp-{os.getpid()}.exe"
        torch_include = torch_root / "include"
        torch_api_include = torch_include / "torch" / "csrc" / "api" / "include"
        libraries = torch_root / "lib"
        args = [compiler, "--target=x86_64-pc-windows-msvc", "-std=c++20", "-O2",
                "-fexceptions", "-fms-compatibility", "-fms-extensions",
                "-fdelayed-template-parsing", "-finput-charset=UTF-8", "-fexec-charset=UTF-8",
                "-DCITADELS_LIBTORCH", "-DWIN32_LEAN_AND_MEAN", "-I", str(NATIVE_DIR),
                "-I", str(torch_include), "-I", str(torch_api_include),
                str(NATIVE_DIR / "mcts_worker.cpp"), "-L", str(libraries),
                "-ltorch", "-ltorch_cpu", "-lc10", "-ldbghelp", "-o", str(output)]
        self.log("[native] C++ worker 源码或 LibTorch 版本已更新，使用 clang++ 重新编译…")
        try:
            # Run clang from cmd.exe under the initialized MSVC environment. On
            # Windows, launching clang directly from Python can produce an exe
            # that links successfully but fails at process startup.
            compiler_command = " ".join(f'"{arg}"' if any(char.isspace() for char in arg) else arg
                                         for arg in args)
            command = (f'call "{devcmd}" -arch=x64 -host_arch=x64 && '
                       f'{compiler_command}')
            result = subprocess.run(f'cmd.exe /d /c {command}', shell=False,
                                    cwd=ROOT, env=environment, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=900,
                                    check=False)
            if result.returncode or not output.is_file():
                details = (result.stdout + "\n" + result.stderr)[-6000:]
                raise RuntimeError("clang++ 编译 mcts_worker_libtorch 失败：\n" + details)
            os.replace(output, WORKER)
        finally:
            for path in (output, output.with_suffix(".lib"), output.with_suffix(".exp")):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    def start(self) -> None:
        if os.name != "nt":
            raise RuntimeError("当前 native LibTorch worker 产物仅支持 Windows")
        import torch

        torch_root = Path(torch.__file__).resolve().parent
        compiler, environment, devcmd = self._compiler_environment()
        identity = self._build_identity(compiler, torch.__version__)
        with self._lock:
            if not self._is_current(identity):
                self._build(compiler, environment, torch_root, devcmd)
                STAMP.write_text(json.dumps(identity, indent=2), encoding="utf-8")
                self.rebuilt = True
            else:
                self.log("[native] mcts_worker_libtorch.exe 已是最新，跳过编译")
            self.worker = NativeMctsWorker(WORKER)
            self.process = self.worker.process
            if self.process.poll() is not None:
                code = self.process.returncode
                self.worker = None
                self.process = None
                raise RuntimeError(f"mcts_worker_libtorch.exe 启动失败（exit={code}）；请检查 LibTorch DLL 依赖")
            self.compiler = compiler
            self.log(f"[native] mcts_worker_libtorch.exe 已启动（pid={self.process.pid}）")

    def close(self) -> None:
        with self._lock:
            worker, self.worker = self.worker, None
            process, self.process = self.process, None
            if process is None:
                return
            if worker is not None:
                worker.close()
                return
            if process.poll() is None:
                try:
                    if process.stdin:
                        process.stdin.close()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            if process.stdin:
                process.stdin.close()
