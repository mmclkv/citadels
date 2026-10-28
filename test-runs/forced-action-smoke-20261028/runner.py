"""Same-table, seat-swapped ablation of singleton traversal, frozen weights."""
import os
for _k in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS'):os.environ[_k]='1'
import sys,json,hashlib,time,random,statistics,argparse,shutil
from pathlib import Path
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,as_completed
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
LABELS=('baseline','fast_forward')

def play(task):
    case,cfg=task
    import torch
    torch.set_num_threads(1)
    from python_backend.game_engine_worker import GameEngineWorker
    from python_backend.native_worker import NativeMctsWorker
    from python_backend.belief import BeliefPolicy
    from python_backend.policy_selection import select_search_action
    from python_backend import cards
    began=time.monotonic();engine=worker=None;steps=0
    counts=Counter();stats={x:Counter() for x in LABELS};seen=Counter()
    row={**case,'completed':False};game_id=f"forced-{case['block']}-{case['rotation']}"
    try:
        engine=GameEngineWorker(cfg['engine']);worker=NativeMctsWorker(cfg['worker'])
        belief=BeliefPolicy(cfg['belief']) if cfg['belief'] else None
        if belief is not None and belief.model is None:raise RuntimeError(belief.error)
        actors={f'p{seat}':label for label,seat in case['seats'].items()}
        state=engine.create_game({'seed':case['seed'],'charSetMode':'random','initialCrownSeat':case['crown'],
            'endDistricts':8,'startingGold':2,'startingHand':4,'catalog':cards._catalog,
            'seats':[{'id':f'p{i}','isBot':True,'botType':'neural' if f'p{i}' in actors else 'npc',
                      'botLevel':'hard'} for i in range(case['players'])]},game_id)
        def observed(s):return {**s,'roomId':game_id,'createdAt':case['seed']}
        if belief is not None:belief.update(observed(state))
        while True:
            cur=engine.current(game_id)
            if cur.get('gameOver'):
                rewards=engine.current(game_id,include_rewards=True)['rewards']
                winners=sum(v>=1-1e-6 for v in rewards)
                row['results']={label:{'seat':seat,'reward':rewards[seat],
                    'rank':1+(1-rewards[seat])*(case['players']-1)/2,
                    'first':bool(rewards[seat]>=1-1e-6),
                    'winShare':1/winners if rewards[seat]>=1-1e-6 else 0,
                    'pairwise':{other:1. if rewards[seat]>rewards[otherseat]+1e-6 else
                        .5 if abs(rewards[seat]-rewards[otherseat])<=1e-6 else 0.
                        for other,otherseat in case['seats'].items() if other!=label}}
                    for label,seat in case['seats'].items()}
                row.update(completed=True,rounds=cur.get('round'));break
            if steps>=6000 or cur.get('round',1)>60:raise RuntimeError('Step/round limit')
            actor=cur.get('playerId')
            if actor not in actors:
                a=engine._request('advance_npcs',gameId=game_id,networkPlayerIds=list(actors),
                    seed=(case['seed']+steps)&0xffffffff,maxSteps=min(64,6000-steps),maxRounds=60,
                    includeTrainingFeatures=False,heuristicMcts={'enabled':False})
                if a.get('heuristicSearch',{}).get('searches',0):raise RuntimeError('Static NPC searched')
                if a.get('state') and belief is not None:belief.update(observed(a['state']))
                if not a.get('steps') and not a.get('gameOver'):raise RuntimeError('NPC did not advance')
                steps+=a.get('steps',0);continue
            d=engine.decision(game_id);state,actions=d['state'],d['actions'];label=actors[actor]
            digest=hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest();seen[digest]+=1
            if seen[digest]>30 or not actions:raise RuntimeError('Repeated state or empty actions')
            bs=observed(state)
            if belief is not None:belief.update(bs)
            if len(actions)==1:action=actions[0]
            else:
                seed=(case['seed']+counts[label]*0x9E3779B1)&0xffffffff
                start=time.monotonic()
                frozen=belief.candidate_scorer(bs,actor,enabled=True) if belief is not None else None
                scorer,mix=frozen if frozen is not None else (None,0.)
                if scorer is not None:
                    sample=belief.sample(worker,bs,actor,8,seed,enabled=True)
                    if not sample.get('modelApplied'):raise RuntimeError('Belief sampling failed: '+belief.error)
                    logs=sample.pop('logWeights')
                else:
                    sample=worker.determinize(state=state,player_id=actor,count=8,seed=seed,belief=True);logs=None
                search_start=time.monotonic()
                enabled=label=='fast_forward'
                r=worker.search(state=sample['particles'][0],particles=sample['particles'][1:],root_player_id=actor,
                    legal_actions=actions,particle_weights=sample['weights'],model_path=cfg['flat'],model_version=1,
                    profile=cfg['profile'],architecture='entity-v6',device='cpu',simulations=cfg['simulations'],
                    max_depth=cfg['depth'],c_puct=1,dirichlet_alpha=0,dirichlet_epsilon=0,seed=seed^0xA511E9B3,
                    batch_size=32,action_encoding_version=12,progressive_particles=True,root_belief=scorer is None,
                    root_log_weights=logs,root_prior_mixture=mix,root_candidate_scorer=scorer,
                    share_information_history=True,fast_forward_single_actions=enabled)
                finish=time.monotonic()
                if r.get('fastForwardSingleActions') is not enabled:raise RuntimeError('Search switch was ignored')
                if r.get('fallback') or r.get('particleSamplingError'):raise RuntimeError('Search mismatch/sampling failure')
                if r.get('visits')!=cfg['simulations']:raise RuntimeError('Search budget not reached')
                if r.get('stateEncodingVersion')!=16:raise RuntimeError('Wrong state encoding')
                stats[label]['visits']+=r['visits'];stats[label]['expansions']+=r.get('expansions',0)
                stats[label]['particlesUsed']+=r.get('particlesUsed',0)
                stats[label]['searchSeconds']+=finish-search_start;stats[label]['totalSeconds']+=finish-start
                stats[label]['maxSearchSeconds']=max(stats[label]['maxSearchSeconds'],finish-search_start)
                action=actions[select_search_action(r['policy'],random.Random(seed),'sample')]
                counts[label]+=1
            engine.apply(game_id=game_id,player_id=actor,action=action,return_state=False);steps+=1
    except Exception as exc:row['failure']=f'{type(exc).__name__}: {exc}'
    finally:
        if engine:engine.close()
        if worker:worker.close()
    row.update(seconds=time.monotonic()-began,steps=steps,decisions=dict(counts),
               instrumentation={label:dict(v) for label,v in stats.items()})
    return row

