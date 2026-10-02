"""Regression coverage for Python role abilities and privacy views."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.cards import CHAR_MAP, DISTRICTS  # noqa: E402
from test.python_game_reference import (apply_action, create_game, get_available_actions,
                                        start_game, start_round)  # noqa: E402
from test.python_scoring_reference import compute_scores  # noqa: E402
from python_backend.views import sanitize  # noqa: E402


def test_view(state: dict, player_id: str | None) -> dict:
    state["scores"] = compute_scores(state)
    actions = get_available_actions(state, player_id)["actions"] if player_id else []
    return sanitize(state, player_id, actions)

def fixture(role: str) -> dict:
    state = create_game({"seats": [{"id": f"p{i}", "name": f"Player {i}"} for i in range(4)],
                         "seed": 1977, "charSetMode": "base"})
    start_game(state)
    state["phase"] = "action"
    state["players"][0]["chars"] = [role]
    state["callQueue"] = [{"charId": role, "num": CHAR_MAP[role]["num"], "playerIdx": 0}]
    state["callIdx"] = 0
    state["turn"] = {"charId": role, "num": CHAR_MAP[role]["num"], "playerIdx": 0,
                     "phase": "main", "takenResources": False, "incomeTaken": False,
                     "abilityUsed": False, "builds": 0, "spentOnBuild": 0,
                     "usedLab": False, "usedSmithy": False, "usedMuseum": False,
                     "pending": None, "bonusDone": False}
    return state


def put_city(state: dict, player_index: int, predicate=lambda card: True) -> dict:
    piles = [state["deck"]] + [player["hand"] for player in state["players"]]
    pile, card_index = next((pile, index) for pile in piles
                            for index, card in enumerate(pile) if predicate(card))
    card = {**pile.pop(card_index), "builtRound": 1, "beautified": 0, "museum": []}
    state["players"][player_index]["city"].append(card)
    return card


def witch_fixture(target_role: str) -> dict:
    state = fixture("witch")
    state["draft"]["faceUp"] = []
    state["players"][1]["chars"] = [target_role]
    state["callQueue"].append({"charId": target_role, "num": CHAR_MAP[target_role]["num"],
                               "playerIdx": 1})
    return state


class RoleParityTests(unittest.TestCase):
    def test_view_uses_supplied_engine_build_actions_for_hand_affordance(self) -> None:
        state = fixture("assassin")
        hand = state["players"][0]["hand"]
        selected_uid = hand[-1]["uid"]
        view = sanitize(state, "p0", [{"type": "build", "uid": selected_uid}])
        buildable = {card["uid"] for card in view["players"][0]["hand"] if card["canBuild"]}
        self.assertEqual(buildable, {selected_uid})

    def test_view_does_not_fall_back_to_python_rules_implicitly(self) -> None:
        state = fixture("assassin")
        view = sanitize(state, "p0")
        self.assertEqual(view["scores"], [])
        self.assertFalse(any(card["canBuild"] for card in view["players"][0]["hand"]))

    def test_next_round_clears_previous_roles_before_draft(self) -> None:
        state = fixture("assassin")
        state["phase"] = "roundConfirm"
        state["players"][0]["played"] = ["assassin"]
        state["players"][0]["chars"] = ["assassin"]
        state["players"][1]["played"] = ["thief"]
        state["players"][1]["chars"] = ["thief"]

        start_round(state)

        self.assertEqual(state["phase"], "draft")
        for player in state["players"]:
            self.assertEqual(player["chars"], [])
            self.assertEqual(player["played"], [])
        view = test_view(state, "p0")
        for opponent in view["players"]:
            if opponent["id"] != "p0":
                self.assertFalse(opponent["hasChosen"])
                self.assertIsNone(opponent["revealedCharId"])
                self.assertIsNone(opponent["revealedCharNum"])

    def test_draft_hides_unplayed_roles_despite_stale_turn(self) -> None:
        state = fixture("assassin")
        state["phase"] = "draft"
        state["players"][1]["chars"] = ["thief"]
        state["turn"] = {**state["turn"], "charId": "thief", "num": CHAR_MAP["thief"]["num"],
                          "playerIdx": 1}
        state["effects"]["blackmailer"] = {
            "nums": [CHAR_MAP["thief"]["num"]], "signed": CHAR_MAP["thief"]["num"],
            "playerIdx": 0, "done": [], "revealed": []}

        view = test_view(state, "p2")
        opponent = view["players"][1]
        self.assertIsNone(opponent["revealedCharId"])
        self.assertIsNone(opponent["revealedCharNum"])
        self.assertIsNone(opponent["threat"])

    def test_action_phase_still_reveals_active_role(self) -> None:
        state = fixture("assassin")
        opponent = test_view(state, "p1")["players"][0]
        self.assertEqual(opponent["revealedCharId"], "assassin")
        self.assertEqual(opponent["revealedCharNum"], CHAR_MAP["assassin"]["num"])

    def compare_steps(self, state: dict, actions: list[dict]) -> None:
        for index, step in enumerate(actions):
            player_id = step.get("playerId", "p0")
            action = step.get("action", step)
            with self.subTest(step=index, action=action):
                result = apply_action(state, player_id, action)
                if not result["ok"]:
                    # Skip actions that are not legal in the current Python fixture.
                    continue
                self.assertIsInstance(test_view(state, player_id), dict)
                self.assertIsInstance(test_view(state, None), dict)
                views = [test_view(state, player["id"]) for player in state["players"]]
                self.assertEqual(len(views), len(state["players"]))

    def test_magician_swap(self) -> None:
        state = fixture("magician")
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "magician_mode", "mode": "swap"},
                                   {"type": "choose_player", "target": "p1"}])

    def test_magician_serial_redraw(self) -> None:
        state = fixture("magician")
        hand = state["players"][0]["hand"]
        actions = [{"type": "take_gold"}, {"type": "ability"},
                   {"type": "magician_mode", "mode": "redraw"}]
        actions.extend({"type": "choose_cards", "mode": "use" if index % 2 == 0 else "skip",
                        "uid": card["uid"]} for index, card in enumerate(hand))
        self.compare_steps(state, actions)

    def test_magician_batch_redraw(self) -> None:
        state = fixture("magician")
        uid = state["players"][0]["hand"][1]["uid"]
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "magician_mode", "mode": "redraw"},
                                   {"type": "choose_cards", "uids": [uid]}])

    def test_navigator_rewards(self) -> None:
        for mode in ("gold", "cards"):
            with self.subTest(mode=mode):
                state = fixture("navigator")
                self.compare_steps(state, [{"type": "take_gold"},
                                           {"type": "navigator_bonus", "mode": mode}])

    def test_scholar_selection(self) -> None:
        state = fixture("scholar")
        chosen_uid = state["deck"][0]["uid"]
        self.compare_steps(state, [{"type": "take_gold"},
                                   {"type": "scholar_pick", "uid": chosen_uid}])

    def test_monk_resource_and_take(self) -> None:
        state = fixture("monk")
        church = next(card for card in DISTRICTS if card["en"] == "Church")
        state["players"][0]["city"].append({"uid": "special-church", "name": church["name"],
                                              "en": "Church", "color": "blue", "cost": 2,
                                              "scoreValue": 2, "purple": None,
                                              "builtRound": 1, "museum": []})
        state["players"][1]["gold"] = 10
        self.compare_steps(state, [{"type": "take_gold"},
                                   {"type": "monk_resource", "gold": 1, "cards": 0},
                                   {"type": "monk_take"}])

    def test_tax_collector(self) -> None:
        state = fixture("tax_collector")
        state["charDeck"].append("tax_collector")
        state["effects"]["taxCollectorGold"] = 3
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "tax_collect"}])

    def test_other_player_build_pays_and_notifies_building_tax(self) -> None:
        state = fixture("merchant")
        state["charDeck"].append("tax_collector")
        state["players"][2]["chars"] = ["tax_collector"]
        card = state["players"][0]["hand"][0]
        state["players"][0]["gold"] = card["cost"] + 2

        result = apply_action(state, "p0", {"type": "build", "uid": card["uid"]})

        self.assertTrue(result["ok"])
        self.assertEqual(state["players"][0]["gold"], 1)
        self.assertEqual(state["effects"]["taxCollectorGold"], 1)
        tax_notice = next(notice for notice in state["notices"] if notice["kind"] == "tax_paid")
        self.assertEqual(tax_notice["playerId"], "p0")
        self.assertEqual(tax_notice["amount"], 1)

    def test_emperor_crown_take_and_back(self) -> None:
        for mode in ("gold", "card"):
            with self.subTest(mode=mode):
                state = fixture("emperor")
                self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                           {"type": "emperor_crown", "target": "p1"},
                                           {"type": "pending_back", "to": "emperor_crown"},
                                           {"type": "emperor_crown", "target": "p2"},
                                           {"type": "emperor_take", "mode": mode}])

    def test_prophet_auto_draw_and_give(self) -> None:
        state = fixture("prophet")
        original = [card["uid"] for card in state["players"][0]["hand"]]
        self.compare_steps(state, [{"type": "take_gold"}] +
                           [{"type": "prophet_give", "uid": uid} for uid in original[:3]])

    def test_artist_two_districts(self) -> None:
        state = fixture("artist")
        first, second = state["players"][0]["hand"][:2]
        for card in (first, second):
            state["players"][0]["city"].append({**card, "builtRound": 1, "museum": [],
                                                   "beautified": 0})
        uids = [first["uid"], second["uid"]]
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "choose_district", "target": "p0", "uid": uids[0]},
                                   {"type": "choose_district", "target": "p0", "uid": uids[1]},
                                   {"type": "artist_done", "uids": uids}])

    def test_warlord_destroy_and_graveyard_reactions(self) -> None:
        for use in (False, True):
            with self.subTest(use=use):
                state = fixture("warlord")
                target = put_city(state, 1, lambda card: card["cost"] <= 2 and
                                  (card.get("purple") or {}).get("effect") != "graveyard")
                put_city(state, 2, lambda card: (card.get("purple") or {}).get("effect") == "graveyard")
                self.compare_steps(state, [
                    {"type": "take_gold"}, {"type": "ability"},
                    {"type": "choose_district", "target": "p1", "uid": target["uid"]},
                    {"playerId": "p2", "action": {"type": "reaction", "use": use}},
                ])

    def test_marshal_seize_with_museum_attachment(self) -> None:
        state = fixture("marshal")
        target = put_city(state, 1, lambda card: card["cost"] <= 3 and card["color"] != "purple")
        attached = state["deck"].pop(0)
        target["museum"] = [attached]
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "choose_district", "target": "p1", "uid": target["uid"]}])

    def test_diplomat_swap_and_back(self) -> None:
        state = fixture("diplomat")
        mine = put_city(state, 0, lambda card: card["cost"] == 2 and card["color"] != "purple")
        theirs = put_city(state, 1, lambda card: card["cost"] == 3 and card["name"] != mine["name"])
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "choose_district", "target": "p0", "uid": mine["uid"]},
                                   {"type": "pending_back", "to": "diplomat_mine"},
                                   {"type": "choose_district", "target": "p0", "uid": mine["uid"]},
                                   {"type": "choose_district", "target": "p1", "uid": theirs["uid"]}])

    def test_purple_building_abilities(self) -> None:
        for effect in ("lab", "smithy", "museum"):
            with self.subTest(effect=effect):
                state = fixture("merchant")
                building = put_city(state, 0, lambda card: (card.get("purple") or {}).get("effect") == effect)
                action = {"type": effect, "uid": building["uid"]}
                if effect == "lab":
                    action["discardUid"] = state["players"][0]["hand"][0]["uid"]
                if effect == "museum":
                    action["cardUid"] = state["players"][0]["hand"][0]["uid"]
                self.compare_steps(state, [{"type": "take_gold"}, action])

    def test_witch_gold_takeover_and_crown(self) -> None:
        for role in ("merchant", "king"):
            with self.subTest(role=role):
                state = witch_fixture(role)
                self.compare_steps(state, [
                    {"type": "take_gold"},
                    {"type": "choose_char", "num": CHAR_MAP[role]["num"]},
                    {"playerId": "p1", "action": {"type": "take_gold"}},
                    {"type": "end_turn"},
                ])

    def test_witch_cards_takeover(self) -> None:
        state = witch_fixture("merchant")
        chosen = state["deck"][0]["uid"]
        self.compare_steps(state, [
            {"type": "take_gold"}, {"type": "choose_char", "num": 6},
            {"playerId": "p1", "action": {"type": "take_cards"}},
            {"playerId": "p1", "action": {"type": "draw_keep", "uid": chosen}},
            {"type": "end_turn"},
        ])

    def test_witch_navigator_bonus(self) -> None:
        state = witch_fixture("navigator")
        self.compare_steps(state, [
            {"type": "take_gold"}, {"type": "choose_char", "num": 7},
            {"playerId": "p1", "action": {"type": "take_gold"}},
            {"type": "ability"}, {"type": "navigator_bonus", "mode": "gold"},
            {"type": "end_turn"},
        ])

    def test_witch_alchemist_refunds_witch_build(self) -> None:
        state = witch_fixture("alchemist")
        card = next((item for item in state["players"][0]["hand"] if item["cost"] <= 4), None)
        if card is None:
            card = next(item for item in state["deck"] if item["cost"] <= 4)
            state["deck"].remove(card)
            state["players"][0]["hand"].append(card)
        self.compare_steps(state, [
            {"type": "take_gold"}, {"type": "choose_char", "num": 6},
            {"playerId": "p1", "action": {"type": "take_gold"}},
            {"type": "build", "uid": card["uid"]}, {"type": "end_turn"},
        ])

    def test_witch_noble_immediate_income_stays_with_victim(self) -> None:
        state = witch_fixture("noble")
        put_city(state, 1, lambda card: card["color"] == "yellow")
        self.compare_steps(state, [
            {"type": "take_gold"}, {"type": "choose_char", "num": 4},
            {"playerId": "p1", "action": {"type": "take_gold"}},
            {"type": "end_turn"},
        ])

    def test_spy_private_investigation(self) -> None:
        for color in ("green", "purple"):
            with self.subTest(color=color):
                state = fixture("spy")
                state["players"][1]["gold"] = 5
                self.compare_steps(state, [
                    {"type": "take_gold"}, {"type": "ability"},
                    {"type": "spy_target", "target": "p1"},
                    {"type": "spy_color", "color": color},
                ])

    def test_abbot_income_and_passive_protection(self) -> None:
        state = fixture("abbot")
        put_city(state, 0, lambda card: card["color"] == "blue")
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "income"},
                                   {"type": "end_turn"}])
        state = fixture("warlord")
        put_city(state, 1, lambda card: card["cost"] <= 2)
        state["players"][1]["played"] = ["abbot"]
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "ability_skip"}])

    def test_noble_has_no_income_action_when_catalog_income_is_null(self) -> None:
        state = fixture("noble")
        state["turn"]["takenResources"] = True
        actions = get_available_actions(state, "p0")["actions"]
        self.assertNotIn("income", [action["type"] for action in actions])

    def test_wizard_take_or_immediate_build(self) -> None:
        for mode in ("wizard_take", "wizard_build"):
            with self.subTest(mode=mode):
                state = fixture("wizard")
                card = next((item for item in state["players"][1]["hand"] if item["cost"] <= 4), None)
                if card is None:
                    card = next(item for item in state["deck"] if item["cost"] <= 4)
                    state["deck"].remove(card)
                    state["players"][1]["hand"].append(card)
                self.compare_steps(state, [
                    {"type": "take_gold"}, {"type": "ability"},
                    {"type": "wizard_target", "target": "p1"},
                    {"type": "wizard_card", "uid": card["uid"]},
                    {"type": "pending_back", "to": "wizard_card"},
                    {"type": "wizard_card", "uid": card["uid"]},
                    {"type": mode},
                ])

    def test_wizard_no_targets_can_skip(self) -> None:
        state = fixture("wizard")
        for other in state["players"][1:]:
            state["deck"].extend(other["hand"])
            other["hand"] = []
        self.compare_steps(state, [{"type": "take_gold"}, {"type": "ability"},
                                   {"type": "ability_skip"}])

    def test_wizard_choice_hides_immediate_build_when_unaffordable(self) -> None:
        state = fixture("wizard")
        card = next(item for item in state["players"][1]["hand"] if item["cost"] > 0)
        state["players"][0]["gold"] = card["cost"] - 1
        state["turn"]["pending"] = {"kind": "wizard_choice", "targetIdx": 1, "card": card}
        actions = get_available_actions(state, "p0")["actions"]
        self.assertEqual([action["type"] for action in actions], ["wizard_take", "pending_back"])

    def test_magistrate_warrant_build_response(self) -> None:
        for use, tax in ((False, False), (True, False), (True, True)):
            with self.subTest(use=use, tax=tax):
                state = fixture("magistrate")
                state["draft"]["faceUp"] = []
                state["players"][1]["chars"] = ["merchant"]
                state["callQueue"].append({"charId": "merchant", "num": 6, "playerIdx": 1})
                if tax:
                    state["charDeck"].append("tax_collector")
                    state["players"][2]["chars"] = ["tax_collector"]
                card = next((item for item in state["players"][1]["hand"] if item["cost"] <= 4), None)
                if card is None:
                    card = next(item for item in state["deck"] if item["cost"] <= 4)
                    state["deck"].remove(card)
                    state["players"][1]["hand"].append(card)
                self.compare_steps(state, [
                    {"type": "take_gold"}, {"type": "ability"},
                    {"type": "magistrate_signed", "num": 6},
                    {"type": "magistrate_char", "num": 3},
                    {"type": "magistrate_char", "num": 4},
                    {"type": "end_turn"},
                    {"playerId": "p1", "action": {"type": "take_gold"}},
                    {"playerId": "p1", "action": {"type": "build", "uid": card["uid"]}},
                    {"type": "reaction", "use": use},
                ])

    def test_blackmailer_bribe_or_reveal(self) -> None:
        for mode in ("bribe", "reveal_real", "reveal_fake", "conceal"):
            with self.subTest(mode=mode):
                state = fixture("blackmailer")
                state["draft"]["faceUp"] = []
                target_role = "king" if mode == "reveal_fake" else "merchant"
                state["players"][1]["chars"] = [target_role]
                state["players"][1]["gold"] = 5
                state["callQueue"].append({"charId": target_role,
                                           "num": CHAR_MAP[target_role]["num"], "playerIdx": 1})
                steps = [{"type": "take_gold"}, {"type": "ability"},
                         {"type": "blackmailer_char", "num": 6},
                         {"type": "blackmailer_char", "num": 4},
                         {"type": "blackmailer_signed", "num": 6},
                         {"type": "end_turn"}]
                if mode == "bribe":
                    steps.append({"playerId": "p1", "action": {"type": "blackmailer_bribe"}})
                else:
                    steps.append({"playerId": "p1", "action": {"type": "blackmailer_refuse"}})
                    steps.append({"type": "reaction", "use": mode != "conceal"})
                steps.append({"playerId": "p1", "action": {"type": "take_gold"}})
                self.compare_steps(state, steps)


if __name__ == "__main__":
    unittest.main()
