"""Transport-level checks: real HTTP requests and masked WebSocket frames."""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import os
import struct
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from python_backend.server import (Client, PythonServer, _encoding_compatible, _static_path,
                                   parse_server_args)  # noqa: E402
from python_backend import cards  # noqa: E402
from python_backend.views import _removed_view  # noqa: E402
from python_backend.rooms import RoomRegistry  # noqa: E402
from test.python_game_reference import (apply_action, create_game, get_available_actions,
                                        start_game)  # noqa: E402
from python_backend.training_runtime import TrainingManager  # noqa: E402
from python_backend.voice import VoiceService  # noqa: E402
from python_backend.codex_gateway import CodexGateway  # noqa: E402


class _ReferenceRulesWorker:
    """Test double for the C++ worker API, backed by the test reference rules."""

    def __init__(self):
        self.npc_decisions = 0
        self.games = {}

    def create_game(self, new_game: dict, game_id: str | None = None) -> dict:
        state = create_game({key: new_game[key] for key in
                             ("seed", "endDistricts", "charSetMode", "seats")})
        result = start_game(state)
        if not result.get("ok"):
            raise ValueError(result.get("error"))
        if game_id:
            self.games[game_id] = state
        return state

    def _state(self, game_id=None, state=None):
        return state if state is not None else self.games[game_id]

    def current(self, game_id: str) -> dict:
        state = self.games[game_id]
        if state["phase"] == "draft":
            actor = state["players"][state["draft"]["steps"][state["draft"]["stepIdx"]]["player"]]["id"]
        elif state["phase"] == "action":
            actor = state["players"][state["turn"]["playerIdx"]]["id"]
        else:
            actor = None
        return {"playerId": actor, "gameOver": state["phase"] == "gameover", "rewards": []}

    def close_game(self, game_id: str) -> None:
        self.games.pop(game_id, None)

    def legal_actions(self, *, player_id: str, state: dict | None = None, game_id: str | None = None) -> dict:
        state = self._state(game_id, state)
        result = get_available_actions(state, player_id)
        return {"phase": state["phase"], **result}

    def decide_npc(self, *, player_id: str, seed: int = 1, state: dict | None = None,
                   game_id: str | None = None, heuristic_mcts: dict | None = None) -> dict | None:
        state = self._state(game_id, state)
        del seed, heuristic_mcts
        if self.npc_decisions >= 2:
            return None
        self.npc_decisions += 1
        actions = get_available_actions(state, player_id).get("actions") or []
        return actions[0] if actions else None

    def apply(self, *, player_id: str, action: dict, state: dict | None = None,
              game_id: str | None = None) -> dict:
        state = self._state(game_id, state)
        result = apply_action(state, player_id, action)
        if not result.get("ok"):
            raise ValueError(result.get("error"))
        return state


class _ReferenceWorkerManager:
    running = True

    def __init__(self):
        self.worker = _ReferenceRulesWorker()
        self.game_worker = self.worker


def _start_reference_room(rooms: RoomRegistry, room_id: str, game_worker=None) -> dict:
    room, seats = rooms.prepare_start_room(room_id)
    state = _ReferenceRulesWorker().create_game({
        "seed": room["config"].get("seed", 71),
        "endDistricts": room["config"]["endDistricts"],
        "charSetMode": room["config"]["charSetMode"], "seats": seats})
    state.update({"roomId": room_id, "config": room["config"], "createdAt": 0,
                  "log": [], "notices": [], "noticeSeq": 0, "witchResume": None})
    if game_worker is not None:
        game_worker.games[room_id] = state
    return rooms.finish_start_room(room_id, state)


