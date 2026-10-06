import random
import os
from types import SimpleNamespace
import unittest

from python_backend.policy_selection import select_search_action
from python_backend.strength_eval import ArenaConfig, schedule, summarize, paired_comparison, run_game


class ArenaTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('CITADELS_ARENA_MCTS_WORKER'), 'isolated native workers required')
    def test_native_worker_smoke(self):
        from python_backend.game_engine_worker import GameEngineWorker
        from python_backend.native_worker import NativeMctsWorker
        from python_backend.neural import NeuralPolicy
        worker = NativeMctsWorker(os.environ['CITADELS_ARENA_MCTS_WORKER'])
        engine = GameEngineWorker(os.environ['CITADELS_ARENA_GAME_ENGINE'],
                                  env=dict(os.environ, CITADELS_HEURISTIC_MCTS_ENABLED='0'))
        policy = None
        try:
            policy = NeuralPolicy(os.environ['CITADELS_ARENA_CHECKPOINT'], device='cpu', worker=worker)
            self.assertFalse(policy.error, policy.error)
            config = ArenaConfig(players=(5,), cycles=1, simulations=1, particles=1,
                                 depth=4, batch=1, max_rounds=1)
            for case in schedule(config)[:2]:
                for selection in ('argmax', 'sample'):
                    result = run_game(engine, worker, policy, case, selection, config)
                    self.assertEqual(result['failure'], 'step/round limit', result)
                    self.assertGreater(result['decisions'], 0)
            # Same weights and encoded inputs, both implementations, v10 suffix included.
            import torch
            from python_backend.training_runtime import _entity_forward_probe_inputs
            from training.entity_transformer import EntityTransformerNet
            torch.set_num_threads(1)
            model = EntityTransformerNet(policy.profile).eval()
            model.load_flat(policy.model_path)
            cases = _entity_forward_probe_inputs()
            outputs = worker.forward_probe(probes=[{'stateFeatures': s.tolist(), 'actionFeatures': a.tolist()}
                                                   for s, a in cases], model_path=policy.model_path,
                profile=policy.profile, architecture=policy.architecture, device='cpu', action_encoding_version=10)
            self.assertEqual(len(outputs['results']), len(cases))
            with torch.inference_mode():
                for (state, actions), output in zip(cases, outputs['results']):
                    logits, values = model(torch.from_numpy(state)[None], torch.from_numpy(actions)[None])
                    torch.testing.assert_close(logits[0], torch.tensor(output['logits']), rtol=5e-4, atol=5e-4)
                    torch.testing.assert_close(values[0], torch.tensor(output['values']), rtol=5e-4, atol=5e-4)
            # New search encoding is explicitly confirmed by the isolated worker.
            policy.action_version = 10
            result = run_game(engine, worker, policy, schedule(config)[0], 'argmax', config)
            self.assertEqual(result['failure'], 'step/round limit', result)
        finally:
            engine.close()
            worker.close()
            if policy and policy._model_dir:
                policy._model_dir.cleanup()

    def test_schedule_balances_seats_and_fixes_openings(self):
        config = ArenaConfig(players=(4, 5), cycles=3)
        cases = schedule(config)
        self.assertEqual(cases, schedule(config))
        self.assertEqual(len(cases), 27)
        for cycle in range(3):
            for n in (4, 5):
                group = [c for c in cases if c['cycle'] == cycle and c['players'] == n]
                self.assertEqual({c['seat'] for c in group}, set(range(n)))
                self.assertEqual(len({c['seed'] for c in group}), 1)
        with self.assertRaises(ValueError):
            schedule(ArenaConfig(players=(4, 4)))

    def test_shared_selection_and_invalid_distributions(self):
        self.assertEqual(select_search_action([.2, .4, .4], random.Random(1), 'argmax'), 1)
        self.assertEqual(select_search_action([.2, .8], random.Random(1)),
                         select_search_action([.2, .8], random.Random(1)))
        for values in ([], [0, 0], [-1, 2], [float('nan')], [float('inf')], [1e308, 1e308]):
            with self.assertRaises(ValueError):
                select_search_action(values, random.Random(1))

    def test_failed_games_are_not_hidden(self):
        rows = [{'variant': 'a', 'players': 4, 'completed': True, 'first': True, 'reward': 1, 'rank': 1},
                {'variant': 'a', 'players': 4, 'completed': False, 'first': False}]
        result = summarize(rows)[0]
        self.assertEqual(result['failed'], 1)
        self.assertEqual(result['firstRateAllAttempts'], .5)
        self.assertEqual(result['firstRateCompleted'], 1)

    def test_pairs_require_full_schedule_and_independent_seed_blocks(self):
        cases = schedule(ArenaConfig(players=(4,), cycles=31))
        rows = [{**case, 'variant': variant, 'completed': True, 'reward': reward}
                for case in cases for variant, reward in [('a', 1.), ('b', -1.)]]
        complete = paired_comparison(rows, 'a', 'b', cases)
        self.assertTrue(complete['promotionEligible'])
        self.assertEqual(complete['completeSeedBlocks'], 31)
        partial = paired_comparison(rows[:-8], 'a', 'b', cases)
        self.assertFalse(partial['promotionEligible'])
        self.assertEqual(partial['missingOrFailedPairs'], 4)
        correlated = paired_comparison(rows[:8], 'a', 'b', cases[:4])
        self.assertIsNone(correlated['approxSeedBlock95CI'])
        with self.assertRaises(ValueError):
            paired_comparison(rows + [rows[0]], 'a', 'b', cases)
        with self.assertRaises(ValueError):
            paired_comparison([{**rows[0], 'seed': 0}], 'a', 'b', cases)

    def test_run_game_uses_native_search_and_skips_forced_decisions(self):
        class Engine:
            count = 0
            closed = False
            def create_game(self, settings, game_id):
                self.settings = settings
            def current(self, game_id, include_rewards=False):
                return {'gameOver': self.count == 2, 'round': 1, 'playerId': 'p0', 'rewards': [1., -1.]}
            def decision(self, game_id):
                return {'state': {'step': self.count}, 'actions': [{'type': 'forced'}] if not self.count else
                        [{'type': 'a'}, {'type': 'b'}]}
            def apply(self, **kwargs):
                self.count += 1
                self.last = kwargs['action']
            def close_game(self, game_id):
                self.closed = True
        class Worker:
            def determinize(self, **kwargs):
                return {'particles': [kwargs['state']], 'weights': [1.]}
            def search(self, **kwargs):
                self.request = kwargs
                return {'policy': [.1, .9]}
        engine, worker = Engine(), Worker()
        policy = SimpleNamespace(model_path='fixed.bin', profile='fast', architecture='entity-v6', action_version=10)
        case = schedule(ArenaConfig(players=(2,)))[0]
        result = run_game(engine, worker, policy, case, 'argmax', ArenaConfig(players=(2,)))
        self.assertTrue(result['completed'])
        self.assertTrue(result['first'])
        self.assertEqual(result['decisions'], 1)
        self.assertEqual(result['steps'], 2)
        self.assertEqual(engine.last, {'type': 'b'})
        self.assertTrue(engine.closed)
        self.assertEqual(worker.request['dirichlet_epsilon'], 0)
        self.assertEqual(worker.request['action_encoding_version'], 10)


if __name__ == '__main__':
    unittest.main()
