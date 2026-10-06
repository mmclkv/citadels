"""Compile/run heuristic ISMCTS and wall-clock budget regression checks."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class HeuristicSearchTests(unittest.TestCase):
    def test_search_and_wall_clock_budget(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ is required for native heuristic checks")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-heuristic-deadline-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run(
                [compiler, str(root / "native/heuristic_search_probe.cpp"), "-std=c++17", "-O2", "-o", str(executable)],
                capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, env=environment, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("heuristic ISMCTS checks passed", result.stdout)
            print(result.stdout)


if __name__ == "__main__":
    unittest.main()
