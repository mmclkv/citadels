"""Frozen policy: direct / 500 / 2000 simulations in the same table."""
import os,sys,json,gzip,hashlib,time,random,statistics,argparse,tempfile
from pathlib import Path
from collections import Counter
from concurrent.futures import ProcessPoolExecutor,as_completed
os.environ['OMP_NUM_THREADS']=os.environ['MKL_NUM_THREADS']=os.environ['OPENBLAS_NUM_THREADS']='1'
ROOT=Path(r'D:\Users\Jiaming Qiu\citadels')
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
        belief=BeliefPolicy(config['belief'])
        if belief.model is None: raise RuntimeError(belief.error)
        actor_labels={f'p{seat}':label for label,seat in case['seats'].items()}
        state=engine.create_game({'seed':case['seed'],'charSetMode':'random','initialCrownSeat':case['crown'],
            'endDistricts':8,'startingGold':2,'startingHand':4,'catalog':cards._catalog,
            'seats':[{'id':f'p{i}','isBot':True,'botType':'neural' if f'p{i}' in actor_labels else 'npc','botLevel':'hard'} for i in range(case['players'])]},game_id)
        def observed(s):return {**s,'roomId':game_id,'createdAt':case['seed']}
        belief.update(observed(state))
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
                if advanced.get('state'):belief.update(observed(advanced['state']))
                if not advanced.get('steps') and not advanced.get('gameOver'):raise RuntimeError('NPC did not advance')
                steps+=advanced.get('steps',0);continue
            d=engine.decision(game_id);state,actions=d['state'],d['actions'];label=actor_labels[actor]
            digest=hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest();seen[digest]+=1
            if seen[digest]>30 or not actions:raise RuntimeError('Repeated state or empty actions')
            belief_state=observed(state);belief.update(belief_state)
            if len(actions)==1:action=actions[0]
            else:
                seed=(case['seed']+decisions[label]*0x9E3779B1)&0xffffffff
                direct=label=='direct';simulations={'direct':1,'mcts500':500,'mcts2000':2000}[label]
                frozen=None if direct else belief.candidate_scorer(belief_state,actor,enabled=True)
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
                    'modelVersion':1,'actionEncodingVersion':12,'profile':'fast'}]
                result=worker.search(state=sample['particles'][0],particles=sample['particles'][1:],root_player_id=actor,
                    legal_actions=actions,particle_weights=sample['weights'],model_path=config['flat'],model_version=1,
                    profile='fast',architecture='entity-v6',device='cpu',simulations=simulations,max_depth=700,
                    c_puct=1,dirichlet_alpha=0,dirichlet_epsilon=0,seed=seed^0xA511E9B3,batch_size=32,
                    action_encoding_version=12,policy_only=direct,progressive_particles=not direct,
                    root_belief=scorer is None,root_log_weights=logs,root_prior_mixture=mix,
                    root_candidate_scorer=scorer,share_information_history=True,opponent_policies=opponents,
                    include_root_diagnostics=not direct)
                if result.get('fallback') or result.get('particleSamplingError'):raise RuntimeError('Search mismatch or sampling failure')
                if not direct and result.get('visits')!=simulations:raise RuntimeError('Search budget not reached')
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
    good=[g for g in games if g['completed']]
    result={label:{'games':len(good),'firsts':sum(g['results'][label]['first'] for g in good),
                  'winShare':sum(g['results'][label]['winShare'] for g in good),
                  'meanRank':statistics.mean(g['results'][label]['rank'] for g in good) if good else None,
                  'pairwise':{other:statistics.mean(g['results'][label]['comparisons'][other] for g in good) if good else None for other in LABELS if other!=label}}
            for label in LABELS}
    # Resample complete opening blocks, preserving the three seat rotations.
    blocks={b:[g for g in good if g['block']==b] for b in sorted({g['block'] for g in good})}
    blocks={b:gs for b,gs in blocks.items() if len(gs)==3}
    cis={}
    if len(blocks)>=2:
        rng=np.random.default_rng(20261028)
        for a,b in [('mcts500','direct'),('mcts2000','direct'),('mcts2000','mcts500')]:
            delta=np.asarray([statistics.mean(g['results'][a]['winShare']-g['results'][b]['winShare'] for g in gs) for gs in blocks.values()])
            boot=delta[rng.integers(len(delta),size=(10000,len(delta)))].mean(1)
            cis[a+'-'+b]={'winShareDifference':float(delta.mean()),'95ClusterBootstrap':np.quantile(boot,[.025,.975]).tolist(),'openingBlocks':len(delta)}
    return {'ranking':result,'paired':cis,'successfulGames':len(good),'failedGames':len(games)-len(good)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--blocks',type=int,default=20);parser.add_argument('--resume',action='store_true');args=parser.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True);tempfile.tempdir=str(out)
    import numpy as np,torch
    torch.set_num_threads(1)
    from training.gpu_trainer import create_model,migrate_model_weights
    source=next((ROOT/'training-data').glob('checkpoint-020092-*.json.gz'))
    checkpoint=json.load(gzip.open(source,'rt',encoding='utf8'));np.asarray(checkpoint['model']['flat'],dtype='<f4').tofile(out/'source.bin')
    old=create_model('entity-v6','fast',15);old.load_flat(str(out/'source.bin'))
    new=create_model('entity-v6','fast',16);migrate_model_weights(old,new,11,12);new.save_flat(str(out/'model.bin'))
    config={'engine':str(ROOT/'native/game_engine-7b27a352ca0e.exe'),'worker':str(ROOT/'native/mcts_worker_libtorch-e450d9f49943.exe'),
            'flat':str((out/'model.bin').resolve()),'belief':str(ROOT/'training-data/belief/checkpoints/belief-00009500-20261019143224-1e3cad.npz')}
    manifest={'sourceCheckpoint':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
              'config':config,'budgets':[0,500,2000],'particles':8,'depth':700,'batch':32,'selection':'sample',
              'rootNoise':0,'learnedBelief':True,'progressiveParticles':True,'state':16,'action':12,
              'migration':'v15/v11 -> v16/v12, zero new inputs; no additional training',
              'workers':8,'orchestration':'eight independent samplers and native MCTS processes; BLAS threads limited to one',
              'opponent':'static hard, explicitly disabled MCTS',
              'sha256':{k:hashlib.sha256(Path(config[k]).read_bytes()).hexdigest() for k in ('engine','worker','flat','belief')}}
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    cases=[]
    for block in range(args.blocks):
        n=(4,6,8)[block%3];seats=[block%n,(block+n//3)%n,(block+2*n//3)%n]
        for rotation in range(3):
            cases.append({'block':block,'rotation':rotation,'players':n,'seed':(20261028^(block+1)*0x85EBCA6B)&0xffffffff,
                          'crown':block%n,'seats':{label:seats[(i+rotation)%3] for i,label in enumerate(LABELS)}})
    games=[]
    if args.resume and (out/'games.jsonl').exists():games=[json.loads(s) for s in (out/'games.jsonl').read_text(encoding='utf8').splitlines() if s.strip()]
    done={(g['block'],g['rotation']) for g in games if g['completed']}
    tasks=[(case,config) for case in cases if (case['block'],case['rotation']) not in done]
    started=time.monotonic()
    with ProcessPoolExecutor(max_workers=8) as executor:
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
