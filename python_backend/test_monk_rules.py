"""Native monk income timing, richest-player selection and display regressions."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from python_backend.server import PythonServer


class MonkRulesTests(unittest.TestCase):
    def test_native_rules(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ is required for native checks")
        environment = dict(os.environ)
        environment["PATH"] = str(Path(compiler).parent) + os.pathsep + environment.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-monk-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            compiled = subprocess.run([compiler, str(ROOT / "native/monk_rules_regression.cpp"),
                "-std=c++17", "-O2", "-o", str(executable)], capture_output=True, text=True,
                env=environment, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True,
                env=environment, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_action_labels_and_public_logs(self):
        state = {"turn": {"charId": "monk", "playerIdx": 0}, "players": [
            {"id": "me", "name": "修士玩家", "city": [{"color": "blue"}]},
            {"id": "rich", "name": "电脑1"}]}
        income = {"type": "income"}
        self.assertIn("共 1 份资源", PythonServer._native_action_view(state, income)["label"])
        take = {"type": "monk_take", "target": "rich"}
        self.assertIn("电脑1", PythonServer._native_action_view(state, take)["label"])
        self.assertIn("电脑1", PythonServer._game_action_log_text(state, take))
        combo = {"type": "monk_resource", "gold": 1, "cards": 2}
        self.assertIn("1枚金币、2张建筑牌", PythonServer._game_action_log_text(state, combo))


if __name__ == "__main__":
    unittest.main()
