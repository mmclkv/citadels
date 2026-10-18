"""Compile native non-clairvoyance, perfect-recall and visibility regressions."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class InformationSetTests(unittest.TestCase):
    def test_shared_decisions_and_private_observation_history(self):
        compiler = shutil.which("clang++")
        if not compiler:
            self.skipTest("clang++ is required")
        root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-information-set-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run([compiler, str(root / "native/information_set_regression.cpp"),
                "-std=c++17", "-O2", "-o", str(executable)], env=environment,
                capture_output=True, text=True, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            tested = subprocess.run([str(executable)], env=environment,
                capture_output=True, text=True, timeout=60)
            self.assertEqual(tested.returncode, 0, tested.stdout + tested.stderr)
            self.assertIn("Information-set regression tests passed", tested.stdout)


if __name__ == "__main__":
    unittest.main()
