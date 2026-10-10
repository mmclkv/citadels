"""Compile and execute authoritative threat/build rule regressions when clang is installed."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TurnInterruptionTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("clang++"), "C++ compiler required")
    def test_resource_threat_and_wizard_confiscation_rules(self):
        with tempfile.TemporaryDirectory(prefix="citadels-interruptions-") as directory:
            executable = Path(directory) / "turn-interruptions.exe"
            build = subprocess.run([shutil.which("clang++"), "-std=c++17", "-O1",
                                    str(ROOT / "native/turn_interruptions_probe.cpp"),
                                    "-o", str(executable)], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=120)
            self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("turn-interruption checks passed:", result.stdout)


if __name__ == "__main__":
    unittest.main()
