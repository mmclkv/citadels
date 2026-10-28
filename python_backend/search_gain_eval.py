"""Frozen policy: direct / 500 / 2000 simulations in the same table."""
import os,sys,json,gzip,hashlib,time,random,statistics,argparse,tempfile
from pathlib import Path
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,ThreadPoolExecutor,as_completed
os.environ['OMP_NUM_THREADS']=os.environ['MKL_NUM_THREADS']=os.environ['OPENBLAS_NUM_THREADS']='1'
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.dont_write_bytecode=True
LABELS=('direct','mcts500','mcts2000')

def play(task):
    case,config=task
    import torch
    torch.set_num_threads(1)
    from python_backend.game_engine_worker import GameEngineWorker
    from python_backend.native_worker import NativeMctsWorker
    from python_backend.belief import BeliefPolicy
    from python_backend.policy_selection import select_search_action
    from python_backend import cards
    began=time.monotonic();engine=worker=None;steps=0;decisions=Counter();seen=Counter();stats={x:Counter() for x in LABELS}
    row={**case,'completed':False}
    game_id=f"teacher-{case['block']}-{case['rotation']}"
    try:
        engine=GameEngineWorker(config['engine']);worker=NativeMctsWorker(config['worker'])
        belief=BeliefPolicy(config['belief']) if config['belief'] else None
        if belief is not None and belief.model is None: raise RuntimeError(belief.error)
        actor_labels={f'p{seat}':label for label,seat in case['seats'].items()}
        state=engine.create_game({'seed':case['seed'],'charSetMode':'random','initialCrownSeat':case['crown'],
            'endDistricts':8,'startingGold':2,'startingHand':4,'catalog':cards._catalog,
            'seats':[{'id':f'p{i}','isBot':True,'botType':'neural' if f'p{i}' in actor_labels else 'npc','botLevel':'hard'} for i in range(case['players'])]},game_id)
        opening={'players':[{k:p.get(k) for k in ('id','hand','gold','city')} for p in state['players']],
                 'deck':state.get('deck'),'charDeck':state.get('charDeck'),
                 'draft':state.get('draft'),'crown':case['crown']}
        row['openingDealHash']=hashlib.sha256(json.dumps(opening,sort_keys=True).encode()).hexdigest()
        def observed(s):return {**s,'roomId':game_id,'createdAt':case['seed']}
        belief.update(observed(state)) if belief is not None else None
        while True:
            cur=engine.current(game_id)
            if cur.get('gameOver'):
                outcome=engine.current(game_id,include_rewards=True);r=outcome['rewards'];w=sum(v>=1-1e-6 for v in r)
                row['results']={label:{'seat':seat,'reward':r[seat],
                    'rank':1+(1-r[seat])*(case['players']-1)/2,
                    'first':bool(r[seat]>=1-1e-6),'winShare':1/w if r[seat]>=1-1e-6 else 0,
                    'comparisons':{other:1. if r[seat]>r[otherseat]+1e-6 else .5 if abs(r[seat]-r[otherseat])<=1e-6 else 0.
                                   for other,otherseat in case['seats'].items() if other!=label}}
                    for label,seat in case['seats'].items()}
                row.update(completed=True,rounds=cur.get('round'));break
            if steps>=6000 or cur.get('round',1)>60:raise RuntimeError('Step/round limit')
            actor=cur.get('playerId')
            if actor not in actor_labels:
                advanced=engine._request('advance_npcs',gameId=game_id,networkPlayerIds=list(actor_labels),
                    seed=(case['seed']+steps)&0xffffffff,maxSteps=min(64,6000-steps),maxRounds=60,
                    includeTrainingFeatures=False,heuristicMcts={'enabled':False})
                if advanced.get('heuristicSearch',{}).get('searches',0):raise RuntimeError('Static opponent unexpectedly searched')
                if advanced.get('state') and belief is not None:belief.update(observed(advanced['state']))
                if not advanced.get('steps') and not advanced.get('gameOver'):raise RuntimeError('NPC did not advance')
                steps+=advanced.get('steps',0);continue
            d=engine.decision(game_id);state,actions=d['state'],d['actions'];label=actor_labels[actor]
            digest=hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest();seen[digest]+=1
            if seen[digest]>30 or not actions:raise RuntimeError('Repeated state or empty actions')
            belief_state=observed(state);belief.update(belief_state) if belief is not None else None
            if len(actions)==1:action=actions[0]
            else:
                seed=(case['seed']+decisions[label]*0x9E3779B1)&0xffffffff
                direct=label=='direct';simulations={'direct':1,'mcts500':500,'mcts2000':2000}[label]
                start=time.monotonic()
                frozen=None if direct or belief is None else belief.candidate_scorer(belief_state,actor,enabled=True)
                scorer,mix=frozen if frozen is not None else (None,0.)
                if direct:sample={'particles':[state],'weights':[1.]};logs=None
                elif scorer is not None:
                    sample=belief.sample(worker,belief_state,actor,8,seed,enabled=True)
                    if not sample.get('modelApplied'):raise RuntimeError('Belief sampling failed: '+belief.error)
                    logs=sample.pop('logWeights')
                else:
                    sample=worker.determinize(state=state,player_id=actor,count=8,seed=seed,belief=True);logs=None
                direct_seat=case['seats']['direct']
                opponents=[] if direct else [{'playerId':f'p{direct_seat}','modelPath':config['flat'],
                    'modelVersion':1,'actionEncodingVersion':12,'profile':config['profile']}]
                search_start=time.monotonic()
                result=worker.search(state=sample['particles'][0],particles=sample['particles'][1:],root_player_id=actor,
                    legal_actions=actions,particle_weights=sample['weights'],model_path=config['flat'],model_version=1,
                    profile=config['profile'],architecture='entity-v6',device='cpu',simulations=simulations,max_depth=700,
                    c_puct=1,dirichlet_alpha=0,dirichlet_epsilon=0,seed=seed^0xA511E9B3,batch_size=32,
                    action_encoding_version=12,policy_only=direct,progressive_particles=not direct,
                    root_belief=scorer is None,root_log_weights=logs,root_prior_mixture=mix,
                    root_candidate_scorer=scorer,share_information_history=True,opponent_policies=opponents,
                    include_root_diagnostics=not direct,fast_forward_single_actions=True)
                finish=time.monotonic()
                if result.get('fastForwardSingleActions') is not True:raise RuntimeError('Single-action fast-forward unsupported')
                if result.get('stateEncodingVersion')!=16:raise RuntimeError('Wrong state encoding')
                if result.get('fallback') or result.get('particleSamplingError'):raise RuntimeError('Search mismatch or sampling failure')
                if not direct and result.get('visits')!=simulations:raise RuntimeError('Search budget not reached')
                stats[label]['searchSeconds']+=finish-search_start
                stats[label]['totalSeconds']+=finish-start
                stats[label]['visits']+=result.get('visits',0);stats[label]['expansions']+=result.get('expansions',0)
                stats[label]['particlesUsed']+=result.get('particlesUsed',0)
                if not direct:stats[label]['changedBest']+=max(range(len(actions)),key=lambda i:result['policy'][i])!=max(range(len(actions)),key=lambda i:result['networkPolicy'][i])
                action=actions[select_search_action(result['policy'],random.Random(seed),'sample')]
                decisions[label]+=1
            engine.apply(game_id=game_id,player_id=actor,action=action,return_state=False);steps+=1
    except Exception as exc:row['failure']=f'{type(exc).__name__}: {exc}'
    finally:
        if engine:engine.close()
        if worker:worker.close()
    row.update(seconds=time.monotonic()-began,steps=steps,decisions=dict(decisions),instrumentation={k:dict(v) for k,v in stats.items()})
    return row

