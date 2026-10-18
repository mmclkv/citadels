"""Growing-world search, probability conservation and scoring IPC regressions."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from python_backend.native_worker import NativeMctsWorker


class RootParticleTests(unittest.TestCase):
    def test_initial_sampling_is_deducted_from_total_live_budget(self):
        from python_backend.neural import NeuralPolicy
        requests=[]
        policy=NeuralPolicy.__new__(NeuralPolicy)
        policy.worker=SimpleNamespace(determinize=lambda **kw:dict(particles=[{}],weights=[1]),
            search=lambda **kw:requests.append(kw) or dict(policy=[.5,.5],particlesUsed=8))
        policy.model_path=__file__;policy.profile='fast';policy.architecture='entity-v6'
        policy.device_name='cpu';policy.action_version=11
        with patch('python_backend.neural.time.perf_counter',side_effect=[10.,10.25,10.8]):
            policy.decide({},'p0',{'actions':[{'type':'take_gold'},{'type':'take_cards'}]},
                {'advancedEnabled':False,'timeBudgetMs':1000})
        self.assertEqual(requests[0]['time_budget_ms'],750)
        self.assertTrue(requests[0]['progressive_particles'])
        self.assertEqual(policy._last_mcts['particleSamplingMs'],250)
        # Exhausted budgets stay timed: zero would mean unlimited C++ search.
        with patch('python_backend.neural.time.perf_counter',side_effect=[10.,12.,12.]):
            policy.decide({},'p0',{'actions':[{},{}]},
                {'advancedEnabled':False,'timeBudgetMs':1000})
        self.assertEqual(requests[-1]['time_budget_ms'],1)

    def test_native_coverage_and_probability_mass(self):
        compiler = shutil.which('clang++')
        if not compiler:
            self.skipTest('clang++ required')
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='root-particles-') as folder:
            executable = Path(folder) / ('test.exe' if os.name == 'nt' else 'test')
            compiled = subprocess.run([compiler, '-std=c++17', '-O2',
                str(root/'native/root_particles_regression.cpp'), '-o', str(executable)],
                capture_output=True, text=True, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            tested = subprocess.run([str(executable)], capture_output=True, text=True, timeout=60)
            self.assertEqual(tested.returncode, 0, tested.stdout+tested.stderr)

    def test_scoring_failure_answers_worker_and_preserves_next_request(self):
        responses = [dict(t='root_candidates', id='1', particles=[{}, {}]),
            dict(t='search_result', id='1', policy=[1.], progressiveParticles=True,
                 actionEncodingVersion=11, supportedActionEncodingVersion=11, stateEncodingVersion=15),
            dict(t='search_result', id='2', policy=[1.], progressiveParticles=True,
                 actionEncodingVersion=11, supportedActionEncodingVersion=11, stateEncodingVersion=15)]
        worker = NativeMctsWorker.__new__(NativeMctsWorker)
        worker._lock=threading.Lock();worker._request_id=0
        worker.process=SimpleNamespace(poll=lambda:None,stdin=io.StringIO(),
            stdout=io.StringIO('\n'.join(json.dumps(r) for r in responses)+'\n'))
        kwargs=dict(state={},particles=[],root_player_id='p0',legal_actions=[{}],
            particle_weights=[1],model_path='test.bin',model_version=1,profile='fast',
            architecture='entity-v6',device='cpu',simulations=64,max_depth=10,c_puct=1.,
            dirichlet_alpha=.3,dirichlet_epsilon=0.,seed=1,progressive_particles=True)
        def broken(worlds):
            raise ValueError('score failure')
        worker.search(**kwargs,root_candidate_scorer=broken)
        worker.search(**kwargs)
        sent=[json.loads(line) for line in worker.process.stdin.getvalue().splitlines()]
        self.assertEqual(sent[1],dict(id='1',error='score failure'))
        self.assertEqual(sent[2]['id'],'2')

    def test_frozen_belief_scorer_keeps_cross_batch_scale(self):
        import numpy as np
        import torch
        from python_backend.belief import BeliefPolicy
        from python_backend.test_belief import fixture
        from training.belief_network import BeliefNetwork
        torch.set_num_threads(1)
        policy=BeliefPolicy();policy.model=BeliefNetwork(64).eval()
        policy.metadata={'historyLength':32,'priorMixture':.2}
        state=fixture();worlds=[fixture(),fixture()]
        scorer, mixture=policy.candidate_scorer(state,'p0')
        together=scorer(worlds)
        policy.disable()
        # Model replacement/disable cannot change a search already in progress.
        separate=[scorer([world])[0] for world in worlds]
        np.testing.assert_allclose(together,separate,rtol=0,atol=1e-4)
        self.assertEqual(mixture,.2)


@unittest.skipUnless(os.environ.get('CITADELS_TEST_GAME_ENGINE'), 'compiled game engine required')
class RootParticleNativeProtocolTests(unittest.TestCase):
    def test_real_states_refresh_scoring_failure_and_private_information(self):
        from python_backend.game_engine_worker import GameEngineWorker
        compiler=shutil.which('clang++')
        if not compiler:
            self.skipTest('clang++ required')
        root=Path(__file__).resolve().parents[1]
        engine=GameEngineWorker(os.environ['CITADELS_TEST_GAME_ENGINE'])
        with tempfile.TemporaryDirectory(prefix='root-worker-') as folder:
            executable=Path(folder)/('worker.exe' if os.name=='nt' else 'worker')
            args=[compiler,'-std=c++17','-O1',str(root/'native/mcts_worker.cpp'),'-o',str(executable)]
            if os.name=='nt':args.append('-ldbghelp')
            built=subprocess.run(args,capture_output=True,text=True,timeout=120)
            self.assertEqual(built.returncode,0,built.stderr)
            process=subprocess.Popen([str(executable)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                text=True,encoding='utf-8')
            def request(payload,fail=False):
                process.stdin.write(json.dumps(payload,ensure_ascii=False)+'\n');process.stdin.flush()
                while True:
                    response=json.loads(process.stdout.readline())
                    if response.get('t')!='root_candidates':return response
                    # Keep the same probability scale across callbacks.
                    answer=dict(id=payload['id'],error='expected test failure') if fail else dict(
                        id=payload['id'],logWeights=[0.]*len(response['particles']))
                    process.stdin.write(json.dumps(answer,ensure_ascii=False)+'\n');process.stdin.flush()
            try:
                for n in (4,6,8):
                    game_id=str(n)
                    engine.create_game(dict(seed=1900+n,endDistricts=8,charSetMode='random',
                        catalog=json.loads((root/'python_backend/catalog.json').read_text(encoding='utf-8')),
                        seats=[dict(id=f'p{i}',botLevel='normal',isBot=True,botType='neural') for i in range(n)]),game_id)
                    decision=engine.decision(game_id);before=engine.snapshot(game_id)
                    sampled=request(dict(id='sample',mode='determinize',state=before,
                        playerId=decision['playerId'],count=4,seed=17,belief=False))
                    self.assertEqual(sampled['t'],'determinize_result',sampled)
                    worlds=sampled['particles'];viewer=next(i for i,p in enumerate(before['players']) if p['id']==decision['playerId'])
                    payload=dict(id=game_id,state=worlds[0],particles=worlds[1:],
                        rootPlayerId=decision['playerId'],legalActions=decision['actions'],
                        particleWeights=sampled['weights'],progressiveParticles=True,
                        simulations=256,maxDepth=16,seed=93,timeBudgetMs=0,actionEncodingVersion=11)
                    for learned,fail in ((False,False),(True,False),(True,True)):
                        payload.update(scoreRootCandidates=learned,rootLogWeights=[0.]*4,rootPriorMixture=.2 if learned else 0.)
                        result=request(payload,fail)
                        self.assertEqual(result['t'],'search_result',result)
                        self.assertFalse(result['fallback'])
                        self.assertEqual(result['visits'],256)
                        self.assertGreater(result['particleRefreshes'],0)
                        if fail:
                            self.assertEqual(result['particleSamplingError'],'expected test failure')
                            self.assertEqual(result['particleProposals'],4)
                        else:self.assertGreater(result['particlesUsed'],4)
                    self.assertEqual(engine.snapshot(game_id),before)
                    self.assertEqual(worlds[0]['players'][viewer]['hand'],before['players'][viewer]['hand'])
            finally:
                process.stdin.close();process.wait(timeout=10);process.stdout.close();engine.close()


if __name__=='__main__':
    unittest.main()
