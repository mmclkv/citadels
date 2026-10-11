"""Scenario definitions, room validation and authoritative native setup."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest import mock

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

    @unittest.skipUnless(shutil.which('node'), 'Node.js required')
    def test_building_reference_matches_each_scenario(self):
        result = subprocess.run([shutil.which('node'), '-e',
            "const c=require('./src/cards.js'); process.stdout.write(JSON.stringify("
            "['',...c.SCENARIOS.map(s=>s.id)].map(id=>c.districtsForScenario(id))))"],
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', check=True)
        references = json.loads(result.stdout)
        self.assertEqual(references[0], cards.DISTRICTS)
        ordinary = [d for d in cards.DISTRICTS if d['color'] != 'purple']
        for scenario, reference in zip(cards.SCENARIOS, references[1:]):
            with self.subTest(scenario=scenario['id']):
                self.assertEqual([d for d in reference if d['color'] != 'purple'], ordinary)
                self.assertEqual({d['en'] for d in reference if d['color'] == 'purple'},
                                 set(scenario['districts']))

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

    def create(self, count, scenario='', mode='mixed', seed=19, catalog=None):
        return self.worker.create_game({'catalog': catalog or cards._catalog, 'seed': seed,
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

    def test_scenario_overrides_role_group_and_default_deck_has_68_cards(self):
        baseline = self.create(4, 'cunning', 'base')
        for mode in ('dark', 'mixed', 'ignored'):
            state = self.create(4, 'cunning', mode)
            self.assertEqual(state['charDeck'], baseline['charDeck'])
            self.assertEqual(state['deck'], baseline['deck'])
        state = self.create(4)
        self.assertEqual(len(state['deck']) + sum(len(p['hand']) for p in state['players']), 68)
        with self.assertRaisesRegex(RuntimeError, 'Unknown scenario'):
            self.create(4, 'unknown')

    def test_default_deck_samples_14_unique_purple_districts(self):
        ordinary = {d['en']: d['count'] for d in cards.DISTRICTS if d['color'] != 'purple'}
        selections = set()
        for count in range(2, 9):
            for seed in (1, 19, 42):
                with self.subTest(count=count, seed=seed):
                    state = self.create(count, seed=seed)
                    deck = state['deck'] + [c for p in state['players'] for c in p['hand']]
                    purple = [c for c in deck if c['color'] == 'purple']
                    self.assertEqual(len(deck), 68)
                    self.assertEqual(len(purple), 14)
                    self.assertEqual(len({c['en'] for c in purple}), 14)
                    self.assertEqual(len({c['uid'] for c in deck}), 68)
                    self.assertEqual({name: sum(c['en'] == name for c in deck) for name in ordinary}, ordinary)
                    selections.add(tuple(sorted(c['en'] for c in purple)))
                    repeated = self.create(count, seed=seed)
                    self.assertEqual(state['deck'], repeated['deck'])
                    self.assertEqual([p['hand'] for p in state['players']], [p['hand'] for p in repeated['players']])
        self.assertGreater(len(selections), 1)

    def test_random_buildings_require_roles_in_the_game_roster(self):
        requirements = {'Hospital': {'assassin'}, 'Graveyard': {'warlord'},
                        'Keep': {'warlord', 'diplomat', 'marshal'},
                        'Great Wall': {'warlord', 'diplomat', 'marshal'}}
        for count in range(2, 9):
            for seed in range(1, 25):
                with self.subTest(count=count, seed=seed):
                    state = self.create(count, seed=seed)
                    deck = state['deck'] + [c for p in state['players'] for c in p['hand']]
                    for card in deck:
                        if card['en'] in requirements:
                            self.assertTrue(requirements[card['en']] & set(state['charDeck']))
                    self.assertEqual(len(deck), 68)

    def test_role_dependencies_filter_candidates_before_sampling(self):
        for military in (None, 'warlord', 'diplomat', 'marshal'):
            with self.subTest(military=military):
                catalog = deepcopy(cards._catalog)
                catalog['characters'] = [c for c in catalog['characters']
                    if (c['version'] == 'base' and c['num'] not in (1, 8))
                    or c['id'] == 'witch' or c['id'] == military]
                seen = set()
                for seed in range(1, 25):
                    state = self.create(4, seed=seed, catalog=catalog)
                    deck = state['deck'] + [c for p in state['players'] for c in p['hand']]
                    names = {c['en'] for c in deck if c['color'] == 'purple'}
                    self.assertNotIn('Hospital', names)
                    if military != 'warlord':
                        self.assertNotIn('Graveyard', names)
                    if military is None:
                        self.assertTrue(names.isdisjoint({'Keep', 'Great Wall'}))
                    self.assertEqual(len(names), 14)
                    self.assertEqual(len(deck), 68)
                    seen.update(names)
                if military:
                    self.assertTrue({'Keep', 'Great Wall'} <= seen)
                if military == 'warlord':
                    self.assertIn('Graveyard', seen)

        # Assassin makes Hospital eligible, even before anyone drafts it.
        seen = set()
        for seed in range(1, 25):
            state = self.create(4, mode='base', seed=seed)
            seen.update(c['en'] for c in state['deck'])
            seen.update(c['en'] for p in state['players'] for c in p['hand'])
        self.assertIn('Hospital', seen)


@unittest.skipUnless(os.environ.get('CITADELS_TEST_GAME_ENGINE'), 'Compiled game engine required')
class NativeServerScenarioTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_player_setup_and_actions_preserve_scenario(self):
        from python_backend.server import Client, PythonServer

        worker = GameEngineWorker(os.environ['CITADELS_TEST_GAME_ENGINE'])
        try:
            with mock.patch.object(PythonServer, '_load_admin_credentials', return_value=('test', 'test')):
                app = PythonServer(SimpleNamespace(worker=None, game_worker=worker, running=True))
            with mock.patch.object(app, '_schedule_bot'), \
                 mock.patch.object(app, '_broadcast_state', new=mock.AsyncMock()):
                for scenario in [*cards.SCENARIOS, {'id': ''}]:
                    with self.subTest(scenario=scenario['id']):
                        client = Client(None)
                        client.send = mock.AsyncMock()
                        await app._handle_message(client, {'t': 'createRoom', 'name': 'Solo',
                            'config': {'playerCount': 4, 'bots': 3, 'charSetMode': 'base',
                                       'scenario': scenario['id'], 'voice': False}})
                        room = app.rooms.rooms[client.room_id]
                        await app._handle_message(client, {'t': 'startGame'})
                        expected_config = dict(room['state']['config'])
                        expected_roles = ['artist' if c == 'queen' else c
                                          for c in scenario['characters']] if scenario['id'] else room['state']['charDeck']
                        self.assertEqual(room['state']['charDeck'], expected_roles)
                        deck = room['state']['deck'] + [c for p in room['state']['players'] for c in p['hand']]
                        expected_unique = sorted({c['en'] for c in deck if c['color'] == 'purple'})
                        self.assertEqual(len(expected_unique), 14)
                        self.assertEqual(room['state']['uniqueDistricts'], expected_unique)
                        for _ in range(4):
                            actor = worker.current(room['id'])['playerId']
                            action = worker.legal_actions(game_id=room['id'], player_id=actor)['actions'][0]
                            self.assertTrue((await app._apply_game_action(room, actor, action))['ok'])
                            self.assertEqual(room['state']['config'], expected_config)
                            view = await app._state_for_client(room, client.id)
                            self.assertEqual(view['config']['scenario'], scenario['id'])
                            self.assertEqual([c['id'] for c in view['charDeck']], expected_roles)
                            self.assertEqual(view['uniqueDistricts'], expected_unique)
                        public_view = await app._state_for_client(room, None)
                        self.assertEqual(public_view['uniqueDistricts'], expected_unique)
                        if shutil.which('node'):
                            result = subprocess.run([shutil.which('node'), '-e',
                                "const c=require('./src/cards.js'); const s=JSON.parse(require('fs').readFileSync(0,'utf8'));"
                                "process.stdout.write(JSON.stringify(c.districtsForGame(s).filter(d=>d.color==='purple').map(d=>d.en).sort()))"],
                                cwd=ROOT, input=json.dumps(view), capture_output=True, text=True,
                                encoding='utf-8', check=True)
                            self.assertEqual(json.loads(result.stdout), expected_unique)
                        deck = room['state']['deck'] + [c for p in room['state']['players'] for c in p['hand']]
                        self.assertEqual(len(deck), 68)
                        if scenario['id']:
                            self.assertEqual({c['en'] for c in deck if c['color'] == 'purple'},
                                             set(scenario['districts']))
        finally:
            worker.close()


if __name__ == '__main__':
    unittest.main()
