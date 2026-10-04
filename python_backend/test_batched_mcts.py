"""Compile/run the native batch-statistics regressions without LibTorch."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class BatchedMctsTests(unittest.TestCase):
    def test_pending_statistics_and_immediate_terminal_backup(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ is required for the native regression probe")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-mcts-regression-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run(
                [compiler, str(root / "native" / "batched_mcts_regression.cpp"),
                 "-std=c++17", "-O2", "-o", str(executable)],
                capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                                    env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("regression tests passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
