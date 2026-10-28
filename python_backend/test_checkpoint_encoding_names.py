import gzip,json,tempfile,unittest
from pathlib import Path
import torch
from training.gpu_trainer import create_model
from python_backend.training_config import sanitize_config
from python_backend.training_runtime import TrainingManager

class CheckpointEncodingNameTests(unittest.TestCase):
    def test_new_encoding_cannot_overwrite_same_step_legacy_checkpoint(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as directory:
            legacy=Path(directory)/'checkpoint-000001-pfast-aentity-v6-m500-crandom-s114514.json.gz'
            legacy.write_bytes(b'old checkpoint preserved')
            manager=TrainingManager(directory)
            manager._torch=torch;manager._model=create_model('entity-v6','fast',16)
            manager._optimizer=torch.optim.Adam(manager._model.parameters(),lr=.0003)
            config=sanitize_config({'profile':'fast','seed':114514})
            name=manager._save_checkpoint(config,1)
            self.assertIn('-sv16-av12',name)
            self.assertEqual(legacy.read_bytes(),b'old checkpoint preserved')
            payload=json.loads(gzip.decompress((Path(directory)/name).read_bytes()))
            self.assertEqual(payload['encoding'],{'state':16,'action':12})
            self.assertTrue((Path(directory)/name.replace('.json.gz','.optimizer.pt')).exists())
