import unittest
import numpy as np
import torch
from training.entity_transformer import EntityTransformerNet, migrate_model_weights
from python_backend.training_runtime import _entity_forward_probe_inputs, _entity_parameter_count
from python_backend.model_contract import checkpoint_resume_plan

class KnownEncodingTests(unittest.TestCase):
    def test_v16_migration_preserves_output_and_new_columns_can_learn(self):
        torch.set_num_threads(1)
        for version,action in ((14,9),(14,10),(15,11)):
            torch.manual_seed(42)
            old=EntityTransformerNet('fast',encoding_version=version).eval()
            new=EntityTransformerNet('fast',encoding_version=16).eval()
            migrate_model_weights(old,new,action,12)
            s,a=_entity_forward_probe_inputs(version)[0]
            if action==9: a[:,182:]=0
            ns=np.zeros(2486,np.float32);na=np.zeros((len(a),448),np.float32)
            na[:,:a.shape[1]]=a
            if version==14:
                ns[:1504]=s[:1504];ns[1504:1534]=s[1504:1534];ns[1558:1814]=s[1534:1790]
            else: ns[:2054]=s
            ns[0]=16;ns[2054:]=.2
            with torch.inference_mode():
                po,vo=old(torch.tensor(s)[None],torch.tensor(a)[None])
                pn,vn=new(torch.tensor(ns)[None],torch.tensor(na)[None])
            torch.testing.assert_close(po,pn,rtol=2e-5,atol=2e-5)
            torch.testing.assert_close(vo,vn,rtol=2e-5,atol=2e-5)
            self.assertEqual(torch.count_nonzero(new.global_embed.weight[:,528:]).item(),0)
            logits,values=new(torch.tensor(ns)[None],torch.tensor(na)[None])
            (logits.square().mean()+values.square().mean()).backward()
            self.assertGreater(new.global_embed.weight.grad[:,528:].abs().sum().item(),0)
        self.assertEqual(sum(p.numel() for p in new.parameters()),_entity_parameter_count('fast',16))
