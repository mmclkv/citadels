"""Four frozen policy checkpoints at the same table, with balanced seat rotations."""
import argparse
import array
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import statistics
import sys
import tempfile
import threading
import time

p = argparse.ArgumentParser()
p.add_argument('--workspace', required=True)
p.add_argument('--output', required=True)
p.add_argument('--budget-ms', type=int, default=5000)
p.add_argument('--simulations', type=int, default=2147483647)
p.add_argument('--workers', type=int, default=8)
p.add_argument('--blocks', type=int, default=13)
p.add_argument('--smoke', action='store_true')
p.add_argument('--resume', action='store_true')
args = p.parse_args()
root, out = Path(args.workspace).resolve(), Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
scratch = out / 'temp'
scratch.mkdir(exist_ok=True)
tempfile.tempdir = str(scratch)
os.environ['OMP_NUM_THREADS'] = os.environ['MKL_NUM_THREADS'] = '1'
sys.path.insert(0, str(root))
import numpy as np
from python_backend import cards
from python_backend.game_engine_worker import GameEngineWorker
from python_backend.native_worker import NativeMctsWorker
from python_backend.model_contract import validate_checkpoint_contract
from python_backend.policy_selection import select_search_action
from python_backend.strength_eval import state_identity
import torch
torch.set_num_threads(1)
labels = ['4095', '7039', '9605', '22031']
engine_path = root / 'native/game_engine-c7652847a6b9.exe'
worker_path = root / 'native/mcts_worker_libtorch-a9b69c139fbd.exe'
models = {}
for label in labels:
    matches = list((root / 'training-data').glob(f'checkpoint-{int(label):06d}-*.json.gz'))
    if len(matches) != 1:
        raise ValueError(f'Expected exactly one checkpoint for {label}, found {len(matches)}')
    path = matches[0]
    with gzip.open(path, 'rt', encoding='utf-8') as handle:
        cp = json.load(handle)
    contract = validate_checkpoint_contract(cp, 'entity-v6')
    meta = cp['model']
    if len(meta['flat']) != meta['parameterCount']:
        raise ValueError('Invalid weight count')
    model_dir = out / 'frozen-models'
    model_dir.mkdir(exist_ok=True)
    flat = model_dir / f'{label}.bin'
    weights = array.array('f', meta['flat'])
    with flat.open('wb') as handle:
        weights.tofile(handle)
    models[label] = {'checkpoint': str(path), 'checkpointSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                     'flat': str(flat), 'profile': meta['profile'], 'architecture': meta['architecture'],
                     'stateEncoding': contract['state'], 'actionEncoding': contract['action']}

orders = [(0,) + perm for perm in itertools.permutations((1, 2, 3))]
schedule_rng = random.Random(20261024)
schedule_rng.shuffle(orders)
cases = []
for block in range(args.blocks):
    order = orders[block % len(orders)]
    seed = (20261024 ^ ((block + 1) * 0x9E3779B1)) & 0xffffffff
    for rotation in range(4):
        cases.append({'case': f'b{block:02d}-r{rotation}', 'block': block, 'rotation': rotation,
                      'seed': seed, 'crown': block % 4,
                      'seats': [labels[order[(seat + rotation) % 4]] for seat in range(4)]})
if args.smoke:
    cases = cases[:1]
config = {'budgetMs': args.budget_ms, 'simulations': args.simulations, 'maxDepth': 2000,
          'initialParticles': 4, 'progressiveParticles': True, 'shareInformationHistory': True,
          'learnedBelief': False, 'selection': 'sample', 'cPuct': 1.0, 'batch': 32,
          'device': 'cpu', 'rootNoise': 0, 'maxSteps': 4000, 'maxRounds': 100}
lock = threading.RLock()
live = {}
rows = []
started = time.time()

def atomic_json(name, value):
    target = out / name
    pending = target.with_suffix(target.suffix + '.tmp')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    for attempt in range(20):
        try:
            pending.replace(target)
            return
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.05)

manifest = {'workspace': str(root), 'startedAt': datetime.now(timezone.utc).isoformat(),
            'config': config, 'workers': args.workers, 'models': models, 'schedule': cases,
            'engine': str(engine_path), 'worker': str(worker_path),
            'engineSha256': hashlib.sha256(engine_path.read_bytes()).hexdigest(),
            'workerSha256': hashlib.sha256(worker_path.read_bytes()).hexdigest()}
if args.resume:
    prior = json.loads((out/'manifest.json').read_text(encoding='utf-8'))
    if prior['config'] != config or prior['schedule'] != cases:
        raise ValueError('Resume config/schedule mismatch')
    if any(prior['models'][key]['checkpointSha256'] != models[key]['checkpointSha256'] for key in labels):
        raise ValueError('Resume checkpoint hashes differ')
    attempts = [json.loads(line) for line in (out/'games.jsonl').read_text(encoding='utf-8').splitlines()]
    latest = {row['case']: row for row in attempts}
    rows = [row for row in latest.values() if row.get('completed')]
    started -= float(json.loads((out/'summary.json').read_text(encoding='utf-8'))['elapsedSeconds'])