def summarize(rows,draws=10000):
    import numpy as np
    good=[r for r in rows if r['completed']]
    results={label:{'games':len(good),'firsts':sum(g['results'][label]['first'] for g in good),
        'winShare':sum(g['results'][label]['winShare'] for g in good),
        'meanRank':statistics.mean(g['results'][label]['rank'] for g in good) if good else None,
        'pairwiseScore':statistics.mean(g['results'][label]['pairwise'][LABELS[1-i]] for g in good) if good else None}
        for i,label in enumerate(LABELS)}
    blocks={b:[g for g in good if g['block']==b] for b in sorted({g['block'] for g in good})}
    blocks={b:gs for b,gs in blocks.items() if len(gs)==2}
    paired={}
    if len(blocks)>=2:
        rng=np.random.default_rng(20261029)
        picks=rng.integers(len(blocks),size=(draws,len(blocks)))
        for name,metric in [('winShareDifference',lambda g:g['results']['fast_forward']['winShare']-g['results']['baseline']['winShare']),
                            ('pairwiseScore',lambda g:g['results']['fast_forward']['pairwise']['baseline'])]:
            values=np.asarray([statistics.mean(metric(g) for g in gs) for gs in blocks.values()])
            paired[name]={'estimate':float(values.mean()),'95ClusterBootstrap':np.quantile(values[picks].mean(1),[.025,.975]).tolist()}
    metrics={}
    for label in LABELS:
        count=sum(g['decisions'].get(label,0) for g in good)
        totals=Counter()
        for g in good:totals.update(g['instrumentation'][label])
        metrics[label]={'searches':count,'totalVisits':totals['visits'],
            'meanSearchSeconds':totals['searchSeconds']/count if count else None,
            'meanTotalSeconds':totals['totalSeconds']/count if count else None,
            'meanPhysicalExpansions':totals['expansions']/count if count else None,
            'meanWorlds':totals['particlesUsed']/count if count else None}
    return {'successfulGames':len(good),'failedGames':len(rows)-len(good),'completeOpeningBlocks':len(blocks),
            'results':results,'paired':paired,'instrumentation':metrics}

