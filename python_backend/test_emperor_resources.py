"""Emperor resource action formats, native transfer, and truthful presentation."""
import copy
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.server import PythonServer


class EmperorResourceTests(unittest.TestCase):
    def setUp(self):
        self.state = {"turn": {"charId": "emperor", "playerIdx": 0,
                               "pending": {"kind": "emperor_take", "targetIdx": 1}},
                      "players": [{"id": "emperor", "name": "皇帝玩家", "seat": 0,
                                   "gold": 2, "hand": []},
                                  {"id": "recipient", "name": "接收者", "seat": 1,
                                   "gold": 3, "hand": [{"uid": "card"}]}]}

    def test_gold_name_and_mode_have_same_label_log_and_notice(self):
        updated = copy.deepcopy(self.state)
        updated.update(noticeSeq=0, notices=[])
        updated["players"][0]["gold"] = 3
        updated["players"][1]["gold"] = 2
        for key in ("name", "mode"):
            action = {"type": "emperor_take", key: "gold"}
            self.assertIn("金币", PythonServer._native_action_view(self.state, action)["label"])
            self.assertEqual(PythonServer._game_action_log_text(self.state, action, updated),
                             "皇帝从新皇冠持有者座位2·接收者处取得1枚金币")
            PythonServer._append_role_effect_detail_notice(self.state, updated, "emperor", action)
            self.assertIn("1枚金币", updated["notices"][-1]["description"])
            self.assertNotIn("建筑牌", updated["notices"][-1]["description"])

    def test_card_name_and_mode_report_real_card_gain(self):
        updated = copy.deepcopy(self.state)
        updated["players"][0]["hand"] = [{"uid": "card"}]
        updated["players"][1]["hand"] = []
        for key in ("name", "mode"):
            self.assertIn("取得1张建筑牌", PythonServer._game_action_log_text(
                self.state, {"type": "emperor_take", key: "card"}, updated))

    def test_empty_target_does_not_claim_a_resource_gain(self):
        for mode, resource in (("gold", "0枚金币"), ("card", "0张建筑牌")):
            state = copy.deepcopy(self.state)
            state["players"][1].update(gold=0, hand=[])
            updated = copy.deepcopy(state)
            updated.update(noticeSeq=0, notices=[])
            action = {"type": "emperor_take", "name": mode}
            self.assertIn(resource, PythonServer._game_action_log_text(state, action, updated))
            PythonServer._append_role_effect_detail_notice(state, updated, "emperor", action)
            self.assertIn(resource, updated["notices"][-1]["description"])

    def test_conflicting_fields_follow_native_name_precedence(self):
        self.assertIn("1枚金币", PythonServer._game_action_log_text(
            self.state, {"type": "emperor_take", "name": "gold", "mode": "card"}))

    def test_native_transfer_and_action_encoding(self):
        compiler = shutil.which("clang++")
        if compiler is None:
            self.skipTest("clang++ required")
        root = Path(__file__).resolve().parents[1]
        env = dict(os.environ)
        env["PATH"] = str(Path(compiler).parent) + os.pathsep + env.get("PATH", "")
        with tempfile.TemporaryDirectory(prefix="citadels-emperor-") as directory:
            executable = Path(directory) / ("probe.exe" if os.name == "nt" else "probe")
            result = subprocess.run([compiler, str(root / "native/emperor_take_regression.cpp"),
                                     "-std=c++17", "-O0", "-o", str(executable)],
                                    capture_output=True, text=True, env=env, timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, env=env, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("emperor take regressions passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