else:
    if (out/'games.jsonl').exists():
        raise ValueError('Output already contains games; use --resume')
    atomic_json('manifest.json', manifest)

def fit_elo(scores, totals):
    # Bradley-Terry likelihood, symmetric weak prior, mean Elo fixed at 1000.
    x = np.zeros(4)
    for _ in range(50):
        gradient = -0.25 * x
        precision = np.eye(4) * 0.25
        for i in range(4):
            for j in range(i + 1, 4):
                probability = 1 / (1 + math.exp(float(np.clip(x[j]-x[i], -30, 30))))
                residual = scores[i, j] - totals[i, j] * probability
                gradient[i] += residual
                gradient[j] -= residual
                weight = totals[i, j] * probability * (1-probability)
                precision[i, i] += weight
                precision[j, j] += weight
                precision[i, j] -= weight
                precision[j, i] -= weight
        delta = np.linalg.solve(precision, gradient)
        x += delta
        x -= x.mean()
        if float(np.max(np.abs(delta))) < 1e-8:
            break
    return 1000 + 400 / math.log(10) * x

def summarize(final=False):
    complete = [row for row in rows if row['completed']]
    scores, totals = np.zeros((4, 4)), np.zeros((4, 4))
    per_block = {}
    by_model = {label: [] for label in labels}
    for row in complete:
        block_scores, block_totals = per_block.setdefault(row['block'], (np.zeros((4,4)), np.zeros((4,4))))
        for label, seat in row['players'].items():
            by_model[label].append(seat)
        for i, first in enumerate(labels):
            for j, second in enumerate(labels):
                if i == j: continue
                a, b = row['players'][first]['valueReward'], row['players'][second]['valueReward']
                score = 1. if a > b + 1e-6 else .5 if abs(a-b) <= 1e-6 else 0.
                scores[i,j] += score
                totals[i,j] += 1
                block_scores[i,j] += score
                block_totals[i,j] += 1
    ratings = fit_elo(scores, totals)
    intervals = None
    if final and len(per_block) >= 2:
        rng = np.random.default_rng(20261024)
        block_values = list(per_block.values())
        draws = []
        for _ in range(1000):
            selected = rng.integers(0, len(block_values), size=len(block_values))
            draws.append(fit_elo(sum((block_values[k][0] for k in selected), np.zeros((4,4))),
                                 sum((block_values[k][1] for k in selected), np.zeros((4,4)))))
        intervals = np.percentile(np.asarray(draws), [2.5, 97.5], axis=0)
    ranking = []
    for i, label in enumerate(labels):
        data = by_model[label]
        record = {'model': label, 'games': len(data), 'rating': float(ratings[i]),
                  'firsts': sum(r['first'] for r in data),
                  'winShare': sum(r['winShare'] for r in data),
                  'meanRank': statistics.mean(r['rank'] for r in data) if data else None,
                  'seats': dict(Counter(r['seat'] for r in data)),
                  'pairwiseScores': {other: float(scores[i,j]/totals[i,j]) if totals[i,j] else None
                                     for j, other in enumerate(labels) if i != j}}
        if intervals is not None:
            record['rating95ClusterBootstrap'] = [float(intervals[0,i]), float(intervals[1,i])]
        ranking.append(record)
    return {'completedGames': len(complete), 'failedGames': len(rows)-len(complete),
            'plannedGames': len(cases), 'config': config, 'ranking': sorted(ranking, key=lambda r:-r['rating']),
            'ratingAnchor': 'Mean rating of these four checkpoints = 1000; not comparable to fixed-NPC ratings',
            'elapsedSeconds': time.time()-started, 'final': final}

def progress(case, **fields):
    with lock:
        live.setdefault(case['case'], {'case': case['case'], 'seats': case['seats']}).update(fields)
        try:
            atomic_json('progress.json', {'pid': os.getpid(), 'completedGames': len(rows), 'plannedGames': len(cases),
                                         'running': live, 'elapsedSeconds': time.time()-started})
        except OSError as error:
            print(f'Progress write delayed: {error}', flush=True)

