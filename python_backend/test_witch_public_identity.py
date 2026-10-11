"""The Witch's target stays identifiable after the acting player changes."""
import unittest

from python_backend.views import sanitize
from test.python_game_reference import create_game


class WitchPublicIdentityTests(unittest.TestCase):
    def test_original_owner_and_identity_lifetime(self):
        state = create_game({"seats": [{"id": "witch", "name": "女巫玩家"},
                                       {"id": "target", "name": "目标玩家"}]})
        state["phase"] = "action"
        state["charDeck"] = ["witch", "king"]
        state["players"][0]["chars"] = ["witch"]
        state["players"][1]["chars"] = ["king"]
        state["callQueue"] = [{"num": 1, "charId": "witch", "playerIdx": 0},
                              {"num": 4, "charId": "king", "playerIdx": 1}]
        state["effects"]["bewitched"] = 4

        def identities():
            return [p["takenOverCharId"] for p in sanitize(state, "target")["players"]]

        self.assertEqual(identities(), [None, None], "even the target's own view waits for the call")
        state["callIdx"] = 1
        state["turn"] = {"playerIdx": 1, "charId": "king", "num": 4,
                         "phase": "bewitched", "takenResources": False,
                         "incomeTaken": False, "abilityUsed": False,
                         "spentOnBuild": 0, "usedLab": False, "usedSmithy": False,
                         "usedMuseum": False, "bonusDone": False, "builds": 0}
        self.assertEqual(identities(), [None, "king"])
        state["turn"].update(playerIdx=0, phase="witch_resume")
        self.assertEqual(identities(), [None, "king"], "the Witch is not marked as the victim")
        state["turn"] = None
        state["phase"] = "roundConfirm"
        self.assertEqual(identities(), [None, "king"])
        state["phase"] = "draft"
        self.assertEqual(identities(), [None, None])
        state["phase"] = "action"
        state["effects"]["assassinated"] = 4
        self.assertEqual(identities(), [None, None], "an assassinated role is not taken over")


if __name__ == "__main__":
    unittest.main()
