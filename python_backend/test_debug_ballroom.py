"""Exercise debug turn initialization through the authoritative native worker."""
import copy
import os
import shutil
import unittest

from python_backend.game_engine_worker import GameEngineWorker
from python_backend.native_worker_manager import NativeWorkerManager


class DebugBallroomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("clang++"):
            raise unittest.SkipTest("clang++ required")
        manager = NativeWorkerManager()
        compiler, environment, devcmd = manager._compiler_environment(require_msvc=os.name == "nt")
        executable = manager._build_game_engine(compiler, environment, devcmd)
        cls.worker = GameEngineWorker(executable, env=environment)

    @classmethod
    def tearDownClass(cls):
        cls.worker.close()

    def setUp(self):
        self.game_id = self.id()
        self.state = {
            "phase": "action", "initializeTurn": True, "round": 1,
            "config": {"endDistricts": 8}, "rngState": 1234,
            "charDeck": ["merchant", "architect", "warlord"], "callIdx": 0,
            "callQueue": [{"charId": role, "num": i + 6, "playerIdx": i}
                          for i, role in enumerate(["merchant", "architect", "warlord"])],
            "players": [{"id": "p" + str(i), "name": "Player " + str(i), "gold": 2,
                         "chars": [role], "hasCrown": i == 1, "city": [], "hand": []}
                        for i, role in enumerate(["merchant", "architect", "warlord"])],
            "turn": {"playerIdx": 0, "charId": "merchant", "num": 6,
                     "phase": "main", "takenResources": False, "pending": None},
            "deck": [], "discard": []}
        self.state["players"][1]["city"] = [{"uid": "ball", "en": "Ballroom", "name": "舞厅",
                                            "color": "purple", "cost": 6, "purple": {"effect": "ballroom"}}]

    def actions(self, actor="p0"):
        return self.worker.legal_actions(game_id=self.game_id, player_id=actor)["actions"]

    def load(self):
        return self.worker.load_game(copy.deepcopy(self.state), self.game_id)

    def test_fresh_debug_turn_requires_thanks_before_resources(self):
        state = self.load()
        self.assertEqual(state["turn"]["pending"]["kind"], "ballroom")
        self.assertEqual({a.get("name") for a in self.actions()}, {"ballroom_thanks", "ballroom_skip"})
        with self.assertRaises(RuntimeError):
            self.worker.apply(game_id=self.game_id, player_id="p0", action={"type": "take_gold"})
        self.worker.apply(game_id=self.game_id, player_id="p0",
                          action={"type": "district_effect", "name": "ballroom_thanks"})
        self.assertIn("take_gold", {a["type"] for a in self.actions()})
        # Restoring an acknowledged turn must not demand thanks a second time.
        saved = self.worker.snapshot(self.game_id)
        restored = self.worker.load_game(saved, self.game_id)
        self.assertIsNone(restored["turn"]["pending"])

    def test_refusal_skips_turn_without_collecting_gold(self):
        self.load()
        state = self.worker.apply(game_id=self.game_id, player_id="p0",
                                  action={"type": "district_effect", "name": "ballroom_skip"})
        self.assertEqual(state["turn"]["playerIdx"], 1)
        self.assertEqual(state["players"][0]["gold"], 2)
        self.assertEqual(state["turnsCompleted"], 1)

    def test_ballroom_without_crown_and_own_turn_do_not_require_thanks(self):
        self.state["players"][1]["hasCrown"] = False
        self.assertIsNone(self.load()["turn"]["pending"])
        self.state["players"][0]["hasCrown"] = True
        self.state["players"][0]["city"] = self.state["players"][1]["city"]
        self.state["players"][1]["city"] = []
        self.assertIsNone(self.load()["turn"]["pending"])

    def test_subsequent_turn_still_checks_ballroom(self):
        self.state["players"][0]["hasCrown"] = True
        self.state["players"][0]["city"] = self.state["players"][1]["city"]
        self.state["players"][1]["city"] = []
        self.state["players"][1]["hasCrown"] = False
        self.load()
        self.worker.apply(game_id=self.game_id, player_id="p0", action={"type": "take_gold"})
        state = self.worker.apply(game_id=self.game_id, player_id="p0", action={"type": "end_turn"})
        self.assertEqual(state["turn"]["pending"]["kind"], "ballroom")
        self.assertEqual({a.get("name") for a in self.actions("p1")}, {"ballroom_thanks", "ballroom_skip"})


if __name__ == "__main__":
    unittest.main()