def summarize(games):
    import numpy as np
    games=list({(g['block'],g['rotation']):g for g in games}.values())
    good=[g for g in games if g['completed']]
    def ranking(rows):
        return {label:{'games':len(rows),'firsts':sum(g['results'][label]['first'] for g in rows),
            'winShare':sum(g['results'][label]['winShare'] for g in rows),
            'meanRank':statistics.mean(g['results'][label]['rank'] for g in rows) if rows else None,
            'pairwise':{other:statistics.mean(g['results'][label]['comparisons'][other] for g in rows) if rows else None
                        for other in LABELS if other!=label}} for label in LABELS}
    # Only whole three-rotation opening blocks enter paired inference.
    blocks={b:[g for g in good if g['block']==b] for b in sorted({g['block'] for g in good})}
    blocks={b:gs for b,gs in blocks.items() if len(gs)==3 and {g['rotation'] for g in gs}=={0,1,2}}
    for gs in blocks.values():
        hashes={g.get('openingDealHash') for g in gs}
        if len(hashes)!=1:raise ValueError('Seat rotations do not share the same opening deal')
    paired={}
    if len(blocks)>=2:
        rng=np.random.default_rng(20261028)
        indices=rng.integers(len(blocks),size=(10000,len(blocks)))
        for a,b in [('mcts500','direct'),('mcts2000','direct'),('mcts2000','mcts500')]:
            metrics={}
            for name,measure in {
                'winShareDifference':lambda g:g['results'][a]['winShare']-g['results'][b]['winShare'],
                'firstRateDifference':lambda g:int(g['results'][a]['first'])-int(g['results'][b]['first']),
                'pairwiseScore':lambda g:g['results'][a]['comparisons'][b],
                'meanRankDifference':lambda g:g['results'][a]['rank']-g['results'][b]['rank'],
            }.items():
                delta=np.asarray([statistics.mean(measure(g) for g in gs) for gs in blocks.values()])
                metrics[name]={'estimate':float(delta.mean()),
                    '95ClusterBootstrap':np.quantile(delta[indices].mean(1),[.025,.975]).tolist()}
            paired[a+'-'+b]={'openingBlocks':len(blocks),'metrics':metrics,
                'winShareDifference':metrics['winShareDifference']['estimate'],
                '95ClusterBootstrap':metrics['winShareDifference']['95ClusterBootstrap']}
    instrumentation={}
    for label in LABELS:
        n=sum(g.get('decisions',{}).get(label,0) for g in good)
        totals=Counter()
        for g in good:totals.update(g.get('instrumentation',{}).get(label,{}))
        instrumentation[label]={'searches':n,'totalVisits':totals['visits'],
            **{'mean'+k[0].upper()+k[1:]:totals[k]/n if n else None
               for k in ('searchSeconds','totalSeconds','expansions','particlesUsed','changedBest')}}
    return {'ranking':ranking(good),'paired':paired,'completeOpeningBlocks':len(blocks),
        'byPlayers':{str(n):ranking([g for g in good if g['players']==n]) for n in (4,6,8)},
        'instrumentation':instrumentation,'successfulGames':len(good),'failedGames':len(games)-len(good)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--blocks',type=int,default=20);parser.add_argument('--resume',action='store_true');parser.add_argument('--checkpoint');parser.add_argument('--workers',type=int,default=8);parser.add_argument('--threads',action='store_true',help='Share Python runtime to reduce memory use');parser.add_argument('--no-belief',action='store_true');args=parser.parse_args()
    if not 1<=args.workers<=64 or args.blocks<1: parser.error('workers must be 1..64 and blocks must be positive')
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True);tempfile.tempdir=str(out)
    import numpy as np,torch
    torch.set_num_threads(1)
    from training.gpu_trainer import create_model,migrate_model_weights
    from python_backend.model_contract import validate_checkpoint_contract
    from python_backend.native_worker_manager import NativeWorkerManager
    source=(Path(args.checkpoint).resolve() if args.checkpoint else
            max((p for p in (ROOT/'training-data').glob('checkpoint-*.json.gz') if '-opponent-' not in p.name),key=lambda p:p.stat().st_mtime_ns))
    if args.resume and (out/'manifest.json').exists():
        previous=json.loads((out/'manifest.json').read_text(encoding='utf8'))
        if previous['sourceSha256']!=hashlib.sha256(source.read_bytes()).hexdigest():
            raise ValueError('Cannot resume with a different checkpoint')
    source_bytes=source.read_bytes()
    checkpoint=json.loads(gzip.decompress(source_bytes))
    contract=validate_checkpoint_contract(checkpoint,'entity-v6');profile=checkpoint['model']['profile']
    np.asarray(checkpoint['model']['flat'],dtype='<f4').tofile(out/'source.bin')
    old=create_model('entity-v6',profile,contract['state']);old.load_flat(str(out/'source.bin'))
    new=create_model('entity-v6',profile,16);migrate_model_weights(old,new,contract['action'],12);new.save_flat(str(out/'model.bin'))
    manager=NativeWorkerManager(log=lambda message:print(message,flush=True))
    try:
        manager.start();engine=str(manager.game_worker.executable);worker=str(manager.worker.executable)
    finally:manager.close()
    training=checkpoint.get('config') or {}
    belief=(ROOT/'training-data/belief/checkpoints'/training['beliefCheckpoint']
            if not args.no_belief and training.get('beliefNetworkEnabled') and training.get('beliefCheckpoint') else None)
    config={'engine':engine,'worker':worker,'flat':str((out/'model.bin').resolve()),
            'belief':str(belief) if belief is not None else None,'profile':profile}
    manifest={'sourceCheckpoint':str(source),'sourceSha256':hashlib.sha256(source_bytes).hexdigest(),
              'config':config,'budgets':[0,500,2000],'particles':8,'depth':700,'batch':32,'selection':'sample',
              'rootNoise':0,'learnedBelief':config['belief'] is not None,'progressiveParticles':True,'state':16,'action':12,
              'migration':f"v{contract['state']}/v{contract['action']} -> v16/v12, zero new inputs; no additional training",
              'protocolVersion':2,'blocks':args.blocks,'plannedGames':args.blocks*3,'fastForwardSingleActions':True,
              'workers':args.workers,'orchestration':'shared Python' if args.threads else 'independent Python samplers',
              'opponent':'static hard, explicitly disabled MCTS',
              'sha256':{k:hashlib.sha256(Path(config[k]).read_bytes()).hexdigest() for k in ('engine','worker','flat','belief') if config[k] is not None}}
    if args.resume and (out/'manifest.json').exists():
        previous=json.loads((out/'manifest.json').read_text(encoding='utf8'))
        if previous['sourceSha256']!=manifest['sourceSha256'] or previous['sha256']!=manifest['sha256']:
            raise ValueError('Resume requires the same checkpoint, binaries and belief model')
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    cases=[]
    for block in range(args.blocks):
        n=(4,6,8)[block%3];seats=[block%n,(block+n//3)%n,(block+2*n//3)%n]
        for rotation in range(3):
            cases.append({'block':block,'rotation':rotation,'players':n,'seed':(20261028^(block+1)*0x85EBCA6B)&0xffffffff,
                          'crown':block%n,'seats':{label:seats[(i+rotation)%3] for i,label in enumerate(LABELS)}})
    games=[]
    if args.resume and (out/'games.jsonl').exists():games=[json.loads(s) for s in (out/'games.jsonl').read_text(encoding='utf8').splitlines() if s.strip()]
    games=list({(g['block'],g['rotation']):g for g in games}.values())
    done={(g['block'],g['rotation']) for g in games if g['completed']}
    tasks=[(case,config) for case in cases if (case['block'],case['rotation']) not in done]
    started=time.monotonic()
    with (ThreadPoolExecutor if args.threads else ProcessPoolExecutor)(max_workers=args.workers) as executor:
        for future in as_completed([executor.submit(play,task) for task in tasks]):
            row=future.result();games=[g for g in games if (g['block'],g['rotation'])!=(row['block'],row['rotation'])]+[row]
            with (out/'games.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
            summary=summarize(games);summary.update(plannedGames=len(cases),seconds=time.monotonic()-started)
            tmp=out/'summary.tmp';tmp.write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
            for attempt in range(10):
                try:tmp.replace(out/'summary.json');break
                except PermissionError:
                    if attempt==9:raise
                    time.sleep(.1)
            print(json.dumps({'finished':len(games),'planned':len(cases),'block':row['block'],'rotation':row['rotation'],
                'completed':row['completed'],'failure':row.get('failure'),'seconds':row['seconds'],'ranking':summary['ranking']},ensure_ascii=False),flush=True)
    print('DONE',json.dumps(summarize(games),ensure_ascii=False),flush=True)

if __name__=='__main__':main()
