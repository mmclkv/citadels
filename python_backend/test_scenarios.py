"""Scenario definitions, room validation and authoritative native setup."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from python_backend import cards
from python_backend.rooms import RoomRegistry
from python_backend.game_engine_worker import GameEngineWorker

ROOT = Path(__file__).resolve().parents[1]


class ScenarioTests(unittest.TestCase):
    def test_all_presets_have_complete_and_valid_card_lists(self):
        self.assertEqual(len(cards.SCENARIOS), 7)
        districts = {d['en']: d for d in cards.DISTRICTS}
        for scenario in cards.SCENARIOS:
            with self.subTest(scenario=scenario['id']):
                self.assertEqual([cards.CHAR_MAP[c]['num'] for c in scenario['characters']],
                                 list(range(1, len(scenario['characters']) + 1)))
                self.assertEqual(len(set(scenario['districts'])), 14)
                self.assertTrue(all(districts[d]['color'] == 'purple' for d in scenario['districts']))

    @unittest.skipUnless(shutil.which('node'), 'Node.js required')
    def test_browser_and_server_share_identical_scenarios(self):
        result = subprocess.run([shutil.which('node'), '-e',
            "process.stdout.write(JSON.stringify(require('./src/cards.js').SCENARIOS))"],
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', check=True)
        self.assertEqual(json.loads(result.stdout), cards.SCENARIOS)

    def test_room_preserves_optional_selection_and_rejects_unknown_values(self):
        registry = RoomRegistry()
        self.assertEqual(registry.create_room('Host')['config']['scenario'], '')
        for scenario in cards.SCENARIOS:
            self.assertEqual(registry.create_room('Host', {'scenario': scenario['id']})['config']['scenario'], scenario['id'])
        for value in ('unknown', [], {}, True):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '剧本'):
                registry.create_room('Host', {'scenario': value})


@unittest.skipUnless(os.environ.get('CITADELS_TEST_GAME_ENGINE'), 'Compiled game engine required')
class NativeScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = GameEngineWorker(os.environ['CITADELS_TEST_GAME_ENGINE'])

    @classmethod
    def tearDownClass(cls):
        cls.worker.close()

    def create(self, count, scenario='', mode='mixed'):
        return self.worker.create_game({'catalog': cards._catalog, 'seed': 19,
            'endDistricts': 8, 'scenario': scenario, 'charSetMode': mode,
            'seats': [{'id': f'p{i}', 'name': f'Player {i}'} for i in range(count)]}, 'scenario-test')

    def test_every_scenario_and_player_count_use_only_selected_cards(self):
        for scenario in cards.SCENARIOS:
            for count in range(2, 9):
                with self.subTest(scenario=scenario['id'], count=count):
                    state = self.create(count, scenario['id'])
                    deck = state['deck'] + [card for player in state['players'] for card in player['hand']]
                    purple = [c for c in deck if c['color'] == 'purple']
                    self.assertEqual(len(deck), 68)
                    self.assertEqual(len(purple), 14)
                    self.assertEqual({c['en'] for c in purple}, set(scenario['districts']))
                    expected = list(scenario['characters'])
                    if count == 2:
                        expected = [c for c in expected if cards.CHAR_MAP[c]['num'] != 9]
                        expected = ['king' if c == 'emperor' else c for c in expected]
                    if count < 5:
                        expected = ['artist' if c == 'queen' else c for c in expected]
                    if count in (3, 8) and len(expected) == 8:
                        expected.append('artist')
                    self.assertEqual(state['charDeck'], expected)
                    for step in range(12):
                        if state['phase'] != 'draft':
                            break
                        actor = self.worker.current('scenario-test')['playerId']
                        actions = self.worker.legal_actions(game_id='scenario-test', player_id=actor)['actions']
                        self.assertTrue(actions)
                        state = self.worker.apply(game_id='scenario-test', player_id=actor, action=actions[0])
                        if count == 3 and step == 2:
                            self.assertEqual(len(state['draft']['faceDown']), 2)
                    self.assertEqual(state['phase'], 'action')
                    self.assertTrue(all(len(p['chars']) == (2 if count <= 3 else 1) for p in state['players']))

    def test_scenario_overrides_role_group_and_default_deck_is_unchanged(self):
        baseline = self.create(4, 'cunning', 'base')
        for mode in ('dark', 'mixed', 'ignored'):
            state = self.create(4, 'cunning', mode)
            self.assertEqual(state['charDeck'], baseline['charDeck'])
            self.assertEqual(state['deck'], baseline['deck'])
        state = self.create(4)
        self.assertEqual(len(state['deck']) + sum(len(p['hand']) for p in state['players']), 92)
        with self.assertRaisesRegex(RuntimeError, 'Unknown scenario'):
            self.create(4, 'unknown')


if __name__ == '__main__':
    unittest.main()