def game(case):
    engine = worker = None
    moves = searches = rounds = 0
    seen = Counter()
    search_stats = {label: {'searches': 0, 'visits': 0, 'searchSeconds': 0.} for label in labels}
    row = {**case, 'completed': False, 'players': {}}
    began = time.perf_counter()
    game_id = 'arena-' + case['case']
    try:
        engine, worker = GameEngineWorker(engine_path), NativeMctsWorker(worker_path)
        engine.create_game({'seed': case['seed'], 'charSetMode': 'random', 'initialCrownSeat': case['crown'],
                            'endDistricts': 8, 'startingHand': 4, 'startingGold': 2, 'catalog': cards._catalog,
                            'seats': [{'id': f'p{i}', 'isBot': True, 'botType': 'neural', 'botLevel': 'hard'}
                                      for i in range(4)]}, game_id)
        while True:
            current = engine.current(game_id)
            rounds = current.get('round', 0)
            if current.get('gameOver'):
                outcome = engine.current(game_id, include_rewards=True)
                rewards, values = outcome['rewards'], outcome['valueRewards']
                winners = sum(v >= 1-1e-6 for v in rewards)
                for seat, label in enumerate(case['seats']):
                    first = rewards[seat] >= 1-1e-6
                    row['players'][label] = {'seat': seat, 'first': first, 'winShare': 1/winners if first else 0,
                                             'rank': 1 + (1-rewards[seat])*3/2,
                                             'valueReward': values[seat], **search_stats[label]}
                row['completed'] = True
                break
            if moves >= config['maxSteps'] or rounds > config['maxRounds']:
                raise RuntimeError('Step/round limit')
            actor = current.get('playerId')
            if actor not in ('p0','p1','p2','p3'):
                advanced = engine._request('advance_npcs', gameId=game_id,
                    networkPlayerIds=['p0','p1','p2','p3'], seed=(case['seed']+moves)&0xffffffff,
                    maxSteps=128, maxRounds=100, includeTrainingFeatures=False)
                moves += int(advanced.get('steps', 0))
                if not advanced.get('steps') and not advanced.get('gameOver'):
                    raise RuntimeError('Engine did not advance automatic phase')
                continue
            decision = engine.decision(game_id)
            state = decision['state']
            actions = [a for a in decision['actions'] if not (a.get('type') == 'district_effect' and a.get('name') == 'thieves_cancel')]
            label = case['seats'][int(actor[1:])]
            model = models[label]
            digest = state_identity(state)
            seen[digest] += 1
            if seen[digest] > 20 or not actions:
                raise RuntimeError('Repeated state or empty actions')
            if len(actions) == 1:
                action = actions[0]
            else:
                seed = (case['seed'] + moves*0x9E3779B1) & 0xffffffff
                before = time.perf_counter()
                sample = worker.determinize(state=state, player_id=actor, count=4, seed=seed, belief=True)
                remaining = max(1, args.budget_ms-math.ceil((time.perf_counter()-before)*1000)) if args.budget_ms else 0
                search = worker.search(state=sample['particles'][0], particles=sample['particles'][1:],
                    root_player_id=actor, legal_actions=actions, particle_weights=sample['weights'],
                    model_path=model['flat'], model_version=1, profile=model['profile'], architecture=model['architecture'],
                    device='cpu', simulations=args.simulations, max_depth=2000, c_puct=1.0,
                    dirichlet_alpha=0, dirichlet_epsilon=0, seed=seed ^ 0xA511E9B3,
                    batch_size=32, action_encoding_version=model['actionEncoding'], time_budget_ms=remaining,
                    progressive_particles=True, root_belief=True, share_information_history=True)
                if len(search['policy']) != len(actions):
                    raise RuntimeError('Search policy/action mismatch')
                action = actions[select_search_action(search['policy'], random.Random(seed), 'sample')]
                searches += 1
                search_stats[label]['searches'] += 1
                search_stats[label]['visits'] += int(search.get('visits', 0))
                search_stats[label]['searchSeconds'] += time.perf_counter()-before
            engine.apply(game_id=game_id, player_id=actor, action=action, return_state=False)
            moves += 1
            progress(case, round=rounds, moves=moves, searches=searches, lastActor=label)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {error}'
    finally:
        if engine is not None: engine.close()
        if worker is not None: worker.close()
    row.update(rounds=rounds, moves=moves, searches=searches, seconds=time.perf_counter()-began)
    return row

print(f'START pid={os.getpid()} games={len(cases)} workers={args.workers} config={json.dumps(config)}', flush=True)
atomic_json('summary.json', summarize())
with ThreadPoolExecutor(max_workers=args.workers) as pool:
    completed_cases = {row['case'] for row in rows}
    futures = [pool.submit(game, case) for case in cases if case['case'] not in completed_cases]
    for future in as_completed(futures):
        row = future.result()
        with lock:
            rows.append(row)
            live.pop(row['case'], None)
            with (out/'games.jsonl').open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(row, ensure_ascii=False)+'\n')
            atomic_json('summary.json', summarize())
        print(f'FINISHED {len(rows)}/{len(cases)} {row["case"]} complete={row["completed"]} seconds={row["seconds"]:.1f} error={row.get("error")}', flush=True)
summary = summarize(final=True)
atomic_json('summary.json', summary)
atomic_json('progress.json', {'pid': os.getpid(), 'completedGames': len(rows), 'plannedGames': len(cases), 'running': {}, 'finished': True})
print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