def write_summary(out,summary):
    path=out/'summary.tmp';path.write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
    for attempt in range(10):
        try:path.replace(out/'summary.json');return
        except PermissionError:
            if attempt==9:raise
            time.sleep(.1)

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--reference',default='test-runs/teacher-gain-60-20261028/manifest.json')
    p.add_argument('--output',required=True);p.add_argument('--blocks',type=int,default=30)
    p.add_argument('--workers',type=int,default=8);p.add_argument('--simulations',type=int,default=500)
    p.add_argument('--depth',type=int,default=700);p.add_argument('--resume',action='store_true')
    p.add_argument('--no-belief',action='store_true');args=p.parse_args()
    if min(args.blocks,args.workers,args.simulations,args.depth)<1 or args.workers>64:p.error('Invalid budget/workers')
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/'manifest.json').exists() and not args.resume:p.error('Existing run requires --resume')
    ref=json.loads(Path(args.reference).read_text(encoding='utf8'))
    for k in ('flat','belief'):
        if ref['config'].get(k) and hashlib.sha256(Path(ref['config'][k]).read_bytes()).hexdigest()!=ref['sha256'][k]:
            raise ValueError('Frozen reference changed: '+k)
    source=Path(ref['sourceCheckpoint'])
    if hashlib.sha256(source.read_bytes()).hexdigest()!=ref['sourceSha256']:raise ValueError('Source checkpoint changed')
    from python_backend.native_worker_manager import NativeWorkerManager
    manager=NativeWorkerManager(log=lambda m:print(m,flush=True))
    try:
        manager.start();engine=str(manager.game_worker.executable);worker=str(manager.worker.executable)
    finally:manager.close()
    flat=out/'model.bin'
    if flat.exists() and hashlib.sha256(flat.read_bytes()).hexdigest()!=ref['sha256']['flat']:raise ValueError('Run model changed')
    if not flat.exists():shutil.copyfile(ref['config']['flat'],flat)
    cfg={'engine':engine,'worker':worker,'flat':str(flat),'belief':None if args.no_belief else ref['config']['belief'],
         'profile':'fast','simulations':args.simulations,'depth':args.depth}
    manifest={'sourceCheckpoint':str(source),'sourceSha256':ref['sourceSha256'],'reference':str(Path(args.reference).resolve()),
        'config':cfg,'blocks':args.blocks,'games':args.blocks*2,'workers':args.workers,'particles':8,'batch':32,
        'progressiveParticles':True,'shareInformationHistory':True,'selection':'sample','rootNoise':0,
        'stateVersion':16,'actionVersion':12,'opponents':'static hard; heuristic MCTS explicitly disabled',
        'control':'same binary, same weights; fastForwardSingleActions false versus true',
        'searchOpponentApproximation':'Other searched neural seat remains an optimizing agent in each search',
        'sha256':{k:hashlib.sha256(Path(cfg[k]).read_bytes()).hexdigest() for k in ('engine','worker','flat','belief') if cfg[k]}}
    if args.resume and (out/'manifest.json').exists():
        old=json.loads((out/'manifest.json').read_text(encoding='utf8'))
        if any(old[k]!=manifest[k] for k in ('sourceSha256','sha256','config','blocks')):raise ValueError('Resume contract mismatch')
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    shutil.copyfile(__file__,out/'runner.py')
    cases=[]
    for block in range(args.blocks):
        n=(4,6,8)[block%3];seats=[block%n,(block+n//2)%n]
        for rotation in range(2):
            cases.append({'block':block,'rotation':rotation,'players':n,
                'seed':(20261028^(block+1)*0x85EBCA6B)&0xffffffff,'crown':(block*7+3)%n,
                'seats':{label:seats[(i+rotation)%2] for i,label in enumerate(LABELS)}})
    rows=[]
    if args.resume and (out/'games.jsonl').exists():
        rows=[json.loads(line) for line in (out/'games.jsonl').read_text(encoding='utf8').splitlines() if line.strip()]
    rows=list({(r['block'],r['rotation']):r for r in rows}.values())
    done={(r['block'],r['rotation']) for r in rows if r['completed']}
    tasks=[(case,cfg) for case in cases if (case['block'],case['rotation']) not in done]
    started=time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers) as executor:
        for future in as_completed([executor.submit(play,task) for task in tasks]):
            row=future.result();key=(row['block'],row['rotation'])
            rows=[r for r in rows if (r['block'],r['rotation'])!=key]+[row]
            with (out/'games.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
            summary=summarize(rows);summary.update(plannedGames=len(cases),seconds=time.monotonic()-started)
            write_summary(out,summary)
            print(json.dumps({'finished':len(rows),'planned':len(cases),'block':row['block'],'rotation':row['rotation'],
                'completed':row['completed'],'failure':row.get('failure'),'seconds':row['seconds'],'results':summary['results']},ensure_ascii=False),flush=True)
    print('DONE',json.dumps(summarize(rows,20000),ensure_ascii=False),flush=True)
    if any(not r['completed'] for r in rows):raise SystemExit(1)

if __name__=='__main__':main()
