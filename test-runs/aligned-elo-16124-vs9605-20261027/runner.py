"""Matched-search checkpoint evaluation, including the frozen training belief model."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import random
import statistics
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root, out = Path(args.workspace).resolve(), Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
scratch = out/'temp'
scratch.mkdir(exist_ok=True)
tempfile.tempdir = str(scratch)
os.environ['OMP_NUM_THREADS'] = os.environ['MKL_NUM_THREADS'] = '1'
sys.path.insert(0, str(root))
from python_backend import cards
from python_backend.game_engine_worker import GameEngineWorker
from python_backend.native_worker import NativeMctsWorker
from python_backend.neural import NeuralPolicy
from python_backend.belief import BeliefPolicy
from python_backend.policy_selection import select_search_action
from python_backend.strength_eval import state_identity
import torch
torch.set_num_threads(1)

checkpoint_paths = {label: next((root/'training-data').glob(f'checkpoint-{int(label):06d}-*.json.gz'))
                    for label in ('9605','16124')}
with gzip.open(checkpoint_paths['16124'], 'rt', encoding='utf-8') as handle:
    training = json.load(handle)['config']
assert training['beliefNetworkEnabled'] is True
belief_path = root/'training-data/belief/checkpoints'/training['beliefCheckpoint']
engine_path = Path(training['gameEnginePath'])
worker_path = root/'native/mcts_worker_libtorch-a9b69c139fbd.exe'
# Both binaries were compiled from the same source versions; use the one matching
# the local PyTorch 2.14 ABI rather than the training machine's PyTorch 2.1 build.
training_build = json.loads(Path(training['nativeWorkerPath']).with_suffix('.build.json').read_text())
runtime_build = json.loads(worker_path.with_suffix('.build.json').read_text())
assert training_build['sources'] == runtime_build['sources']
assert runtime_build['torch'] == torch.__version__
policies = {label: NeuralPolicy(checkpoint=str(path), worker=object(), device='cpu')
            for label,path in checkpoint_paths.items()}
assert all(policy.status()['configured'] for policy in policies.values())
old_report = json.loads((root/'test-runs/historical-elo-50-20261024/ratings.json').read_text(encoding='utf-8'))
cases = [{key:row[key] for key in ('case','players','cycle','seat','seed','crown')}
         for row in old_report['results'][0]['games']]
assert len(cases) == 50
config = {'simulations': int(training['mctsSimulations']), 'depth':int(training['mctsMaxDepth']),
          'particles':int(training['mctsParticles']), 'batch':int(training['mctsBatchSize']),
          'cPuct':float(training['mctsC_puct']), 'progressiveParticles':True,
          'shareInformationHistory':True, 'learnedBelief':True,
          'beliefCheckpoint':str(belief_path), 'beliefSha256':hashlib.sha256(belief_path.read_bytes()).hexdigest(),
          'selection':'sample', 'temperature':1.0, 'rootNoise':0.0,
          'trainingRootNoise':training['mctsDirichletEpsilon'], 'device':'cpu',
          'opponent':'fixed-hard-heuristic', 'maxSteps':3000, 'maxRounds':100}
report = {'workspace':str(root), 'startedAt':datetime.now(timezone.utc).isoformat(), 'config':config,
          'models':{label:{'checkpoint':str(path), 'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
                    for label,path in checkpoint_paths.items()},
          'engine':str(engine_path), 'worker':str(worker_path),
          'engineSha256':hashlib.sha256(engine_path.read_bytes()).hexdigest(),
          'workerSha256':hashlib.sha256(worker_path.read_bytes()).hexdigest(),
          'schedule':cases, 'workers':8, 'results':[], 'games':[]}
started = time.perf_counter()

def save():
    pending = out/'ratings.json.tmp'
    pending.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    for attempt in range(20):
        try:
            pending.replace(out/'ratings.json')
            return
        except PermissionError:
            if attempt == 19: raise
            time.sleep(.05)

def play(label, case):
    engine = worker = None
    began = time.perf_counter()
    steps = decisions = 0
    actor = f'p{case["seat"]}'
    game_id = f'aligned-{label}-{case["case"]}'
    row = {**case, 'model':label, 'completed':False}
    stats = Counter()
    visits = []
    seen = Counter()
    try:
        engine, worker = GameEngineWorker(engine_path), NativeMctsWorker(worker_path)
        belief = BeliefPolicy(belief_path)
        if belief.model is None: raise RuntimeError(belief.error)
        policy = policies[label]
        state = engine.create_game({'seed':case['seed'], 'charSetMode':'random', 'initialCrownSeat':case['crown'],
            'endDistricts':8, 'startingHand':4, 'startingGold':2, 'catalog':cards._catalog,
            'seats':[{'id':f'p{i}', 'isBot':True, 'botType':'neural' if i==case['seat'] else 'npc',
                      'botLevel':'hard'} for i in range(case['players'])]}, game_id)
        def observed(s): return {**s, 'roomId':game_id, 'createdAt':case['seed']}
        belief.update(observed(state))
        while True:
            current = engine.current(game_id)
            if current.get('gameOver'):
                outcome = engine.current(game_id, include_rewards=True)
                rewards = outcome['rewards']
                values = outcome.get('valueRewards') or rewards
                own = float(values[case['seat']])
                others = [float(v) for i,v in enumerate(values) if i != case['seat']]
                first = rewards[case['seat']] >= 1-1e-6
                winners = sum(v>=1-1e-6 for v in rewards)
                row.update(completed=True, first=first, winShare=1/winners if first else 0,
                    rank=round(1+(1-rewards[case['seat']])*(case['players']-1)/2),
                    pairwiseScore=sum(1. if own>v+1e-6 else .5 if abs(own-v)<=1e-6 else 0. for v in others)/len(others),
                    rounds=current.get('round'))
                break
            if steps>=3000 or current.get('round',0)>100: raise RuntimeError('Step/round limit')
            if current.get('playerId') != actor:
                advanced = engine._request('advance_npcs',gameId=game_id,networkPlayerIds=[actor],
                    seed=(case['seed']+steps)&0xffffffff,maxSteps=min(128,3000-steps),maxRounds=100,
                    includeTrainingFeatures=False,heuristicMcts={'timeBudgetMs':0})
                if advanced.get('state'): belief.update(observed(advanced['state']))
                if not advanced.get('steps') and not advanced.get('gameOver'):
                    raise RuntimeError('NPC did not advance')
                steps += int(advanced.get('steps',0))
                continue
            decision = engine.decision(game_id)
            state, actions = decision['state'], decision['actions']
            digest = state_identity(state)
            seen[digest] += 1
            if seen[digest]>20 or not actions: raise RuntimeError('Repeated state/empty actions')
            belief_state = observed(state)
            frozen = belief.candidate_scorer(belief_state,actor,enabled=True)
            scorer, mixture = frozen if frozen is not None else (None,0.)
            if len(actions)==1:
                action = actions[0]
            else:
                seed = (case['seed']+decisions*0x9E3779B1)&0xffffffff
                log_weights = None
                if scorer is not None:
                    sample = belief.sample(worker,belief_state,actor,config['particles'],seed,enabled=True)
                    if not sample.get('modelApplied'): raise RuntimeError('Learned belief failed: '+belief.error)
                    log_weights = sample.pop('logWeights')
                    stats['learnedSearches'] += 1
                else:
                    sample = worker.determinize(state=state,player_id=actor,count=config['particles'],seed=seed,belief=True)
                    stats['nativePrivatePhaseSearches'] += 1
                search = worker.search(state=sample['particles'][0],particles=sample['particles'][1:],
                    root_player_id=actor,legal_actions=actions,particle_weights=sample['weights'],
                    model_path=policy.model_path,model_version=1,profile=policy.profile,architecture=policy.architecture,
                    device='cpu',simulations=config['simulations'],max_depth=config['depth'],c_puct=config['cPuct'],
                    dirichlet_alpha=training['mctsDirichletAlpha'],dirichlet_epsilon=0,
                    seed=seed^0xA511E9B3,batch_size=config['batch'],action_encoding_version=policy.action_version,
                    progressive_particles=True,root_belief=scorer is None,root_log_weights=log_weights,
                    root_prior_mixture=mixture,root_candidate_scorer=scorer,share_information_history=True)
                if search.get('particleSamplingError'): raise RuntimeError(search['particleSamplingError'])
                if belief.error: raise RuntimeError(belief.error)
                if len(search['policy'])!=len(actions): raise RuntimeError('Search/action mismatch')
                stats['progressiveSearches'] += int(search.get('progressiveParticles') is True)
                stats['particleRefreshes'] += int(search.get('particleRefreshes',0))
                stats['particleProposals'] += int(search.get('particleProposals',0))
                visits.append(int(search.get('visits',0)))
                action = actions[select_search_action(search['policy'],random.Random(seed),'sample')]
                decisions += 1
            engine.apply(game_id=game_id,player_id=actor,action=action,return_state=False)
            steps += 1
    except Exception as error:
        row['failure'] = f'{type(error).__name__}: {error}'
    finally:
        if engine is not None: engine.close()
        if worker is not None: worker.close()
    row.update(steps=steps,decisions=decisions,seconds=time.perf_counter()-began,
               instrumentation=dict(stats),meanVisits=statistics.mean(visits) if visits else None)
    return row

def summarize():
    results = []
    for label in policies:
        valid = [r for r in report['games'] if r['model']==label and r['completed']]
        if not valid: continue
        scores = [r['pairwiseScore'] for r in valid]
        alpha,beta = 1+sum(scores),1+len(scores)-sum(scores)
        probability = alpha/(alpha+beta)
        sigma = math.sqrt(alpha*beta/((alpha+beta)**2*(alpha+beta+1)))
        counts = Counter()
        for row in valid: counts.update(row['instrumentation'])
        results.append({'model':label,'completedGames':len(valid),'rating':1000+400*math.log10(probability/(1-probability)),
            'ratingSigma':400/(math.log(10)*probability*(1-probability))*sigma,
            'firsts':sum(r['first'] for r in valid),'meanRank':statistics.mean(r['rank'] for r in valid),
            'pairwiseScore':statistics.mean(scores),'instrumentation':dict(counts)})
    return results

save()
print('START aligned evaluation: two policies x 50 openings; '+json.dumps(config,ensure_ascii=False),flush=True)
try:
    with ThreadPoolExecutor(max_workers=8) as pool:
        # Interleave models for similar load/thermal conditions.
        futures = [pool.submit(play,label,case) for case in cases for label in policies]
        for future in as_completed(futures):
            row = future.result()
            report['games'].append(row)
            report['results'] = summarize()
            save()
            print(f'{len(report["games"])}/100 {row["model"]} {row["case"]} rank={row.get("rank")} learned={row["instrumentation"].get("learnedSearches",0)} failure={row.get("failure")}',flush=True)
    report.update(finishedAt=datetime.now(timezone.utc).isoformat(),seconds=time.perf_counter()-started,
                  status='complete' if all(r['completed'] for r in report['games']) else 'incomplete')
    save()
    print(json.dumps(report['results'],ensure_ascii=False,indent=2),flush=True)
finally:
    for policy in policies.values():
        if policy._model_dir is not None: policy._model_dir.cleanup()
