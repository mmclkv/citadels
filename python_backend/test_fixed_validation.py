import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
import torch
from python_backend.fixed_validation import FixedValidation,validation_sample_seed,evaluate_fixed_validation
from python_backend.training_config import sanitize_config
from python_backend.model_contract import config_contract
from python_backend.training_runtime import _sample_task
from training.entity_transformer import EntityTransformerNet

def fixture():
    c=sanitize_config({'seed':31,'targetGames':5000,'validationGames':2,'validationGamesPerBatch':1})
    s=np.zeros(2486,np.float32);s[0]=16;s[1]=.5;s[49]=1
    row={'state':s,'actions':np.zeros((2,448),np.float32),'pi':np.array([.7,.3],np.float32),
         'reward':np.array([1,-.86,-.93,-1,0,0,0,0],np.float32),'valueMask':np.array([1,1,1,1,0,0,0,0],np.float32)}
    return c,row

class FixedValidationTests(unittest.TestCase):
    def test_seeds_are_disjoint_and_validation_task_is_identified(self):
        c,row=fixture()
        training={(c['seed']+i*0x9E3779B1)&0xffffffff for i in range(1,5001)}
        self.assertTrue(all(validation_sample_seed(c,i) not in training for i in range(32)))
        with tempfile.TemporaryDirectory() as d:
            v=FixedValidation(d,c);task=v.tasks(False)[0]
            with patch('python_backend.training_runtime._sample_game',return_value={'completed':True,'rows':[row]}) as sampler:
                result=_sample_task(c,task,None)
                self.assertIn('validationIndex',result)
                self.assertEqual(sampler.call_args.args[0]['_sampleSeed'],task['sampleSeed'])
                self.assertEqual(result['sampleSeed'],task['sampleSeed'])
                self.assertTrue(v.add(result));self.assertFalse(v.add(result))
                self.assertEqual(len(v.tasks(False)),1)

    def test_entire_games_freeze_reload_and_do_not_alias_training_rows(self):
        c,row=fixture()
        with tempfile.TemporaryDirectory() as d:
            v=FixedValidation(d,c)
            for index in range(2):
                v.add({'validationIndex':index,'sampleSeed':validation_sample_seed(c,index),
                       'completed':True,'rows':[row]*140})
            self.assertEqual(len(v.rows()),256);self.assertEqual(v.tasks(False),[])
            before=v.path.read_bytes();row['state'][33]=123
            loaded=FixedValidation(d,c)
            self.assertEqual(loaded.path.read_bytes(),before)
            self.assertEqual(loaded.rows()[0]['state'][33],0)
            self.assertEqual(loaded.tasks(False),[])
            with self.assertRaises(ValueError):
                FixedValidation(d,{**c,'validationGames':3}).add({'validationIndex':2,'sampleSeed':0,'completed':True,'rows':[row]})

    def test_validation_forward_has_no_gradient_or_parameter_updates(self):
        c,row=fixture();torch.set_num_threads(1)
        model=EntityTransformerNet('fast',encoding_version=16)
        before={k:v.clone() for k,v in model.state_dict().items()}
        stats=evaluate_fixed_validation(model,torch.device('cpu'),[row],config_contract(c))
        self.assertTrue(model.training)
        self.assertTrue(all(p.grad is None for p in model.parameters()))
        for name,value in model.state_dict().items(): torch.testing.assert_close(value,before[name],atol=0,rtol=0)
        self.assertIn('validationValueLoss',stats);self.assertIn('4',stats['validationByPlayers'])
        self.assertIn('early',stats['validationByStage']);self.assertIn('neural',stats['validationByActor'])
        self.assertTrue(np.isfinite(stats['validationBaselineValueLoss']))

    def test_large_game_count_keeps_storage_bounded(self):
        c,row=fixture()
        with tempfile.TemporaryDirectory() as d:
            v=FixedValidation(d,{**c,'validationGames':256})
            v.add({'validationIndex':0,'sampleSeed':validation_sample_seed(c,0),'completed':True,'rows':[row]*140})
            self.assertEqual(len(v.rows()),16)
            self.assertNotEqual(v.path,FixedValidation(d,c).path)

    def test_disabled_validation_never_collects(self):
        c,_=fixture()
        with tempfile.TemporaryDirectory() as d:
            v=FixedValidation(d,{**c,'validationGames':0})
            self.assertEqual(v.tasks(False),[]);self.assertEqual(v.rows(),[])
            self.assertFalse(v.path.exists())
