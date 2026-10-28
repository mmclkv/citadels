"""Characterize leaf-viewpoint information loss without changing production search."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ValuePerspectiveTests(unittest.TestCase):
    def test_private_information_and_value_backup(self):
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        devcmd = None
        if os.name == "nt":
            from python_backend.native_worker_manager import NativeWorkerManager, _msvc_build_command
            compiler, environment, devcmd = NativeWorkerManager()._compiler_environment(require_msvc=True)
        else:
            compiler = shutil.which("clang++") or shutil.which("g++")
            if not compiler:
                self.skipTest("C++20 compiler required")
        with tempfile.TemporaryDirectory(prefix="citadels-value-perspective-") as folder:
            exe = Path(folder) / ("probe.exe" if os.name == "nt" else "probe")
            command = [compiler, "-std=c++20", "-O2",
                       str(root / "native/value_perspective_regression.cpp"), "-o", str(exe)]
            if os.name == "nt":
                command[1:1] = ["--target=x86_64-pc-windows-msvc", "-fexceptions",
                                "-fms-compatibility", "-fms-extensions", "-DWIN32_LEAN_AND_MEAN"]
                if devcmd:
                    command = _msvc_build_command(devcmd, command)
            result = subprocess.run(command, cwd=root, env=environment, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(exe)], cwd=root, env=environment, capture_output=True,
                                    text=True, encoding="utf-8", errors="replace", timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("90 real-encoder pairs", result.stdout)
            self.assertIn("16 serial/batched search cases", result.stdout)


if __name__ == "__main__":
    unittest.main()
