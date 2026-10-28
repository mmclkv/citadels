import tempfile,time,unittest
from python_backend.training_runtime import TrainingManager
from python_backend.fixed_validation import FixedValidation

class ValidationIntegrationTests(unittest.TestCase):
    def test_completed_validation_games_do_not_enter_training_count_or_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=TrainingManager(directory)
            manager.start({'targetGames':1,'minPlayers':2,'maxPlayers':2,'charSet':'base',
                'profile':'fast','device':'cpu','workers':1,'mctsSimulations':2,'mctsParticles':1,
                'mctsMaxDepth':20,'batchGames':1,'trainingEpochs':1,'miniBatch':32,
                'checkpointEvery':1,'maxRounds':50,'seed':8162,'historicalPoolSize':0,
                'weaknessSearchEvery':0,'validationGames':1,'validationGamesPerBatch':1,
                'selfPlayMode':'network-vs-heuristic','networkPlayerCount':1,'heuristicDifficulty':'normal'})
            deadline=time.monotonic()+120
            while manager.status()['running'] and time.monotonic()<deadline:time.sleep(.1)
            s=manager.status()
            if s['running']:manager.stop()
            self.assertEqual(s['state'],'completed',s.get('error'))
            self.assertEqual(s['completedGames'],1)
            self.assertEqual(s['point']['replayBufferGames'],1)
            self.assertEqual(s['point']['validationGames'],1)
            self.assertGreater(s['point']['validationSamples'],0)
            self.assertIn('validationValueLoss',s['history'][-1])
            frozen=FixedValidation(directory,s['config'])
            self.assertEqual(frozen.tasks(False),[])
