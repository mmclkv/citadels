"""Regression tests for Witch turn sequencing and Navigator build restrictions."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class WitchTurnRulesTests(unittest.TestCase):
    def test_witch_declaration_and_navigator_resume(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ is required for the native Witch regression probe")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-witch-turn-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run(
                [compiler, str(root / "native" / "witch_turn_regression.cpp"),
                 "-std=c++17", "-O2", "-o", str(executable)],
                capture_output=True, text=True, env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                                    env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("witch turn regressions passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
