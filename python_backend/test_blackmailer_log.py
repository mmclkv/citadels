"""Public blackmail resolution logs describe the target and actual outcome."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from python_backend.server import PythonServer


class BlackmailerLogTests(unittest.TestCase):
    def state(self, real=True, native=True, gold=5):
        state = {
            "players": [{"name": "电脑1", "gold": 2}, {"name": "玩家", "gold": gold}],
            "turn": {"playerIdx": 1},
            "reaction": {"kind": "blackmailer", "playerIdx": 0, "targetIdx": 1, "num": 4},
            "effects": {"blackmailer": {"signed": 4 if real else 7}},
        }
        if native:
            state["turn"]["pending"] = {"kind": "blackmailer_threat", "signed": int(real)}
        updated = copy.deepcopy(state)
        if real:
            updated["players"][0]["gold"] += gold
            updated["players"][1]["gold"] = 0
        return state, updated

    def test_real_mark_reports_target_recipient_and_amount(self):
        for native in (True, False):
            for gold in (0, 5):
                with self.subTest(native=native, gold=gold):
                    state, updated = self.state(native=native, gold=gold)
                    action = {"type": "reaction", "name": "use"} if native else {"type": "reaction", "use": True}
                    text = PythonServer._game_action_log_text(state, action, updated)
                    self.assertIn("对座位2·玩家发动勒索", text)
                    self.assertIn(f"全部{gold}枚金币", text)
                    self.assertIn("交给座位1·电脑1", text)

    def test_fake_mark_reports_no_loss(self):
        state, updated = self.state(real=False)
        text = PythonServer._game_action_log_text(state, {"type": "reaction", "name": "use"}, updated)
        self.assertIn("假威胁标记", text)
        self.assertIn("没有损失金币", text)
        self.assertNotIn("没收", text)

    def test_skipping_does_not_reveal_mark(self):
        for real in (True, False):
            state, _ = self.state(real=real)
            text = PythonServer._game_action_log_text(state, {"type": "reaction", "name": "skip"}, state)
            self.assertIn("放弃对座位2·玩家发动勒索", text)
            self.assertIn("本轮作废", text)
            self.assertNotIn("真威胁", text)
            self.assertNotIn("假威胁", text)


if __name__ == "__main__":
    unittest.main()