class ServerArgumentTests(unittest.TestCase):
    def test_removed_roles_remain_visible_after_draft_phase(self):
        state = {"draft": None,
                 "draftPublic": {"faceUp": ["assassin", "thief"], "faceDownCount": 1}}
        self.assertEqual(_removed_view(state), {
            "faceUp": [{"id": "assassin", "num": 1, "name": "刺客"},
                       {"id": "thief", "num": 2, "name": "盗贼"}],
            "faceDownCount": 1,
        })

    def test_checkpoint_encoding_compatibility_matches_entity_v6_contract(self) -> None:
        self.assertTrue(_encoding_compatible(14, 9))
        self.assertFalse(_encoding_compatible(12, 9))
        self.assertFalse(_encoding_compatible(11, 8))
        self.assertFalse(_encoding_compatible(14, 8))

    def test_native_action_labels_distinguish_character_choices(self) -> None:
        state = {"players": [
            {"id": "p1", "name": "甲", "seat": 0, "hand": [], "city": []},
            {"id": "p2", "name": "乙", "seat": 1, "hand": [], "city": []},
        ]}
        target_labels = [PythonServer._native_action_view(state, {
            "type": "choose_player", "target": player_id,
        })["label"] for player_id in ("p1", "p2")]
        self.assertEqual(target_labels, ["座位 1 · 甲", "座位 2 · 乙"])

        role_labels = [PythonServer._native_action_view(state, {
            "type": "magistrate_char", "num": number,
        })["label"] for number in (1, 2, 3)]
        self.assertEqual(len(set(role_labels)), 3)
        self.assertTrue(all(label.startswith("逮捕令候选 · ") for label in role_labels))

    def test_native_action_labels_distinguish_other_role_effect_options(self) -> None:
        state = {"players": [
            {"id": "p1", "name": "甲", "seat": 0, "hand": [], "city": []},
            {"id": "p2", "name": "乙", "seat": 1, "hand": [], "city": []},
        ]}
        labels = [PythonServer._native_action_view(state, action)["label"] for action in (
            {"type": "spy_color", "color": "blue"},
            {"type": "spy_color", "color": "red"},
            {"type": "abbot_resource", "gold": 0, "cards": 2},
            {"type": "abbot_resource", "gold": 1, "cards": 1},
            {"type": "navigator_bonus", "name": "gold"},
            {"type": "navigator_bonus", "name": "cards"},
            {"type": "choose_cards", "mode": "skip"},
            {"type": "choose_cards", "mode": "use"},
        )]
        self.assertEqual(labels, ["蓝色", "红色", "金币 0 · 建筑牌 2", "金币 1 · 建筑牌 1",
                                  "拿取金币（4 枚）", "抽取建筑牌（4 张）",
                                  "保留这张手牌", "弃掉这张手牌"])

    def test_resource_and_build_actions_show_quantities(self) -> None:
        state = {"turn": {"playerIdx": 0, "charId": "merchant", "phase": "main"},
                 "players": [{"id": "p1", "name": "甲", "seat": 0,
                              "hand": [{"uid": "h1", "name": "灯塔", "cost": 4}],
                              "city": [{"uid": "c1", "name": "观测台", "color": "purple",
                                        "cost": 5, "purpleEffect": "draw3keep1"}]}]}
        labels = [PythonServer._native_action_view(state, action)["label"] for action in (
            {"type": "take_gold"}, {"type": "take_cards"},
            {"type": "build", "uid": "h1", "name": "灯塔"},
        )]
        self.assertEqual(labels, ["拿取金币（3 枚）", "抽取建筑牌（3 张，保留1张，另得1金币）",
                                  "建造『灯塔』（造价 4 金币）"])

    def test_income_and_navigator_bonus_show_exact_amounts(self) -> None:
        state = {"turn": {"playerIdx": 0, "charId": "bishop", "phase": "main"},
                 "players": [{"id": "p1", "name": "甲", "seat": 0, "hand": [],
                              "city": [{"uid": "c1", "color": "blue"},
                                       {"uid": "c2", "color": "purple", "purpleEffect": "anyColorIncome"}]}]}
        self.assertEqual(PythonServer._native_action_view(state, {"type": "income"})["label"],
                         "领取收入（抽取 2 张建筑牌）")
        self.assertEqual(PythonServer._native_action_view(state, {
            "type": "navigator_bonus", "name": "cards"})["label"], "抽取建筑牌（4 张）")

    def test_battle_report_uses_readable_text_without_revealing_hidden_choices(self) -> None:
        state = {"turn": {"charId": "wizard", "charName": "法师",
                          "pending": {"kind": "wizard_target"}},
                 "players": [{"id": "p1", "name": "甲", "seat": 0,
                              "hand": [{"uid": "secret", "name": "秘密建筑", "cost": 6}],
                              "city": []}]}
        self.assertEqual(PythonServer._game_action_log_text(state, {"type": "take_gold"}),
                         "拿取金币（2 枚）")
        self.assertEqual(PythonServer._game_action_log_text(state, {"type": "wizard_target", "target": "p1"}),
                         "法师选择查看座位1·甲的手牌（牌面不公开）")
        self.assertEqual(PythonServer._game_action_log_text(state, {
            "type": "magistrate_signed", "num": 8}), "布置了行政官逮捕令")
        ability_state = {"turn": {"charId": "wizard", "charName": "法师"}}
        self.assertIn("发动了【法师】能力：查看一位玩家的手牌",
                      PythonServer._game_action_log_text(ability_state, {"type": "ability"}))
        assassin_log = PythonServer._game_action_log_text(
            {"turn": {}}, {"type": "assassin_declare", "num": 7})
        self.assertIn("宣布刺杀7号·建筑师", assassin_log)
        self.assertIn("跳过整个回合", assassin_log)
        self.assertNotIn("秘密建筑", PythonServer._game_action_log_text(state, {
            "type": "wizard_card", "uid": "secret"}))

    def test_tax_collector_report_shows_exact_collected_building_tax(self) -> None:
        state = {"effects": {"taxCollectorGold": 7},
                 "turn": {"charId": "tax_collector", "pending": {"kind": "tax_collect"}}}
        self.assertEqual(PythonServer._game_action_log_text(state, {"type": "tax_collect"}),
                         "税务官收取了7枚建筑税")

    def test_role_ability_notice_restores_public_popup_payload(self) -> None:
        previous = {"noticeSeq": 2, "notices": [], "turn": {"charId": "merchant"},
                    "players": [{"id": "p1", "name": "甲"}]}
        updated = {"noticeSeq": 2, "notices": [], "players": [{"id": "p1", "name": "甲"}]}
        PythonServer._append_role_ability_notice(previous, updated, "p1", {"type": "ability"})
        self.assertEqual(updated["noticeSeq"], 3)
        notice = updated["notices"][-1]
        self.assertEqual((notice["kind"], notice["roleName"], notice["playerName"]),
                         ("role_effect", "商人", "甲"))
        self.assertTrue(notice["description"])

    def test_magistrate_declaration_announces_public_targets_but_hides_real_mark(self) -> None:
        previous = {
            "noticeSeq": 4, "notices": [],
            "charDeck": ["witch", "prophet", "monk"],
            "players": [{"id": "p1", "name": "甲"}],
            "turn": {"charId": "magistrate"},
            "effects": {"magistrate": None},
        }
        updated = {
            "noticeSeq": 4, "notices": [],
            "charDeck": ["witch", "prophet", "monk"],
            "players": [{"id": "p1", "name": "甲"}],
            "effects": {"magistrate": {"nums": [5, 1, 3], "signed": 3,
                                        "playerIdx": 0, "claimed": False}},
        }
        action = {"type": "magistrate_char", "num": 5}
        PythonServer._append_magistrate_declare_notice(previous, updated, "p1", action)

        self.assertEqual(updated["noticeSeq"], 5)
        notice = updated["notices"][-1]
        self.assertEqual(notice["kind"], "magistrate_declare")
        self.assertEqual([target["num"] for target in notice["targets"]], [1, 3, 5])
        self.assertNotIn("signed", notice)
        log = PythonServer._game_action_log_text(previous, action, updated)
        self.assertIn("布置了逮捕令", log)
        self.assertIn("真逮捕令的目标暂不公开", log)
        self.assertLess(log.index("1号·"), log.index("3号·"))
        self.assertLess(log.index("3号·"), log.index("5号·"))
        self.assertEqual([target["name"] for target in notice["targets"]],
                         [cards.CHAR_MAP[role_id]["name"]
                          for role_id in ("witch", "prophet", "monk")])
        for target in notice["targets"]:
            self.assertIn(target["name"], log)

    def test_role_names_follow_the_current_games_character_deck(self) -> None:
        state = {"charDeck": ["alchemist"], "players": [], "turn": {}}
        expected = cards.CHAR_MAP["alchemist"]["name"]

        self.assertEqual(PythonServer._character_for_number(state, 6)["name"], expected)
        action_view = PythonServer._native_action_view(
            state, {"type": "choose_char", "num": 6})
        self.assertIn(expected, action_view["label"])
        self.assertNotIn(cards.CHAR_MAP["merchant"]["name"], action_view["label"])
        self.assertEqual(PythonServer._magistrate_targets([6], state)[0]["name"], expected)
        log = PythonServer._game_action_log_text(
            state, {"type": "assassin_declare", "num": 6})
        self.assertIn(f"6号·{expected}", log)

    def test_magistrate_notice_waits_until_all_three_targets_are_committed(self) -> None:
        previous = {"noticeSeq": 0, "notices": [], "players": [{"id": "p1"}],
                    "effects": {"magistrate": None}}
        updated = {"noticeSeq": 0, "notices": [], "players": [{"id": "p1"}],
                   "effects": {"magistrate": None}}
        PythonServer._append_magistrate_declare_notice(
            previous, updated, "p1", {"type": "magistrate_char", "num": 5})
        self.assertEqual(updated["notices"], [])

    def test_spy_report_and_popup_include_target_type_and_actual_gains(self) -> None:
        previous = {
            "noticeSeq": 0, "notices": [],
            "turn": {"charId": "spy", "playerIdx": 1,
                     "pending": {"kind": "spy_color", "targetIdx": 0}},
            "players": [
                {"id": "p1", "name": "甲", "seat": 0, "gold": 3, "hand": []},
                {"id": "p2", "name": "乙", "seat": 1, "gold": 1, "hand": []},
            ],
        }
        updated = {
            "noticeSeq": 0, "notices": [],
            "players": [
                {"id": "p1", "name": "甲", "seat": 0, "gold": 1, "hand": []},
                {"id": "p2", "name": "乙", "seat": 1, "gold": 3,
                 "hand": [{"uid": "hidden", "name": "秘密建筑"}]},
            ],
        }
        action = {"type": "spy_color", "color": "green"}
        log = PythonServer._game_action_log_text(previous, action, updated)
        self.assertIn("间谍调查座位1·甲的商业（绿色）建筑牌", log)
        self.assertIn("实际获得2枚金币、1张建筑牌", log)
        self.assertNotIn("秘密建筑", log)
        PythonServer._append_role_effect_detail_notice(previous, updated, "p2", action)
        notice = updated["notices"][-1]
        self.assertEqual(notice["kind"], "role_effect_detail")
        self.assertIn("调查对象：座位1·甲", notice["description"])
        self.assertIn("商业（绿色）", notice["description"])
        self.assertIn("2 枚金币和 1 张建筑牌", notice["description"])
        self.assertNotIn("秘密建筑", notice["description"])

    def test_emperor_report_and_popup_name_crown_recipient_and_taken_resource(self) -> None:
        state = {"turn": {"charId": "emperor", "playerIdx": 0},
                 "players": [{"id": "p1", "name": "皇帝玩家", "seat": 0},
                             {"id": "p2", "name": "电脑1", "seat": 1}]}
        action = {"type": "emperor_crown", "target": "p2"}
        self.assertEqual(PythonServer._game_action_log_text(state, action),
                         "皇帝将皇冠交给座位2·电脑1")
        updated = {"noticeSeq": 0, "notices": [], "players": state["players"]}
        PythonServer._append_role_effect_detail_notice(state, updated, "p1", action)
        self.assertIn("皇冠移交对象：座位2·电脑1", updated["notices"][-1]["description"])

        take_state = {**state, "turn": {"charId": "emperor", "playerIdx": 0,
                                         "pending": {"kind": "emperor_take", "targetIdx": 1}}}
        self.assertEqual(PythonServer._game_action_log_text(
            take_state, {"type": "emperor_take", "mode": "gold"}),
            "皇帝从新皇冠持有者座位2·电脑1处取得1枚金币")

    def test_emperor_crown_action_emits_transfer_animation_notice(self) -> None:
        previous = {
            "noticeSeq": 3, "notices": [],
            "turn": {"charId": "emperor", "playerIdx": 0},
            "players": [{"id": "emperor", "hasCrown": True},
                        {"id": "target", "hasCrown": False}],
        }
        updated = {"noticeSeq": 3, "notices": [],
                   "players": [{"id": "emperor", "hasCrown": False},
                               {"id": "target", "hasCrown": True}]}
        PythonServer._append_crown_transfer_notice(
            previous, updated, {"type": "emperor_crown", "target": "target"})
        self.assertEqual(updated["notices"], [{"seq": 4, "kind": "crown_transfer",
                                                 "fromIdx": 0, "toIdx": 1}])

    def test_targeted_building_effect_logs_player_and_building(self) -> None:
        state = {"turn": {"charId": "warlord", "playerIdx": 0,
                          "pending": {"kind": "warlord_destroy"}},
                 "players": [{"id": "p1", "name": "甲", "seat": 0, "city": []},
                             {"id": "p2", "name": "乙", "seat": 1, "city": [
                                 {"uid": "c1", "name": "战场", "cost": 3}]}]}
        action = {"type": "choose_district", "target": "p2", "uid": "c1"}
        self.assertEqual(PythonServer._game_action_log_text(state, action),
                         "领主摧毁了座位2·乙的建筑『战场』")

    def test_marshal_seize_emits_building_transfer_notice(self) -> None:
        previous = {
            "noticeSeq": 6, "notices": [],
            "turn": {"charId": "marshal", "playerIdx": 0,
                     "pending": {"kind": "marshal_seize"}},
            "players": [
                {"id": "marshal", "name": "元帅玩家", "city": []},
                {"id": "victim", "name": "目标玩家", "city": [
                    {"uid": "district-1", "name": "战场", "cost": 3}]}],
        }
        updated = {
            "noticeSeq": 6, "notices": [],
            "players": [
                {"id": "marshal", "name": "元帅玩家", "city": [
                    {"uid": "district-1", "name": "战场", "cost": 3}]},
                {"id": "victim", "name": "目标玩家", "city": []}],
        }
        PythonServer._append_marshal_seize_notice(
            previous, updated, {"type": "choose_district", "target": "victim", "uid": "district-1"})
        self.assertEqual(updated["notices"], [{
            "seq": 7, "kind": "seized", "playerIdx": 1, "byIdx": 0,
            "playerId": "victim", "byId": "marshal",
            "playerName": "目标玩家", "byName": "元帅玩家",
            "cardUid": "district-1", "cardName": "战场", "cost": 3,
        }])

    def test_magistrate_confiscation_emits_transfer_notice_and_detailed_log(self) -> None:
        card = {"uid": "district-2", "name": "钟楼", "cost": 4, "color": "purple"}
        previous = {
            "noticeSeq": 9, "notices": [],
            "reaction": {"kind": "magistrate", "playerIdx": 0},
            "players": [
                {"id": "magistrate", "name": "行政官甲", "seat": 0, "city": []},
                {"id": "builder", "name": "建造者乙", "seat": 1, "city": [card]},
            ],
        }
        updated = {
            "noticeSeq": 9, "notices": [],
            "reaction": None,
            "players": [
                {"id": "magistrate", "name": "行政官甲", "seat": 0, "city": [card]},
                {"id": "builder", "name": "建造者乙", "seat": 1, "city": []},
            ],
        }
        action = {"type": "reaction", "name": "use"}

        PythonServer._append_magistrate_confiscate_notice(previous, updated, action)
        log = PythonServer._game_action_log_text(previous, action, updated)

        self.assertEqual(updated["notices"], [{
            "seq": 10, "kind": "magistrate_confiscate", "playerIdx": 1, "byIdx": 0,
            "playerId": "builder", "byId": "magistrate",
            "playerName": "建造者乙", "byName": "行政官甲",
            "cardUid": "district-2", "card": card,
        }])
        self.assertIn("建造者乙", log)
        self.assertIn("钟楼", log)
        self.assertIn("4枚建造金币已退还", log)

    def test_assassin_thief_and_witch_character_choices_emit_target_popups(self) -> None:
        cases = [
            ("assassin", "刺客", "宣布刺杀", "跳过整个回合"),
            ("thief", "盗贼", "宣布偷窃", "交出全部金币"),
            ("witch_target", "女巫", "施咒", "接管剩余行动"),
        ]
        for pending_kind, role_name, target_phrase, effect_phrase in cases:
            with self.subTest(pending=pending_kind):
                previous = {
                    "noticeSeq": 0, "notices": [],
                    "turn": {"charId": role_name, "playerIdx": 0,
                             "pending": {"kind": pending_kind}},
                    "players": [{"id": "p1", "name": "甲", "seat": 0}],
                }
                updated = {"noticeSeq": 0, "notices": [],
                           "players": [{"id": "p1", "name": "甲", "seat": 0}]}
                action = {"type": "choose_char", "num": 7}
                PythonServer._append_role_effect_detail_notice(previous, updated, "p1", action)
                notice = updated["notices"][-1]
                self.assertEqual(notice["kind"], "role_effect_detail")
                self.assertEqual(notice["roleName"], role_name)
                self.assertIn("7号", notice["description"])
                self.assertIn(effect_phrase, notice["description"])
                log = PythonServer._game_action_log_text(previous, action)
                self.assertIn(target_phrase, log)
                self.assertIn("7号", log)

    def test_blackmailer_reveal_notifies_marked_player_for_real_and_fake_marks(self) -> None:
        def states(signed: int, victim_gold: int, blackmailer_gold: int) -> tuple[dict, dict]:
            previous = {
                "noticeSeq": 4, "notices": [],
                "turn": {"charId": "king", "playerIdx": 1,
                         "pending": {"kind": "blackmailer_threat", "first": 4,
                                     "signed": signed}},
                "reaction": {"kind": "blackmailer", "playerIdx": 0},
                "players": [
                    {"id": "b", "name": "勒索者", "gold": blackmailer_gold},
                    {"id": "v", "name": "被标记玩家", "gold": victim_gold},
                ],
            }
            updated = {"noticeSeq": 4, "notices": [],
                       "players": [
                           {"id": "b", "name": "勒索者", "gold": blackmailer_gold +
                            (victim_gold if signed else 0)},
                           {"id": "v", "name": "被标记玩家", "gold": 0 if signed else victim_gold},
                       ]}
            return previous, updated

        for signed, victim_gold, blackmailer_gold, expected_real, expected_amount in (
                (1, 5, 2, True, 5), (0, 5, 2, False, 0)):
            with self.subTest(signed=signed):
                previous, updated = states(signed, victim_gold, blackmailer_gold)
                PythonServer._append_blackmailer_reveal_notice(
                    previous, updated, {"type": "reaction", "name": "use"})
                notice = updated["notices"][0]
                self.assertEqual(notice["kind"], "blackmailer_reveal")
                self.assertEqual(notice["playerId"], "v")
                self.assertEqual(notice["byId"], "b")
                self.assertTrue(notice["revealed"])
                self.assertEqual(notice["isReal"], expected_real)
                self.assertEqual(notice["amount"], expected_amount)

        previous, updated = states(1, 5, 2)
        updated["players"][0]["gold"] = 2
        updated["players"][1]["gold"] = 5
        PythonServer._append_blackmailer_reveal_notice(
            previous, updated, {"type": "reaction", "name": "skip"})
        notice = updated["notices"][0]
        self.assertFalse(notice["revealed"])
        self.assertNotIn("isReal", notice)

    def test_called_assassinated_and_stolen_roles_are_reported_when_resolved(self) -> None:
        previous = {
            "callIdx": 0,
            "callQueue": [
                {"num": 2, "charId": "thief", "playerIdx": 0},
                {"num": 4, "charId": "king", "playerIdx": 1},
                {"num": 7, "charId": "architect", "playerIdx": 2},
            ],
            "effects": {"assassinated": 7, "thief": 4, "thiefBy": 0},
            "players": [{"name": "甲", "gold": 2}, {"name": "乙", "gold": 5},
                        {"name": "丙", "gold": 4}],
        }
        updated = {"callIdx": 3, "players": [{"name": "甲", "gold": 7},
                                             {"name": "乙", "gold": 0},
                                             {"name": "丙", "gold": 4}]}
        entries = PythonServer._turn_effect_log_entries(previous, updated)
        self.assertEqual(len(entries), 2)
        self.assertIn("交出全部 5 枚金币，转给甲", entries[0][1])
        self.assertEqual(entries[1][0], "丙")
        self.assertIn("7号【建筑师】被叫到，跳过本轮", entries[1][1])

    def test_gain_notices_restore_coin_and_hand_animations(self) -> None:
        previous = {"noticeSeq": 4, "notices": [], "players": [
            {"gold": 5, "hand": [{"uid": "a"}, {"uid": "b"}]},
            {"gold": 2, "hand": [{"uid": "c"}]},
        ]}
        updated = {"players": [
            {"gold": 4, "hand": [{"uid": "a"}]},
            {"gold": 4, "hand": [{"uid": "c"}, {"uid": "d"}, {"uid": "e"}]},
        ]}
        PythonServer._append_gain_notices(previous, updated, {"type": "choose_cards"})
        self.assertEqual(updated["noticeSeq"], 6)
        self.assertEqual(updated["notices"], [
            {"seq": 5, "kind": "got_gold", "playerIdx": 1, "amount": 2, "fromIdx": 0},
            {"seq": 6, "kind": "hand_gain", "playerIdx": 1, "amount": 2, "fromIdx": 0,
             "why": "获得手牌"},
        ])

    def test_magician_redraw_animates_replacement_cards(self) -> None:
        previous = {"players": [{"gold": 2, "hand": [{"uid": "a"}, {"uid": "b"}]}],
                    "turn": {"playerIdx": 0,
                             "pending": {"kind": "magician_redraw", "selected": ["a"]}}}
        updated = {"players": [{"gold": 2, "hand": [{"uid": "b"}, {"uid": "c"}]}],
                   "turn": {"playerIdx": 0, "pending": None}}
        PythonServer._append_gain_notices(previous, updated,
                                          {"type": "choose_cards", "mode": "use"})
        self.assertEqual(updated["notices"][0]["kind"], "hand_gain")
        self.assertEqual(updated["notices"][0]["amount"], 2)

    def test_prophet_collect_notice_tracks_each_opponent_as_card_source(self) -> None:
        previous = {
            "noticeSeq": 3, "notices": [],
            "turn": {"charId": "prophet", "playerIdx": 0, "pending": None},
            "players": [
                {"hand": []}, {"hand": [{"uid": "a"}]},
                {"hand": [{"uid": "b"}, {"uid": "c"}]},
            ],
        }
        updated = {"players": [
            {"hand": [{"uid": "a", "from": 1}, {"uid": "b", "from": 2}]},
            {"hand": []}, {"hand": [{"uid": "c"}]},
        ]}

        PythonServer._append_gain_notices(previous, updated, {"type": "ability"})

        self.assertEqual(updated["notices"], [{"seq": 4, "kind": "prophet_collect",
                                                "fromIdxs": [1, 2], "toIdx": 0}])

    def test_prophet_return_notice_identifies_recipient_without_generic_gain(self) -> None:
        previous = {
            "noticeSeq": 8, "notices": [],
            "turn": {"charId": "prophet", "playerIdx": 0,
                     "pending": {"kind": "prophet_give", "targetIdx": 1}},
            "players": [
                {"id": "p0", "name": "预言家玩家", "hand": [{"uid": "taken"}]},
                {"id": "p1", "name": "收到牌的玩家", "hand": []},
            ],
        }
        updated = {"players": [
            {"id": "p0", "name": "预言家玩家", "hand": []},
            {"id": "p1", "name": "收到牌的玩家", "hand": [{"uid": "taken"}]},
        ]}

        PythonServer._append_gain_notices(previous, updated, {"type": "prophet_give"})

        self.assertEqual(updated["notices"], [{
            "seq": 9, "kind": "prophet_return", "fromIdx": 0, "toIdx": 1,
            "byIdx": 0, "playerIdx": 1, "byId": "p0", "playerId": "p1",
            "byName": "预言家玩家", "playerName": "收到牌的玩家", "amount": 1,
        }])

    def test_deployment_environment_defaults_and_cli_precedence(self) -> None:
        with mock.patch.dict(os.environ, {"PORT": "9123", "HOST": "0.0.0.0",
                                          "CITADELS_HOST": "192.0.2.10"}, clear=True):
            args = parse_server_args([])
            self.assertEqual((args.host, args.port), ("192.0.2.10", 9123))
            args = parse_server_args(["9456", "--host", "127.0.0.1"])
            self.assertEqual((args.host, args.port), ("127.0.0.1", 9456))

    def test_default_remains_loopback_and_invalid_port_is_rejected(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual((parse_server_args([]).host, parse_server_args([]).port),
                             ("127.0.0.1", 8788))
            self.assertFalse(parse_server_args([]).skip_neural_policy)
            self.assertTrue(parse_server_args(["--skip-neural-policy"]).skip_neural_policy)
            with self.assertRaises(SystemExit):
                parse_server_args(["70000"])


async def _request(port: int, path: str, method: str = "GET", body: bytes = b"",
                   extra_headers: dict[str, str] | None = None,
                   content_type: str = "application/gzip",
                   response_headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    headers = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
    headers += "".join(f"{key}: {value}\r\n" for key, value in (extra_headers or {}).items())
    if body:
        headers += f"Content-Length: {len(body)}\r\nContent-Type: {content_type}\r\n"
    writer.write(headers.encode("ascii") + b"\r\n" + body)
    await writer.drain()
    raw = await reader.read()
    writer.close()
    await writer.wait_closed()
    header, body = raw.split(b"\r\n\r\n", 1)
    if response_headers is not None:
        for line in header.split(b"\r\n")[1:]:
            if b":" in line:
                key, value = line.split(b":", 1)
                response_headers[key.decode("ascii").lower()] = value.decode("latin-1").strip()
    return int(header.split(b" ")[1]), body


async def _open_ws(port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(bytes(range(16))).decode("ascii")
    writer.write(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                  "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                  f"Sec-WebSocket-Key: {key}\r\n\r\n").encode("ascii"))
    await writer.drain()
    response = await reader.readuntil(b"\r\n\r\n")
    assert response.startswith(b"HTTP/1.1 101"), response
    return reader, writer


async def _send_json(writer: asyncio.StreamWriter, payload: dict) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    mask = bytes((1, 2, 3, 4))
    header = bytes((0x81, 0x80 | len(data))) if len(data) < 126 else (
        bytes((0x81, 0x80 | 126)) + struct.pack("!H", len(data)))
    writer.write(header + mask + bytes(byte ^ mask[index % 4]
                                       for index, byte in enumerate(data)))
    await writer.drain()


async def _recv_json(reader: asyncio.StreamReader) -> dict:
    first, second = await reader.readexactly(2)
    assert first == 0x81
    size = second & 0x7F
    if size == 126:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", await reader.readexactly(8))[0]
    return json.loads((await reader.readexactly(size)).decode("utf-8"))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_scenario_updates_clear_and_reach_native_setup(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "charSetMode": "dark"})
        client = Client(None)
        client.id, client.room_id = room["seats"][0]["id"], room["id"]
        client.send = mock.AsyncMock()
        self.app.clients.add(client)
        await self.app._handle_message(client, {"t": "config", "config": {"scenario": "cunning"}})
        self.assertEqual(room["config"]["scenario"], "cunning")
        with self.assertRaisesRegex(ValueError, "剧本"):
            await self.app._handle_message(client, {"t": "config", "config": {"scenario": "invalid", "charSetMode": "base"}})
        self.assertEqual(room["config"]["charSetMode"], "dark")
        await self.app._handle_message(client, {"t": "config", "config": {"scenario": ""}})
        self.assertEqual(room["config"]["scenario"], "")
        await self.app._handle_message(client, {"t": "config", "config": {"scenario": "tenacious"}})
        worker = self.app.native_worker_manager.game_worker
        with mock.patch.object(worker, "create_game", wraps=worker.create_game) as create, \
             mock.patch.object(self.app, "_schedule_bot"):
            await self.app._handle_message(client, {"t": "startGame"})
        self.assertEqual(create.call_args.args[0]["scenario"], "tenacious")
        self.assertEqual(create.call_args.args[0]["charSetMode"], "dark")
        self.assertEqual(room["state"]["config"]["scenario"], "tenacious")

    async def test_spectator_can_switch_to_every_human_and_bot(self):
        room = self.app.rooms.create_room("Host", {"playerCount":4, "bots":3})
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        client = Client(None)
        client.send = mock.AsyncMock()
        self.app.clients.add(client)
        await self.app._handle_message(client, {"t":"joinRoom", "roomId":room["id"]})
        observer_id = client.id
        token = room["spectators"][observer_id]["resumeToken"]
        for player in [*state["players"], *reversed(state["players"])]:
            await self.app._handle_message(client, {"t":"spectatePlayer", "playerId":player["id"]})
            view = client.send.call_args.args[0]["state"]
            self.assertEqual(view["viewPlayerId"], player["id"])
            self.assertEqual(view["you"], player["id"])
            self.assertEqual(view["available"]["actions"], [])
            self.assertEqual(client.id, observer_id)
            self.assertEqual(room["spectators"][observer_id]["resumeToken"], token)
            for row in view["players"]:
                self.assertEqual("hand" in row, row["id"] == player["id"])

    async def test_empty_rooms_expire_in_every_phase_and_release_native_games(self):
        for phase in ("lobby", "draft", "action", "gameover"):
            with self.subTest(phase=phase):
                room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1, "autoHost": False})
                token = room["seats"][0]["resumeToken"]
                if phase != "lobby":
                    state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
                    state["phase"] = phase
                    # A human being auto-hosted by a bot is still a reconnectable seat.
                    state["players"][0]["isBot"] = True
                room["emptySince"] = 100
                await self.app._cleanup_rooms(now=279)
                self.assertIn(room["id"], self.app.rooms.rooms)
                await self.app._cleanup_rooms(now=280)
                self.assertNotIn(room["id"], self.app.rooms.rooms)
                self.assertNotIn(room["id"], self.app.native_worker_manager.game_worker.games)
                self.assertIsNone(self.app.rooms.resume_room(token, room["id"]))

    async def test_live_players_and_spectators_reset_empty_room_grace(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        _, spectator = self.app.rooms.spectate_room(room["id"], "Viewer")
        for member in (room["seats"][0], spectator):
            with self.subTest(member=member["name"]):
                client = Client(mock.Mock())
                client.writer.is_closing.return_value = False
                client.id, client.room_id, client.last_seen = member["id"], room["id"], 1000
                room["emptySince"] = 100
                self.app.clients.add(client)
                await self.app._cleanup_rooms(now=1000)
                self.assertIn(room["id"], self.app.rooms.rooms)
                self.assertIsNone(room["emptySince"])
                self.app.clients.remove(client)
                await self.app._cleanup_rooms(now=1001)
                self.assertEqual(room["emptySince"], 1001)
                await self.app._cleanup_rooms(now=1180)
                self.assertIn(room["id"], self.app.rooms.rooms)
        await self.app._cleanup_rooms(now=1181)
        self.assertNotIn(room["id"], self.app.rooms.rooms)

    async def test_stale_sockets_and_nonmembers_do_not_keep_rooms_alive(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = 100
        client = Client(mock.Mock())
        client.writer.is_closing.return_value = False
        client.id, client.room_id, client.last_seen = room["seats"][0]["id"], room["id"], 100
        self.app.clients.add(client)
        stranger = Client(mock.Mock())
        stranger.writer.is_closing.return_value = False
        stranger.id, stranger.room_id, stranger.last_seen = "not-a-member", room["id"], 280
        self.app.clients.add(stranger)
        await self.app._cleanup_rooms(now=280)
        self.assertNotIn(room["id"], self.app.rooms.rooms)
        self.assertIsNone(client.room_id)
        self.assertIsNone(stranger.room_id)

    async def test_last_explicit_departure_cleans_tasks_but_preserves_live_spectator(self):
        class Member:
            def __init__(self, identity, room_id):
                self.id, self.room_id, self.messages = identity, room_id, []
            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1})
        _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        _, spectator = self.app.rooms.spectate_room(room["id"], "Viewer")
        host = Member(room["seats"][0]["id"], room["id"])
        observer = Member(spectator["id"], room["id"])
        self.app.clients.update((host, observer))
        await self.app._handle_message(host, {"t": "leaveRoom"})
        self.assertIn(room["id"], self.app.rooms.rooms)
        bot_task = room.get("botTask")
        takeover = asyncio.create_task(asyncio.sleep(3600))
        room["takeoverTasks"][host.id] = takeover
        await self.app._handle_message(observer, {"t": "leaveRoom"})
        await asyncio.gather(*[t for t in (bot_task, takeover) if t], return_exceptions=True)
        self.assertTrue(takeover.cancelled())
        self.assertNotIn(room["id"], self.app.rooms.rooms)
        self.assertNotIn(room["id"], self.app.native_worker_manager.game_worker.games)
        self.assertEqual(observer.messages[-1]["rooms"], [])

    async def test_cleanup_failure_hides_room_and_retries_native_release(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = 100
        worker = self.app.native_worker_manager.game_worker
        with mock.patch.object(worker, "close_game", side_effect=RuntimeError("test release failure")):
            await self.app._cleanup_rooms(now=280)
        self.assertTrue(room["closed"])
        self.assertEqual(self.app._public_rooms(), [])
        self.assertIsNone(self.app.rooms.resume_room(room["seats"][0]["resumeToken"], room["id"]))
        with self.assertRaisesRegex(ValueError, "不存在"):
            self.app.rooms.join_room(room["id"], "Guest")
        await self.app._cleanup_rooms(now=281)
        self.assertNotIn(room["id"], self.app.rooms.rooms)

    async def test_room_list_reads_cleanup_abandoned_rooms(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = time.monotonic() - 181
        code, body = await _request(self.port, "/api/rooms")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["rooms"], [])
        self.assertNotIn(room["id"], self.app.rooms.rooms)
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = time.monotonic() - 181
        class Browser:
            id = None
            room_id = None
            async def send(self, payload):
                self.payload = payload
        client = Browser()
        await self.app._handle_message(client, {"t": "listRooms"})
        self.assertEqual(client.payload["rooms"], [])

    async def test_housekeeping_cleans_without_room_list_requests(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = time.monotonic() - 181
        with mock.patch("python_backend.server.asyncio.sleep", side_effect=asyncio.CancelledError) as sleep:
            with self.assertRaises(asyncio.CancelledError):
                await self.app._room_housekeeping()
            sleep.assert_awaited_once_with(30)
        self.assertNotIn(room["id"], self.app.rooms.rooms)

    async def test_resume_cancels_takeover_and_resets_empty_grace(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        seat = room["seats"][0]
        seat["disconnected"] = True
        room["emptySince"] = time.monotonic() - 170
        takeover = asyncio.create_task(asyncio.sleep(3600))
        room["takeoverTasks"][seat["id"]] = takeover
        client = Client(None)
        client.send = mock.AsyncMock()
        self.app.clients.add(client)
        await self.app._handle_message(client, {"t": "hello", "resumeToken": seat["resumeToken"], "roomId": room["id"]})
        await asyncio.gather(takeover, return_exceptions=True)
        self.assertTrue(takeover.cancelled())
        self.assertFalse(seat["disconnected"])
        self.assertIsNone(room["emptySince"])
        await self.app._cleanup_rooms()
        self.assertIn(room["id"], self.app.rooms.rooms)
        room["state"]["players"][0]["isBot"] = True
        await self.app._handle_message(client, {"t": "hello", "resumeToken": seat["resumeToken"], "roomId": room["id"]})
        self.assertFalse(room["state"]["players"][0]["isBot"])

    async def test_cleanup_waits_for_inflight_native_creation(self):
        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        room["emptySince"] = time.monotonic() - 181
        started, release = asyncio.Event(), asyncio.Event()
        worker = self.app.native_worker_manager.game_worker
        calls = []
        async def creating(_fn, *args):
            calls.append("create")
            started.set()
            await release.wait()
            return {}
        async def closing(_fn, *args):
            calls.append("close")
        with mock.patch("python_backend.server.asyncio.to_thread", side_effect=creating):
            create = asyncio.create_task(self.app._create_room_game(room, {}))
            await started.wait()
        with mock.patch("python_backend.server.asyncio.to_thread", side_effect=closing):
            cleanup = asyncio.create_task(self.app._cleanup_rooms())
            await asyncio.sleep(0)
            self.assertTrue(room["closed"])
            self.assertFalse(cleanup.done())
            release.set()
            with self.assertRaisesRegex(ValueError, "已关闭"):
                await create
            await cleanup
        self.assertEqual(calls, ["create", "close"])
        self.assertNotIn(room["id"], self.app.rooms.rooms)

    async def test_spectator_views_resume_and_read_only_permissions(self):
        class Viewer:
            id = None
            room_id = None
            name = "Host"

            def __init__(self):
                self.messages = []

            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _, guest = self.app.rooms.join_room(room["id"], "Guest")
        viewer = Viewer()
        with self.assertRaisesRegex(ValueError, "尚未开始"):
            await self.app._handle_message(viewer, {"t": "spectateRoom", "roomId": room["id"]})
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        self.app.clients.add(viewer)
        await self.app._handle_message(viewer, {"t": "joinRoom", "roomId": room["id"].lower()})
        joined = next(m for m in viewer.messages if m["t"] == "joined")
        self.assertNotIn(viewer.id, [p["id"] for p in state["players"]])
        self.assertEqual(len(room["seats"]), 2)
        first = joined["state"]
        self.assertTrue(first["spectating"])
        self.assertEqual(first["you"], state["players"][0]["id"])
        self.assertEqual(first["available"]["actions"], [])
        self.assertTrue(first["players"][0]["hand"])
        self.assertNotIn("hand", first["players"][1])
        self.assertFalse(first["voiceReady"])
        self.assertTrue(first["draft"]["pool"])
        await self.app._handle_message(viewer, {"t": "spectatePlayer", "playerId": guest["id"]})
        switched = viewer.messages[-1]["state"]
        self.assertEqual(switched["you"], guest["id"])
        self.assertTrue(switched["players"][1]["hand"])
        self.assertNotIn("hand", switched["players"][0])
        self.assertEqual(switched["draft"]["pool"], [])
        state["round"] += 1
        with mock.patch.object(self.app, "_bot_available_actions", side_effect=AssertionError("spectators have no legal actions")):
            await self.app._broadcast_state(room)
        self.assertEqual(viewer.messages[-1]["state"]["round"], state["round"])
        self.assertEqual(viewer.messages[-1]["state"]["viewPlayerId"], guest["id"])
        other = Viewer()
        await self.app._handle_message(other, {"t": "spectateRoom", "roomId": room["id"]})
        self.assertEqual(room["spectators"][other.id]["viewPlayerId"], state["players"][0]["id"])
        for kind in ("action", "startGame", "restart", "setPace", "setAutoHost", "config", "chat"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "观战模式"):
                await self.app._handle_message(viewer, {"t": kind, "action": {"type": "end_turn"}})
        await self.app._handle_message(viewer, {"t": "botDebugSubscribe"})
        self.assertEqual(viewer.messages[-1], {"t": "botDebugHistory", "entries": room["botDebug"]})
        with self.assertRaisesRegex(ValueError, "视角不存在"):
            await self.app._handle_message(viewer, {"t": "spectatePlayer", "playerId": "missing"})
        resumed = Viewer()
        await self.app._handle_message(resumed, {"t": "hello", "resumeToken": joined["resumeToken"], "roomId": room["id"]})
        self.assertEqual(resumed.id, viewer.id)
        self.assertEqual(next(m for m in resumed.messages if m["t"] == "joined")["state"]["viewPlayerId"], guest["id"])
        room["state"] = None
        lobby = await self.app._state_for_client(room, viewer.id)
        self.assertEqual(lobby["you"], viewer.id)
        self.assertTrue(lobby["spectating"])
        restarted = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        restarted["phase"] = "gameover"
        finished = await self.app._state_for_client(room, viewer.id)
        self.assertTrue(finished["spectating"])
        self.assertEqual(finished["viewPlayerId"], guest["id"])
        await self.app._handle_message(viewer, {"t": "leaveRoom"})
        self.assertIsNone(viewer.room_id)
        self.assertNotIn(viewer.id, room["spectators"])
        self.assertIsNone(self.app.rooms.resume_room(joined["resumeToken"], room["id"]))
        self.assertFalse(room["seats"][0]["left"])

    async def asyncSetUp(self) -> None:
        self.admin_temp = tempfile.TemporaryDirectory()
        previous_admin_file = os.environ.get("CITADELS_ADMIN_FILE")
        os.environ["CITADELS_ADMIN_FILE"] = str(Path(self.admin_temp.name) / "server-admin.json")
        self.app = PythonServer(_ReferenceWorkerManager())
        # HTTP training tests exercise the real runtime independently from the
        # reference-rule test double used for room transport coverage.
        self.app.training = TrainingManager(native_worker=None)
        if previous_admin_file is None:
            os.environ.pop("CITADELS_ADMIN_FILE", None)
        else:
            os.environ["CITADELS_ADMIN_FILE"] = previous_admin_file
        self.listener = await asyncio.start_server(self.app.handle, "127.0.0.1", 0)
        self.port = self.listener.sockets[0].getsockname()[1]

    async def asyncTearDown(self) -> None:
        self.listener.close()
        await self.listener.wait_closed()
        self.admin_temp.cleanup()

    async def test_live_rules_fail_closed_without_native_worker(self):
        app = PythonServer()
        result = await app._apply_game_action({"state": {}}, "p0", {"type": "end_turn"})
        self.assertFalse(result["ok"])
        self.assertIn("拒绝处理游戏行动", result["error"])
        room = app.rooms.create_room("Host", {"playerCount": 2})
        self.assertFalse(hasattr(app.rooms, "start_room"))

    async def test_http_static_and_python_api(self) -> None:
        code, body = await _request(self.port, "/api/rooms")
        self.assertEqual((code, json.loads(body)), (200, {"rooms": []}))
        code, body = await _request(self.port, "/")
        self.assertEqual(code, 200)
        self.assertIn(b"<html", body.lower())
        code, body = await _request(self.port, "/training.html")
        self.assertEqual(code, 200)
        self.assertIn(b'class="fixed-setting">C++ ISMCTS', body)
        self.assertNotIn(b'id="mcts-engine"', body)
        self.assertNotIn(b'id="neural-network-framework"', body)
        for path, expected_type in (("/app.js", "application/javascript; charset=utf-8"),
                                    ("/src/cards.js", "application/javascript; charset=utf-8"),
                                    ("/style.css", "text/css; charset=utf-8")):
            headers: dict[str, str] = {}
            code, body = await _request(self.port, path, response_headers=headers)
            self.assertEqual(code, 200, path)
            self.assertTrue(body)
            self.assertEqual(headers.get("content-type"), expected_type, path)
        for retired_client_asset in ("/src/engine.js", "/src/ai.js"):
            code, _ = await _request(self.port, retired_client_asset)
            self.assertEqual(code, 403, retired_client_asset)
        code, body = await _request(self.port, "/api/training/status")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["state"], "idle")
        with mock.patch.object(self.app.training, "start", return_value={
                "running": True, "state": "preparing", "config": {"mctsSimulations": 2}}) as start:
            code, body = await _request(self.port, "/api/training/start", "POST",
                                        json.dumps({"mctsSimulations": 2}).encode("utf-8"),
                                        content_type="application/json")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["config"]["mctsSimulations"], 2)
        start.assert_called_once_with({"mctsSimulations": 2})
        code, _ = await _request(self.port, "/api/training/stop", "POST")
        self.assertEqual(code, 200)
        for path, required in (("/api/agent/status", {"configured", "model", "message"}),
                               ("/api/neural/status", {"configured", "checkpoint", "tta", "mcts"}),
                               ("/api/voice/status", {"configured", "message"}),
                               ("/api/server/startup", {"logs", "worker", "frp", "engine"})):
            headers: dict[str, str] = {}
            code, body = await _request(self.port, path, response_headers=headers)
            self.assertEqual(code, 200, path)
            self.assertTrue(required.issubset(json.loads(body)), path)
            if path in ("/api/agent/status", "/api/neural/status"):
                self.assertEqual(headers.get("access-control-allow-origin"), "*")
                self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertIsNone(_static_path("/src/../python_backend/server.py"))
        self.assertIsNone(_static_path("/%2e%2e/python_backend/server.py"))

    async def test_versioned_code_and_entry_assets_revalidate(self) -> None:
        for path in ("/mobile.js?v=10", "/app.js?v=95",
                     "/components/citadels-spectator.js?v=2", "/style.css?v=68",
                     "/mobile.html?v=1", "/manifest.json?v=1"):
            with self.subTest(path=path):
                headers: dict[str, str] = {}
                code, body = await _request(self.port, path, response_headers=headers)
                self.assertEqual(code, 200)
                self.assertTrue(body)
                self.assertEqual(headers.get("cache-control"), "no-cache")
                etag = headers["etag"]
                revalidated_headers: dict[str, str] = {}
                code, body = await _request(self.port, path,
                    extra_headers={"If-None-Match": etag}, response_headers=revalidated_headers)
                self.assertEqual((code, body), (304, b""))
                self.assertEqual(revalidated_headers.get("etag"), etag)
                self.assertEqual(revalidated_headers.get("cache-control"), "no-cache")
        headers = {}
        code, body = await _request(self.port, "/img/cards/district_tavern.png?v=1",
                                    response_headers=headers)
        self.assertEqual(code, 200)
        self.assertTrue(body)
        self.assertEqual(headers.get("cache-control"), "public, max-age=31536000, immutable")

    async def test_admin_server_status_auth_and_console_cors(self) -> None:
        self.app.admin_credentials = ("admin", "correct horse battery staple")
        self.app.console_origins = ["https://console.example"]
        code, body = await _request(self.port, "/api/server/status")
        self.assertEqual(code, 401)
        self.assertIn("需要管理员", json.loads(body)["error"])
        auth = base64.b64encode(b"admin:correct horse battery staple").decode("ascii")
        code, body = await _request(self.port, "/api/server/status", extra_headers={
            "Authorization": "Basic " + auth})
        self.assertEqual(code, 200)
        status = json.loads(body)
        self.assertIn("training", status)
        self.assertIn("rooms", status)
        self.assertEqual(status["backend"], "python")
        self.assertNotIn("correct horse", body.decode("utf-8"))
        code, _ = await _request(self.port, "/api/server/status", "OPTIONS", extra_headers={
            "Origin": "https://console.example", "Access-Control-Request-Method": "GET"})
        self.assertEqual(code, 204)
        code, body = await _request(self.port, "/api/server/status", "OPTIONS", extra_headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
        self.assertEqual(code, 403)

    async def test_startup_endpoint_reports_configured_frp_without_starting_it(self) -> None:
        self.app.frp.env = {"CITADELS_FRP_ENABLED": "1", "CITADELS_FRP_SERVER_ADDR": "relay.example",
                            "CITADELS_FRP_TOKEN": "private-token", "CITADELS_FRP_DOMAIN": "game.example"}
        code, body = await _request(self.port, "/api/server/startup")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertEqual(payload["worker"]["backend"], "python")
        self.assertEqual(payload["frp"], {"enabled": True, "configured": True, "running": False,
            "type": "http", "domain": "game.example", "remotePort": None})
        self.assertNotIn("private-token", body.decode("utf-8"))

    async def test_version_endpoint_matches_startup_identity(self) -> None:
        headers: dict[str, str] = {}
        code, body = await _request(self.port, "/api/version", response_headers=headers)
        self.assertEqual(code, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        release = json.loads(body)
        self.assertIn(release["channel"], ("stable", "development"))
        self.assertEqual(set(release), {"version", "baseVersion", "channel", "commit", "tag", "dirty"})
        _, startup = await _request(self.port, "/api/server/startup")
        self.assertEqual(json.loads(startup)["release"], release)

    async def test_loopback_codex_gateway_protocol_and_input_validation(self) -> None:
        calls = []
        async def fake_runner(prompt):
            calls.append(prompt)
            return {"actionIndex": 2, "cardUids": ["district-1"]}
        self.app.codex_gateway = CodexGateway(fake_runner, model_name="test-codex")
        payload = {"model": "ignored", "messages": [
            {"role": "system", "content": "follow policy"},
            {"role": "user", "content": "choose"}]}
        code, body = await _request(self.port, "/api/codex/v1/chat/completions", "POST",
            json.dumps(payload).encode(), content_type="application/json")
        self.assertEqual(code, 200, body)
        response = json.loads(body)
        self.assertEqual(response["model"], "test-codex")
        self.assertEqual(json.loads(response["choices"][0]["message"]["content"]),
                         {"actionIndex": 2, "cardUids": ["district-1"]})
        self.assertIn("MESSAGES_JSON:", calls[0])

        code, body = await _request(self.port, "/api/codex/v1/chat/completions", "POST",
            json.dumps({"messages": [{"role": "developer", "content": "unsafe"}]}).encode(),
            content_type="application/json")
        self.assertEqual(code, 400)
        self.assertIn("messages 格式无效", json.loads(body)["error"]["message"])
        self.assertEqual(len(calls), 1)

        code, _ = await _request(self.port, "/api/codex/v1/chat/completions", "POST", b"{}",
                                 content_type="text/plain")
        self.assertEqual(code, 415)

    async def test_checkpoint_upload_list_and_config_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            self.app.training_data_dir = Path(temp)
            self.app.training.data_dir = Path(temp)
            payload = {"game": 1234, "createdAt": "2026-10-01T00:00:00Z",
                       "config": {"profile": "large", "learningRate": 0.0003},
                       "model": {"encodingVersion": 14},
                       "encoding": {"state": 14, "action": 9}}
            blob = gzip.compress(json.dumps(payload).encode("utf-8"))
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=checkpoint-test.json.gz",
                                        "POST", blob)
            imported = json.loads(body)
            self.assertEqual(code, 200)
            self.assertEqual(imported["name"], "checkpoint-test.json.gz")
            self.assertTrue(imported["encodingCompatible"])

            code, body = await _request(self.port, "/api/training/status")
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["checkpoints"][0]["name"], imported["name"])
            code, body = await _request(self.port, "/api/training/checkpoint?name=" + imported["name"])
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["config"], payload["config"])

            code, body = await _request(self.port,
                                        "/api/training/checkpoint?name=..%2Fpython_backend%2Fserver.py")
            self.assertEqual(code, 400)
            self.assertIn("不合法", json.loads(body)["error"])

            # Uploading the same basename must not overwrite a checkpoint already
            # present in training-data; malformed payloads must leave no file behind.
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=checkpoint-test.json.gz",
                                        "POST", blob)
            duplicate = json.loads(body)
            self.assertEqual(code, 200)
            self.assertNotEqual(duplicate["name"], imported["name"])
            self.assertTrue(duplicate["renamed"])
            code, body = await _request(self.port, "/api/training/checkpoint/upload?name=broken.json.gz",
                                        "POST", b"not gzip")
            self.assertEqual(code, 400)
            self.assertIn("无法解析", json.loads(body)["error"])
            self.assertFalse((Path(temp) / "checkpoint-broken.json.gz").exists())

            # Listing filters unrelated files while accepting the versioned names
            # produced by Python's checkpoint writer.
            (Path(temp) / "unrelated.json.gz").write_bytes(b"junk")
            code, body = await _request(self.port, "/api/training/status")
            listed = json.loads(body)["checkpoints"]
            self.assertEqual(code, 200)
            self.assertEqual({row["name"] for row in listed},
                             {imported["name"], duplicate["name"]})

    async def test_training_http_start_status_and_stop_use_python_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.app.training.data_dir = Path(directory)
            config = {"targetGames": 1, "minPlayers": 2, "maxPlayers": 2,
                      "profile": "fast", "networkArchitecture": "entity-v6", "device": "cpu",
                      "rulesEngine": "js", "mctsEngine": "cpp",
                      "neuralNetworkFramework": "libtorch", "backend": "native",
                      "nativeInferenceBackend": "libtorch", "mctsEvaluator": "native",
                      "mctsSimulations": 1, "mctsBatchSize": 16,
                      "batchGames": 1, "trainingEpochs": 1,
                      "miniBatch": 32, "checkpointEvery": 1, "maxRounds": 1, "seed": 901}
            code, body = await _request(self.port, "/api/training/start", "POST",
                                        json.dumps(config).encode("utf-8"),
                                        content_type="application/json")
            self.assertEqual(code, 200, body)
            started = json.loads(body)
            self.assertTrue(started["running"])
            self.assertEqual(started["config"]["rulesEngine"], "cpp")
            self.assertEqual(started["config"]["mctsEngine"], "cpp")
            self.assertEqual(started["config"]["neuralNetworkFramework"], "libtorch")
            self.assertEqual(started["config"]["mctsBatchSize"], 16)
            self.assertEqual(started["config"]["backend"], "python")
            self.assertNotIn("nativeInferenceBackend", started["config"])
            self.assertNotIn("mctsEvaluator", started["config"])
            deadline = time.monotonic() + 60
            status = {}
            while time.monotonic() < deadline:
                code, body = await _request(self.port, "/api/training/status")
                self.assertEqual(code, 200)
                status = json.loads(body)
                if not status["running"]:
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(status["state"], "completed", status.get("error"))
            self.assertEqual(status["completedGames"], 1)
            self.assertTrue((Path(directory) / status["checkpoint"]).is_file())

    async def test_same_name_join_cannot_claim_player_seat(self) -> None:
        rooms = RoomRegistry()
        room = rooms.create_room("Host", {"playerCount": 2})
        _, guest = rooms.join_room(room["id"], "Guest")
        _start_reference_room(rooms, room["id"])
        same_room, observer = rooms.join_room(room["id"], "Host")
        self.assertIs(same_room, room)
        self.assertTrue(observer["spectating"])
        self.assertNotEqual(observer["id"], room["seats"][0]["id"])
        self.assertNotEqual(observer["resumeToken"], room["seats"][0]["resumeToken"])
        self.assertEqual(rooms.resume_room(room["seats"][0]["resumeToken"], room["id"])[1]["id"], room["seats"][0]["id"])
        self.assertEqual(guest["name"], "Guest")
        for phase in ("draft", "action", "roundConfirm", "gameover"):
            room["state"]["phase"] = phase
            for nickname in ("Host", "Guest", "New viewer"):
                with self.subTest(phase=phase, nickname=nickname):
                    _, spectator = rooms.join_room(room["id"], nickname)
                    self.assertTrue(spectator["spectating"])
                    self.assertNotIn(spectator["id"], [p["id"] for p in room["seats"]])
                    self.assertNotIn(spectator["resumeToken"], [p.get("resumeToken") for p in room["seats"]])

    async def test_leaving_lobby_sends_room_notice_before_room_refresh(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id, self.messages = player_id, room_id, []
            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _, guest = self.app.rooms.join_room(room["id"], "Guest")
        host_client = StubClient(room["seats"][0]["id"], room["id"])
        guest_client = StubClient(guest["id"], room["id"])
        self.app.clients.update((host_client, guest_client))
        await self.app._handle_message(host_client, {"t": "leaveRoom"})
        notices = [m["notice"] for m in guest_client.messages if m.get("t") == "roomNotice"]
        self.assertEqual(notices, [{"kind": "player_left", "playerName": "Host"}])
        self.assertIsNone(host_client.room_id)
        self.assertFalse(room["seats"][0]["taken"])
        self.assertIn(room["id"], self.app.rooms.rooms)

    async def test_leaving_active_game_keeps_human_seat_and_notifies_room(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id, self.messages = player_id, room_id, []
            async def send(self, payload):
                self.messages.append(payload)

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        _, guest = self.app.rooms.join_room(room["id"], "Guest")
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        host_id = room["seats"][0]["id"]
        host_client = StubClient(host_id, room["id"])
        guest_client = StubClient(guest["id"], room["id"])
        self.app.clients.update((host_client, guest_client))
        await self.app._handle_message(host_client, {"t": "leaveRoom"})
        host_seat = room["seats"][0]
        host_player = next(p for p in state["players"] if p["id"] == host_id)
        self.assertTrue(host_seat["left"])
        self.assertTrue(host_player["isBot"])
        self.assertIsNone(host_client.room_id)
        notices = [m["notice"] for m in guest_client.messages if m.get("t") == "roomNotice"]
        self.assertEqual(notices, [{"kind": "player_left", "playerId": host_id, "playerName": "Host"}])
        self.assertIn(room["id"], self.app.rooms.rooms)

    async def test_start_compacts_taken_seats_before_auto_filling_npcs(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id = player_id, room_id
            async def send(self, _payload):
                return None

        room = self.app.rooms.create_room("Host", {"playerCount": 4})
        host = StubClient(room["seats"][0]["id"], room["id"])
        await self.app._handle_message(host, {"t": "setSeat", "index": 2, "kind": "bot"})
        original_bot = room["seats"][2]["id"]
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        self.assertEqual([seat["id"] for seat in room["seats"][:2]],
                         [host.id, original_bot])
        self.assertEqual([seat["name"] for seat in room["seats"][2:]], ["电脑 1", "电脑 2"])
        self.assertEqual([player["id"] for player in state["players"]],
                         [seat["id"] for seat in room["seats"]])

    async def test_start_rejects_unconfigured_agent_even_if_it_is_an_auto_fill(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id = player_id, room_id
            async def send(self, _payload):
                return None

        room = self.app.rooms.create_room("Host", {"playerCount": 2, "botType": "agent"})
        host = StubClient(room["seats"][0]["id"], room["id"])
        class UnavailableAgent:
            @staticmethod
            def status():
                return {"configured": False, "message": "test agent unavailable"}
        self.app.agent = UnavailableAgent()
        self.app.use_local_codex = False
        with self.assertRaisesRegex(ValueError, "unavailable|Codex CLI"):
            await self.app._handle_message(host, {"t": "startGame"})
        self.assertIsNone(room["state"])

    async def test_room_preserves_unbounded_mcts_values_and_zero_override(self) -> None:
        rooms = RoomRegistry()
        room = rooms.create_room("Host", {"playerCount": 3, "bots": 1,
                                           "mctsSimulations": 25000, "mctsMaxDepth": 4000,
                                           "mctsParticles": 32})
        self.assertEqual(room["config"]["mctsSimulations"], 25000)
        self.assertEqual(room["config"]["mctsMaxDepth"], 4000)
        self.assertEqual(room["config"]["mctsParticles"], 32)
        self.assertEqual(room["seats"][1]["mcts"],
                         {"simulations": 25000, "maxDepth": 4000, "particles": 32})
        negative = rooms.create_room("Negative", {"playerCount": 2, "mctsMaxDepth": -2,
                                                    "mctsParticles": 0})
        self.assertEqual(negative["config"]["mctsMaxDepth"], 0)
        self.assertEqual(negative["config"]["mctsParticles"], 1)
        zero = rooms.create_room("Zero", {"playerCount": 2, "mctsSimulations": 0})
        self.assertEqual(zero["config"]["mctsSimulations"], 0)

    async def test_room_exposes_configurable_heuristic_mcts_per_bot_seat(self) -> None:
        room = RoomRegistry().create_room("Host", {"playerCount": 2, "bots": 1,
            "heuristicMcts": {"simulations": 640, "particles": 12, "maxDepth": 96,
                              "cPuct": 1.8, "reuseTree": False}})
        self.assertEqual(room["seats"][1]["heuristicMcts"], {"timeBudgetMs": 10000})
        defaults = RoomRegistry().create_room("Defaults", {"playerCount": 2, "bots": 1})["seats"][1]["heuristicMcts"]
        self.assertEqual(defaults, {"timeBudgetMs": 10000})
        for invalid in (0, -1, "bad", float("nan")):
            normalized = RoomRegistry().create_room("Budget", {"bots": 1,
                "heuristicMcts": {"timeBudgetMs": invalid}})["seats"][1]["heuristicMcts"]
            self.assertGreaterEqual(normalized["timeBudgetMs"], 1)

    async def test_set_seat_saves_heuristic_mcts_options(self) -> None:
        class StubClient:
            def __init__(self, player_id, room_id):
                self.id, self.room_id = player_id, room_id
            async def send(self, _payload):
                return None

        room = self.app.rooms.create_room("Host", {"playerCount": 2})
        host = StubClient(room["seats"][0]["id"], room["id"])
        options = {"simulations": 640, "particles": 12, "maxDepth": 96,
                   "timeBudgetMs": 350, "criticalTimeBudgetMs": 800,
                   "cPuct": 1.8, "rolloutSteps": 10, "rollouts": 2,
                   "maxTreeNodes": 8192, "reuseTree": False}
        await self.app._handle_message(host, {"t": "setSeat", "index": 1, "kind": "bot",
            "botType": "npc-hard", "heuristicMcts": options})
        seat = room["seats"][1]
        self.assertEqual(seat["botLevel"], "hard")
        self.assertEqual(seat["heuristicMcts"], {"timeBudgetMs": 350})

    async def test_bot_debug_reaches_websocket_and_replays_history(self) -> None:
        reader, writer = await _open_ws(self.port)
        try:
            await _send_json(writer, {"t": "hello", "name": "Debug"})
            await _send_json(writer, {"t": "createRoom", "config": {
                "playerCount": 2, "bots": 1, "botPace": 1, "autoHost": False}})
            room_id = None
            entries = []
            while room_id is None:
                message = await asyncio.wait_for(_recv_json(reader), 2)
                if message["t"] == "joined":
                    room_id = message["roomId"]
            await _send_json(writer, {"t": "startGame"})
            sent_steps = set()
            for _ in range(40):
                message = await asyncio.wait_for(_recv_json(reader), 2)
                self.assertNotEqual(message["t"], "error", message)
                if message["t"] == "botDebug":
                    entries.append(message["entry"])
                    if message["entry"]["kind"] == "action_apply":
                        break
                elif message["t"] == "state":
                    state = message["state"]
                    actions = (state.get("available") or {}).get("actions") or []
                    if state.get("phase") == "draft" and actions:
                        step = state["draft"].get("stepIdx")
                        if step not in sent_steps:
                            sent_steps.add(step)
                            await _send_json(writer, {"t": "action", "action": actions[0]})
            self.assertEqual([entry["kind"] for entry in entries[:3]],
                             ["decision_start", "decision_detail", "action_apply"])
            self.assertGreaterEqual(entries[1]["inference"]["durationMs"], 0)
            for entry in entries:
                if entry.get("action"):
                    self.assertEqual(set(entry["action"]), {"type"})
            await _send_json(writer, {"t": "botDebugSubscribe"})
            while True:
                message = await asyncio.wait_for(_recv_json(reader), 2)
                if message["t"] == "botDebugHistory":
                    self.assertEqual(message["entries"][:3], entries[:3])
                    break
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_bot_debug_history_is_bounded_and_redacts_private_actions(self):
        room = self.app.rooms.create_room("Debug", {"playerCount": 2, "bots": 1})
        actor = room["seats"][1]
        for index in range(305):
            await self.app._record_bot_debug(room, actor, "decision_detail",
                action={"type": "choose_role", "role": "assassin", "uid": 99},
                inference={"durationMs": index})
        self.assertEqual(len(room["botDebug"]), 300)
        self.assertEqual(room["botDebug"][0]["inference"]["durationMs"], 5)
        self.assertEqual(room["botDebug"][-1]["action"], {"type": "choose_role"})

    async def test_bot_debug_records_neural_configuration_error(self):
        room = self.app.rooms.create_room("Debug", {"playerCount": 2, "bots": 1, "botPace": 1})
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        host = state["players"][0]
        options = get_available_actions(state, host["id"])["actions"]
        self.assertTrue(apply_action(state, host["id"], options[0])["ok"])
        actor_id = self.app._bot_actor(state)
        actor = next(p for p in state["players"] if p["id"] == actor_id)
        actor["botType"] = "neural"
        with mock.patch.object(self.app.neural, "status", return_value={
                "configured": False, "checkpoint": "missing", "message": "weight missing"}):
            self.app._schedule_bot(room)
            await asyncio.wait_for(room["botTask"], 2)
        self.assertEqual([entry["kind"] for entry in room["botDebug"]],
                         ["decision_start", "decision_error"])
        self.assertEqual(room["botDebug"][-1]["error"], "weight missing")
        self.assertEqual(room["agentStatus"]["state"], "error")

    async def test_python_npc_driver_takes_a_legal_draft_action(self) -> None:
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1,
                                                     "botPace": 1, "seed": 91})
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        original_step = state["draft"]["stepIdx"]
        self.app._schedule_bot(room)
        for _ in range(40):
            if state["phase"] != "draft" or state["draft"]["stepIdx"] != original_step:
                break
            actor_id = self.app._bot_actor(state)
            actor = next(player for player in state["players"] if player["id"] == actor_id)
            if not actor["isBot"]:
                options = (await self.app._state_for_client(room, actor_id))["available"]["actions"]
                self.assertTrue(options)
                from test.python_game_reference import apply_action
                self.assertTrue(apply_action(state, actor_id, options[0])["ok"])
                self.app._schedule_bot(room)
            await asyncio.sleep(0.01)
        task = room.get("botTask")
        if task and not task.done():
            await asyncio.wait_for(task, timeout=1)
        self.assertNotEqual(state["draft"]["stepIdx"], original_step)

    async def test_bots_confirm_round_results_without_waiting_for_human_seat_order(self) -> None:
        room = self.app.rooms.create_room("Host", {"playerCount": 3, "bots": 2,
                                                     "botType": "agent", "botPace": 0,
                                                     "seed": 92})
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        state["phase"] = "action"
        state["roundConfirm"] = {"round": state["round"],
                                  "confirmed": [False] * len(state["players"])}
        # Even an Agent bot can perform this deterministic engine action; it
        # must not be blocked by its unrelated model-error state.
        bot = next(player for player in state["players"] if player["isBot"])
        room["agentStatus"] = {"playerId": bot["id"], "state": "error"}

        self.app._schedule_bot(room)
        task = room.get("botTask")
        if task:
            await asyncio.wait_for(task, timeout=1)

        self.assertEqual(state["roundConfirm"]["confirmed"], [False, True, True])
        self.assertIsNone(self.app._bot_actor(state))

        host = state["players"][0]
        result = apply_action(state, host["id"], {"type": "confirm_round"})
        self.assertTrue(result["ok"])
        self.app._schedule_bot(room)
        self.assertIsNone(state["roundConfirm"])

    async def test_agent_driver_uses_validated_decision_and_host_can_fallback(self) -> None:
        class StubAgent:
            def __init__(self, fail=False):
                self.fail = fail

            def status(self):
                return {"configured": True, "model": "test-model", "message": "ready"}

            def decide(self, state, player_id, available):
                if self.fail:
                    from python_backend.agent import AgentError
                    raise AgentError("http_error", "模型服务返回 HTTP 503")
                action = available["actions"][0]
                return {"action": action, "model": "test-model"}

        self.app.agent = StubAgent(fail=True)
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1,
                                                     "botType": "agent", "botPace": 0})
        # Room configuration normalizes zero to the default pace; this test
        # exercises decisions and fallback rather than the UI pacing delay.
        room["config"]["botPace"] = 0
        state = _start_reference_room(self.app.rooms, room["id"], self.app.native_worker_manager.game_worker)
        self.app._schedule_bot(room)
        for _ in range(30):
            actor_id = self.app._bot_actor(state)
            actor = next(player for player in state["players"] if player["id"] == actor_id)
            if actor["isBot"]:
                await asyncio.sleep(0.01)
                if room.get("agentStatus", {}).get("state") == "error":
                    break
            else:
                options = get_available_actions(state, actor_id)["actions"]
                self.assertTrue(apply_action(state, actor_id, options[0])["ok"])
                self.app._schedule_bot(room)
        self.assertEqual(room["agentStatus"]["state"], "error")
        agent_seat = next(seat for seat in room["seats"] if seat.get("botType") == "agent")
        host = Client(None)  # type: ignore[arg-type]
        host.id, host.room_id = room["seats"][0]["id"], room["id"]
        await self.app._handle_message(host, {"t": "agentControl", "mode": "npc"})
        self.assertEqual(agent_seat["botType"], "npc")
        task = room.get("botTask")
        if task and not task.done():
            await asyncio.wait_for(task, timeout=1)

    async def test_livekit_voice_status_token_auth_and_rate_limit(self) -> None:
        self.app.voice = VoiceService({"LIVEKIT_URL": "wss://voice.example.test/",
                                       "LIVEKIT_API_KEY": "api-key",
                                       "LIVEKIT_API_SECRET": "private-secret",
                                       "LIVEKIT_TOKEN_TTL": "600"})
        room = self.app.rooms.create_room("Host", {"playerCount": 2, "bots": 1})
        host = room["seats"][0]
        self.assertTrue(self.app._state_for(room, host["id"])["voiceReady"])
        code, status_body = await _request(self.port, "/api/voice/status")
        self.assertEqual(code, 200)
        self.assertTrue(json.loads(status_body)["configured"])
        self.assertNotIn("private-secret", status_body.decode("utf-8"))

        payload = json.dumps({"roomId": room["id"], "resumeToken": host["resumeToken"]}).encode()
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    {"Origin": "https://frontend.example"}, "application/json")
        self.assertEqual(code, 200)
        token = json.loads(body)
        self.assertEqual(token["room"], "citadels-" + room["id"])
        self.assertEqual(token["identity"], host["id"])
        self.assertIn("private-secret", self.app.voice.api_secret)
        self.assertNotIn("private-secret", body.decode("utf-8"))

        bad_identity = json.dumps({"roomId": room["id"], "resumeToken": "wrong"}).encode()
        code, body = await _request(self.port, "/api/voice/token", "POST", bad_identity,
                                    content_type="application/json")
        self.assertEqual(code, 403)
        self.assertIn("无法验证", json.loads(body)["error"])

        room["config"]["voice"] = False
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    content_type="application/json")
        self.assertEqual(code, 403)
        self.assertIn("已关闭", json.loads(body)["error"])
        room["config"]["voice"] = True

        self.app.voice_token_hits["127.0.0.1"] = (30, time.time() + 60)
        code, body = await _request(self.port, "/api/voice/token", "POST", payload,
                                    content_type="application/json")
        self.assertEqual(code, 429)
        self.assertIn("频繁", json.loads(body)["error"])

        code, _ = await _request(self.port, "/api/voice/token", "OPTIONS", extra_headers={
            "Origin": "https://frontend.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(code, 204)

    async def test_websocket_lobby_and_draft(self) -> None:
        host_reader, host_writer = await _open_ws(self.port)
        guest_reader, guest_writer = await _open_ws(self.port)
        try:
            await _send_json(host_writer, {"t": "hello", "name": "Host"})
            self.assertEqual((await _recv_json(host_reader))["t"], "hello")
            self.assertEqual((await _recv_json(host_reader))["t"], "rooms")
            await _send_json(host_writer, {"t": "createRoom", "name": "Host",
                                           "config": {"playerCount": 2}})
            joined = await _recv_json(host_reader)
            self.assertEqual(joined["t"], "joined")
            room_id = joined["roomId"]
            self.assertNotIn("resumeToken", json.dumps(joined["state"]))
            self.assertEqual((await _recv_json(host_reader))["t"], "state")

            await _send_json(guest_writer, {"t": "hello", "name": "Guest"})
            self.assertEqual((await _recv_json(guest_reader))["t"], "hello")
            self.assertEqual((await _recv_json(guest_reader))["t"], "rooms")
            await _send_json(guest_writer, {"t": "joinRoom", "roomId": room_id,
                                            "name": "Guest"})
            self.assertEqual((await _recv_json(guest_reader))["t"], "joined")
            self.assertEqual((await _recv_json(guest_reader))["t"], "state")
            self.assertEqual((await _recv_json(host_reader))["t"], "state")

            await _send_json(host_writer, {"t": "startGame"})
            host_state = (await _recv_json(host_reader))["state"]
            guest_state = (await _recv_json(guest_reader))["state"]
            self.assertEqual(host_state["phase"], "draft")
            self.assertEqual(guest_state["phase"], "draft")
            self.assertEqual(len(host_state["players"]), 2)
            self.assertEqual(len(guest_state["players"]), 2)
            host_viewer = next(player for player in host_state["players"]
                               if player["id"] == host_state["you"])
            guest_viewer = next(player for player in guest_state["players"]
                                if player["id"] == guest_state["you"])
            self.assertEqual(len(host_viewer["hand"]), 4)
            self.assertEqual(len(guest_viewer["hand"]), 4)
            actor_state = host_state if host_state["available"]["actions"] else guest_state
            other_state = guest_state if actor_state is host_state else host_state
            self.assertTrue(actor_state["draft"]["pool"])
            self.assertEqual(other_state["draft"]["pool"], [])
            self.assertTrue(all("hand" not in row for row in other_state["players"]
                                if row["id"] != other_state["you"]))
            actor_writer = host_writer if actor_state is host_state else guest_writer
            actor_reader = host_reader if actor_state is host_state else guest_reader
            await _send_json(actor_writer, {"t": "action", "action": "invalid"})
            self.assertEqual((await _recv_json(actor_reader))["t"], "error")
            await _send_json(actor_writer, {"t": "action",
                                            "action": actor_state["available"]["actions"][0]})
            self.assertEqual((await _recv_json(host_reader))["t"], "state")
            self.assertEqual((await _recv_json(guest_reader))["t"], "state")
        finally:
            host_writer.close()
            guest_writer.close()
            await host_writer.wait_closed()
            await guest_writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
