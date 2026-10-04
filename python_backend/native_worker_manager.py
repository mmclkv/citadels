"""Build (when stale) and supervise the server-owned LibTorch MCTS worker."""

from __future__ import annotations

import json
import hashlib
import os
import platform
import shutil
import subprocess
import threading
from pathlib import Path

from .native_worker import NativeMctsWorker
from .game_engine_worker import GameEngineWorker

ROOT = Path(__file__).resolve().parents[1]
NATIVE_DIR = ROOT / "native"
PLATFORM_SUFFIX = ".exe" if os.name == "nt" else ""
WORKER = NATIVE_DIR / f"mcts_worker_libtorch{PLATFORM_SUFFIX}"
STAMP = NATIVE_DIR / f"mcts_worker_libtorch{PLATFORM_SUFFIX}.build.json"
GAME_ENGINE = NATIVE_DIR / f"game_engine{PLATFORM_SUFFIX}"
GAME_STAMP = NATIVE_DIR / f"game_engine{PLATFORM_SUFFIX}.build.json"


def _worker_sources() -> list[Path]:
    return [NATIVE_DIR / "mcts_worker.cpp", *sorted(NATIVE_DIR.glob("*.hpp"))]


class NativeWorkerManager:
    def __init__(self, log=print) -> None:
        self.log = log
        self.process: subprocess.Popen | None = None
        self.worker: NativeMctsWorker | None = None
        self.game_worker: GameEngineWorker | None = None
        self._lock = threading.RLock()
        self.compiler = ""
        self.rebuilt = False

    @property
    def running(self) -> bool:
        return (self.process is not None and self.process.poll() is None and
                self.game_worker is not None and self.game_worker.process.poll() is None)

    def _compiler_environment(self) -> tuple[str, dict[str, str], str | None]:
        compiler = os.environ.get("CITADELS_CLANGXX") or shutil.which("clang++")
        if not compiler:
            raise RuntimeError("找不到 clang++；请将 clang++ 加入 PATH 或设置 CITADELS_CLANGXX")
        if os.name != "nt":
            return str(compiler), os.environ.copy(), None
        devcmd_candidates = [
            Path(os.environ.get("VSINSTALLDIR", "")) / "Common7" / "Tools" / "VsDevCmd.bat",
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/Community/Common7/Tools/VsDevCmd.bat"),
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/BuildTools/Common7/Tools/VsDevCmd.bat"),
            *Path("C:/Program Files/Microsoft Visual Studio").glob("*/Professional/Common7/Tools/VsDevCmd.bat"),
        ]
        devcmd = next((path for path in devcmd_candidates if path.is_file()), None)
        if not devcmd:
            raise RuntimeError("clang++ 的 MSVC 目标需要 Visual Studio VsDevCmd.bat 和 link.exe")
        import ctypes
        short_path = ctypes.create_unicode_buffer(32768)
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        if not get_short_path(str(devcmd), short_path, len(short_path)):
            raise RuntimeError("无法解析 VsDevCmd.bat 的 Windows 短路径")
        # Keep compiler invocation in the same cmd process as VsDevCmd. Merely
        # exporting its environment to Python and spawning clang separately can
        # yield a linked exe that exits with STATUS_ENTRYPOINT_NOT_FOUND.
        return str(compiler), os.environ.copy(), short_path.value

    def _build_identity(self, compiler: str, torch_version: str) -> dict:
        target = "x86_64-pc-windows-msvc" if os.name == "nt" else f"{platform.machine()}-{platform.system().lower()}"
        return {"compiler": str(Path(compiler).resolve()).lower(), "torch": torch_version,
                "compilerMtimeNs": Path(compiler).stat().st_mtime_ns,
                "target": target, "standard": "c++20",
                "sources": {path.name: path.stat().st_mtime_ns for path in _worker_sources()}}

    @staticmethod
    def _versioned_artifact(stem: str, identity: dict) -> tuple[Path, Path]:
        encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
        version = hashlib.sha256(encoded).hexdigest()[:12]
        executable = NATIVE_DIR / f"{stem}-{version}{PLATFORM_SUFFIX}"
        return executable, executable.with_suffix(".build.json")

    def _is_current(self, identity: dict, worker: Path = WORKER, stamp: Path = STAMP) -> bool:
        try:
            if not worker.is_file() or not stamp.is_file():
                return False
            if json.loads(stamp.read_text(encoding="utf-8")) != identity:
                return False
            return worker.stat().st_mtime_ns >= max(path.stat().st_mtime_ns for path in _worker_sources())
        except (OSError, ValueError, TypeError):
            return False

    def _build(self, compiler: str, environment: dict[str, str], torch_root: Path,
               devcmd: str | None, destination: Path = WORKER,
               torch_abi: bool = True) -> None:
        output = destination.with_name(f"{destination.stem}_tmp-{os.getpid()}{PLATFORM_SUFFIX}")
        torch_include = torch_root / "include"
        torch_api_include = torch_include / "torch" / "csrc" / "api" / "include"
        libraries = torch_root / "lib"
        args = [compiler, "-std=c++20", "-O2", "-fexceptions",
                "-DCITADELS_LIBTORCH", "-I", str(NATIVE_DIR),
                "-I", str(torch_include), "-I", str(torch_api_include),
                "-L", str(libraries)]
        if os.name == "nt":
            args[1:1] = ["--target=x86_64-pc-windows-msvc", "-fms-compatibility", "-fms-extensions",
                         "-fdelayed-template-parsing", "-finput-charset=UTF-8", "-fexec-charset=UTF-8",
                         "-DWIN32_LEAN_AND_MEAN"]
        else:
            args += [f"-D_GLIBCXX_USE_CXX11_ABI={int(torch_abi)}", f"-Wl,-rpath,{libraries}"]
        args += [str(NATIVE_DIR / "mcts_worker.cpp")]
        if os.name == "nt":
            # Keep the Windows linker options after the translation unit.
            args += ["-ltorch", "-ltorch_cpu", "-lc10", "-ldbghelp", "-o", str(output)]
        else:
            args += ["-ltorch", "-ltorch_cpu"]
            torch_cuda = libraries / "libtorch_cuda.so"
            nccl_candidates = [*libraries.glob("libnccl.so*"),
                               *(torch_root.parent / "nvidia" / "nccl" / "lib").glob("libnccl.so*")]
            nccl_library = next((path for path in nccl_candidates if path.is_file()), None)
            if torch_cuda.is_file():
                args += ["-ltorch_cuda"]
                if nccl_library is None:
                    raise RuntimeError(
                        "检测到 CUDA 版 LibTorch，但当前 Python 环境没有 NCCL 动态库；"
                        "请在该虚拟环境中重新安装与 PyTorch 匹配的 CUDA 依赖，"
                        "或改装 CPU 版 PyTorch。")
                # The pip CUDA wheel places NCCL under site-packages/nvidia/nccl/lib,
                # not torch/lib. Pass its full path so GNU ld resolves the NCCL
                # references exported by libtorch_cuda.so at executable link time.
                args += [str(nccl_library)]
            if (libraries / "libc10_cuda.so").is_file():
                args += ["-lc10_cuda"]
            args += ["-lc10", "-o", str(output)]
            runtime_library_paths = [str(libraries)]
            if nccl_library is not None:
                runtime_library_paths.append(str(nccl_library.parent))
            args[args.index(f"-Wl,-rpath,{libraries}")] = (
                "-Wl,-rpath," + ":".join(runtime_library_paths))
        self.log("[native] C++ worker 源码或 LibTorch 版本已更新，使用 clang++ 重新编译…")
        try:
            # Run clang from cmd.exe under the initialized MSVC environment. On
            # Windows, launching clang directly from Python can produce an exe
            # that links successfully but fails at process startup.
            if os.name == "nt":
                command = f'call "{devcmd}" -arch=x64 -host_arch=x64 && {subprocess.list2cmdline(args)}'
                run_args = ["cmd.exe", "/d", "/c", command]
            else:
                run_args = args
            result = subprocess.run(run_args, shell=False,
                                    cwd=ROOT, env=environment, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=900,
                                    check=False)
            if result.returncode or not output.is_file():
                details = (result.stdout + "\n" + result.stderr)[-6000:]
                raise RuntimeError("clang++ 编译 mcts_worker_libtorch 失败：\n" + details)
            os.replace(output, destination)
        finally:
            for path in (output, output.with_suffix(".lib"), output.with_suffix(".exp")):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _build_game_engine(self, compiler: str, environment: dict[str, str], devcmd: str | None) -> Path:
        sources = [NATIVE_DIR / "game_engine_worker.cpp", *sorted(NATIVE_DIR.glob("*.hpp"))]
        identity = {"compiler": str(Path(compiler).resolve()).lower(),
                    "compilerMtimeNs": Path(compiler).stat().st_mtime_ns,
                    "target": ("x86_64-pc-windows-msvc" if os.name == "nt" else f"{platform.machine()}-{platform.system().lower()}"), "standard": "c++20",
                    "sources": {path.name: path.stat().st_mtime_ns for path in sources}}
        destination, stamp = self._versioned_artifact("game_engine", identity)
        try:
            current = (destination.is_file() and stamp.is_file() and
                       json.loads(stamp.read_text(encoding="utf-8")) == identity and
                       destination.stat().st_mtime_ns >= max(path.stat().st_mtime_ns for path in sources))
        except (OSError, ValueError, TypeError):
            current = False
        if current:
            self.log(f"[game] {destination.name} 已是最新，跳过编译")
            return destination
        output = destination.with_name(f"{destination.stem}_tmp-{os.getpid()}{PLATFORM_SUFFIX}")
        args = [compiler, "-std=c++20", "-O2", "-fexceptions", "-I", str(NATIVE_DIR),
                str(NATIVE_DIR / "game_engine_worker.cpp"), "-o", str(output)]
        if os.name == "nt":
            args[1:1] = ["--target=x86_64-pc-windows-msvc", "-fms-compatibility", "-fms-extensions",
                         "-fdelayed-template-parsing", "-finput-charset=UTF-8", "-fexec-charset=UTF-8",
                         "-DWIN32_LEAN_AND_MEAN"]
        self.log("[game] 游戏引擎源码已更新，使用 clang++ 编译独立游戏主进程…")
        try:
            if os.name == "nt":
                command = f'call "{devcmd}" -arch=x64 -host_arch=x64 && {subprocess.list2cmdline(args)}'
                run_args = ["cmd.exe", "/d", "/c", command]
            else:
                run_args = args
            result = subprocess.run(run_args, shell=False, cwd=ROOT,
                                    env=environment, capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=900, check=False)
            if result.returncode or not output.is_file():
                raise RuntimeError("clang++ 编译 game_engine 失败：\n" +
                                   (result.stdout + "\n" + result.stderr)[-6000:])
            os.replace(output, destination)
            stamp.write_text(json.dumps(identity, indent=2), encoding="utf-8")
            return destination
        finally:
            try:
                output.unlink(missing_ok=True)
            except OSError:
                pass

    def start(self) -> None:
        import torch

        torch_root = Path(torch.__file__).resolve().parent
        compiler, environment, devcmd = self._compiler_environment()
        identity = self._build_identity(compiler, torch.__version__)
        with self._lock:
            game_executable = self._build_game_engine(compiler, environment, devcmd)
            mcts_executable, mcts_stamp = self._versioned_artifact("mcts_worker_libtorch", identity)
            if not self._is_current(identity, mcts_executable, mcts_stamp):
                self._build(compiler, environment, torch_root, devcmd, mcts_executable,
                            torch_abi=bool(torch.compiled_with_cxx11_abi()))
                mcts_stamp.write_text(json.dumps(identity, indent=2), encoding="utf-8")
                self.rebuilt = True
            else:
                self.log(f"[native] {mcts_executable.name} 已是最新，跳过编译")
            self.worker = NativeMctsWorker(mcts_executable)
            self.game_worker = GameEngineWorker(game_executable, env=environment)
            self.process = self.worker.process
            if self.process.poll() is not None:
                code = self.process.returncode
                self.worker = None
                self.process = None
                if self.game_worker is not None:
                    self.game_worker.close()
                    self.game_worker = None
                raise RuntimeError(f"{mcts_executable.name} 启动失败（exit={code}）；请检查 LibTorch 动态库依赖")
            if self.game_worker.process.poll() is not None:
                code = self.game_worker.process.returncode
                self.close()
                raise RuntimeError(f"{game_executable.name} 启动失败（exit={code}）")
            self.compiler = compiler
            self.log(f"[native] {self.worker.executable.name} 已启动（pid={self.process.pid}）")
            self.log(f"[game] {self.game_worker.executable.name} 已启动（pid={self.game_worker.process.pid}）")

    def close(self) -> None:
        with self._lock:
            worker, self.worker = self.worker, None
            game_worker, self.game_worker = self.game_worker, None
            process, self.process = self.process, None
            if process is None:
                if game_worker is not None:
                    game_worker.close()
                return
            if worker is not None:
                worker.close()
                if game_worker is not None:
                    game_worker.close()
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
