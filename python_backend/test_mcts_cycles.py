"""Check AI-only navigation filtering and bounded MCTS cycle handling."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MctsCycleTests(unittest.TestCase):
    def test_native_cycle_regressions(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ is required")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-cycle-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run(
                [compiler, str(root / "native" / "mcts_cycle_regression.cpp"),
                 "-std=c++17", "-O2", "-o", str(executable)],
                capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                                    env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("regression tests passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
