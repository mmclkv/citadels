from __future__ import annotations
import copy
import json
import os
import time
from pathlib import Path
import tempfile
import threading
import unittest
import numpy as np
from python_backend import cards
from python_backend.belief_encoding import (observe, labels, BeliefHistory, C, M, contract,
    prior_hand_log_probability, card_counts)
from python_backend.belief_training import normalize_config, save_game, read_game, BeliefTrainingManager


def fixture():
    pile = []
    for definition in cards.DISTRICTS:
        for _ in range(definition['count']):
            pile.append(dict(definition, uid='secret-'+str(len(pile))))
    roles = [r['id'] for r in cards.CHARACTERS if r['version'] == 'base']
    players = [dict(id=f'p{i}', gold=2, hand=pile[i*4:i*4+4], city=[], chars=[roles[i]],
                    played=[], hasCrown=i==0) for i in range(4)]
    return dict(phase='action', round=1, players=players, deck=pile[16:], discard=[],
        charDeck=roles, turn=dict(playerIdx=0, charId=roles[0], phase='act', pending=None),
        config=dict(endDistricts=8), draft=None, draftPublic={'faceUp':[]}, roomId='test', createdAt=1)


class BeliefObservationTests(unittest.TestCase):
    def test_hidden_identities_and_private_logs_cannot_change_observation(self):
        state = fixture();changed = copy.deepcopy(state)
        for p in changed['players'][1:]:
            p['hand'] = [dict(cards.DISTRICTS[-1], uid='changed') for _ in p['hand']]
            p['chars'] = [state['charDeck'][-1]]
        changed['deck'] = [];changed['rngState'] = 999
        changed['observations'] = [{'role_id':'wizard','secret':True}]
        changed['log'] = [{'text':'private secret'}]
        a, b = observe(state, 'p0'), observe(changed, 'p0')
        for key in a:
            np.testing.assert_array_equal(a[key], b[key], err_msg=key)
        history_a, history_b = BeliefHistory(), BeliefHistory()
        history_a.update(state);history_b.update(changed)
        np.testing.assert_array_equal(history_a.for_player('p0'),history_b.for_player('p0'))
        self.assertNotEqual(labels(state,'p0',a)['hands'].tolist(),labels(changed,'p0',b)['hands'].tolist())

    def test_visible_changes_and_wizard_information_are_encoded(self):
        state = fixture();before=observe(state,'p0')
        state['players'][1]['gold'] += 2
        self.assertFalse(np.array_equal(before['players'],observe(state,'p0')['players']))
        state['turn']['pending'] = dict(kind='wizard_card',targetIdx=1)
        seen=observe(state,'p0')
        self.assertNotIn(1,seen['handPlayers'])
        self.assertIn(1,observe(state,'p2')['handPlayers'])

    def test_witch_execution_is_not_role_ownership_even_at_round_end(self):
        state=fixture()
        state['phase']='roundConfirm';state['turn']=None
        state['players'][0]['chars']=['witch'];state['players'][0]['played']=['witch','emperor']
        state['players'][1]['chars']=['emperor']
        state['charDeck']+=['witch','emperor']
        state.update(effects={'witchBy':0,'bewitched':4,'assassinated':None},callIdx=0,
                     callQueue=[dict(playerIdx=1,charId='emperor',num=4)])
        observation=observe(state,'p2')
        # Relative seats 2 and 3 own Witch and Emperor; neither is unknown.
        self.assertNotIn(3,observation['rolePlayers'])
        from python_backend.belief_encoding import ROLE_INDEX
        self.assertEqual(observation['players'][2,-len(cards.CHARACTERS)+ROLE_INDEX['emperor']],0)

    def test_history_deduplicates_broadcasts_and_dataset_is_non_pickle(self):
        state=fixture();history=BeliefHistory(8);history.update(state);history.update(state)
        self.assertEqual(len(history.for_player('p0')),1)
        observation=observe(state,'p0')
        sample=dict(observation=observation,target=labels(state,'p0',observation),history=history.for_player('p0'))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'game.npz'
            save_game(path,[sample],dict(samples=1,validation=True))
            meta,samples=read_game(path)
            self.assertTrue(meta['validation'])
            np.testing.assert_array_equal(samples[0]['target']['hands'],sample['target']['hands'])
            with np.load(path,allow_pickle=False) as archive:
                self.assertTrue(all(archive[k].dtype != object for k in archive.files))

    def test_config_and_checkpoint_paths_reject_invalid_values(self):
        for value in ({'workers':0},{'targetGames':True},{'learningRate':float('nan')},{'dimension':65}):
            with self.assertRaises(ValueError):normalize_config(value)
        with tempfile.TemporaryDirectory() as directory:
            manager=BeliefTrainingManager(directory)
            with self.assertRaises(ValueError):manager.checkpoint_path('../belief-secret.npz')
            with self.assertRaises(ValueError):manager.start({})

    def test_replay_keeps_recent_and_long_term_games_with_bounded_storage(self):
        import random
        from python_backend.belief_training import retain_game
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            for i in range(40):
                path=folder/f'game-{i:03d}.npz';path.write_bytes(b'test')
                retain_game(folder,path,8,random.Random(i))
            files={p.name for p in folder.glob('game-*.npz')}
            self.assertEqual(len(files),8)
            self.assertTrue({f'game-{i:03d}.npz' for i in range(36,40)}<=files)
            self.assertTrue(any(int(name[5:8])<32 for name in files))


class BeliefNetworkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import torch
        torch.set_num_threads(1)

    def test_joint_constraints_batch_parity_training_and_safe_reload(self):
        import torch
        from training.belief_network import BeliefNetwork,save_checkpoint,load_checkpoint,restore_optimizer
        state=fixture();observation=observe(state,'p0');target=labels(state,'p0',observation)
        history=BeliefHistory();history.update(state);events=history.for_player('p0')
        torch.manual_seed(7)
        model=BeliefNetwork(64).eval()
        with torch.inference_mode():
            swapped=copy.deepcopy(observation)
            swapped['players'][1,0]=.05;swapped['players'][2,0]=.45
            first=model.encode(swapped,events)
            swapped['players'][[1,2]]=swapped['players'][[2,1]]
            self.assertFalse(torch.allclose(first,model.encode(swapped,events)))
            single=model.joint(observation,events,target)['logProbability']
            batch=model.score_candidates(observation,events,[target,target])
            torch.testing.assert_close(batch,single.expand(2),atol=2e-4,rtol=2e-4)
            draw=model.joint(observation,events)
            self.assertEqual(len(set(draw['roles'].tolist())),len(draw['roles']))
            np.testing.assert_array_equal(draw['hands'].sum(1),observation['handSizes'])
            self.assertTrue((draw['hands'].sum(0)<=observation['remaining']).all())
        optimizer=torch.optim.Adam(model.parameters(),lr=.002)
        before=float(single)
        for _ in range(3):
            optimizer.zero_grad();result=model.joint(observation,events,target)
            loss=-result['logProbability'];loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),5);optimizer.step()
        after=float(model.joint(observation,events,target)['logProbability'].detach())
        self.assertGreater(after,before)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'belief-test.npz'
            save_checkpoint(path,model,dict(games=3,historyLength=128),optimizer)
            loaded,metadata,states=load_checkpoint(path)
            loaded.eval()
            torch.testing.assert_close(loaded.joint(observation,events,target)['logProbability'],
                                       model.joint(observation,events,target)['logProbability'])
            restored=torch.optim.Adam(loaded.parameters());restore_optimizer(loaded,restored,states)
            self.assertTrue(restored.state)
            self.assertEqual(metadata['contract'],contract())

    def test_native_proposal_correction_and_inference_fallback(self):
        from training.belief_network import BeliefNetwork,save_checkpoint
        from python_backend.belief import BeliefPolicy
        from types import SimpleNamespace
        state=fixture();observation=observe(state,'p0')
        self.assertTrue(np.isfinite(prior_hand_log_probability(state,'p0',observation)))
        calls=[]
        def determinize(**kwargs):
            calls.append(kwargs)
            return dict(particles=[copy.deepcopy(state) for _ in range(kwargs['count'])],weights=[1.]*kwargs['count'])
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'belief-test.npz'
            save_checkpoint(path,BeliefNetwork(64),dict(games=1,historyLength=32,candidateCount=4,priorMixture=.2))
            policy=BeliefPolicy(path)
            samples=policy.sample(SimpleNamespace(determinize=determinize),state,'p0',2,42)
            self.assertEqual(len(samples['particles']),2)
            self.assertFalse(policy.error,policy.error)
            self.assertIsNotNone(policy.last)
            self.assertFalse(calls[-1]['belief'])
            state['turn']['pending']={'kind':'lighthouse'}
            policy.sample(SimpleNamespace(determinize=determinize),state,'p0',2,42)
            self.assertTrue(calls[-1]['belief'])


@unittest.skipUnless(os.environ.get('CITADELS_BELIEF_GAME_ENGINE'), 'native game engine required')
class BeliefNativeTests(unittest.TestCase):
    def test_collect_train_validate_resume_and_stop(self):
        import torch
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as directory:
            manager=BeliefTrainingManager(directory,os.environ['CITADELS_BELIEF_GAME_ENGINE'])
            config=dict(targetGames=4,minPlayers=4,maxPlayers=4,opponents='heuristic',charSet='base',
                batchGames=2,checkpointEvery=2,dimension=64,historyLength=8,samplesPerGame=3,
                sampleEvery=10,updateSamples=2,miniBatch=1,validationEvery=2,replayGames=8,maxSteps=3000)
            def finish():
                deadline=time.monotonic()+90
                while manager.status()['running'] and time.monotonic()<deadline:time.sleep(.05)
                if manager.status()['running']:manager.stop()
                self.assertFalse(manager.status()['running'],manager.status())
                self.assertNotEqual(manager.status()['state'],'error',manager.status()['error'])
                return manager.status()
            manager.start(config);status=finish()
            self.assertEqual(status['completedGames'],4)
            self.assertGreater(status['metrics']['validationSamples'],0)
            self.assertTrue(manager.checkpoint_path(status['checkpoint']).is_file())
            manager.start(dict(config,targetGames=2,resumeCheckpoint=status['checkpoint']))
            status=finish();self.assertEqual(status['totalGames'],6)
            manager.start(dict(config,targetGames=1000));manager.stop()
            status=finish();self.assertEqual(status['state'],'stopped')


if __name__ == '__main__':unittest.main()
