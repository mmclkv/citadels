"""Paired 2x2x2 live-policy arena. Never changes production rooms or weights.

Run from an immutable source snapshot with explicit compiled worker paths.
Each opening/seat is replayed for all eight variants against the same static
hard NPCs. First-place frequency and fractional wins are the primary outcomes;
no pairwise score 'wins' are reported as table victories.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
from collections import defaultdict
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import statistics
import sys
import time
import traceback
from types import SimpleNamespace

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = 'python_backend'

VARIANTS = [dict(key=f'b{b}h{h}d{d}', belief=bool(b), history=bool(h), dynamic=bool(d))
            for b, h, d in itertools.product((0, 1), repeat=3)]
CONTEXT = None


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def schedule(games_per_group=100, seed=2026101903):
    if games_per_group < 10 or games_per_group % 10:
        raise ValueError('games-per-group must be a positive multiple of 10')
    rng = random.Random(seed)
    openings = []
    for players in range(4, 9):
        for pair in range(games_per_group // 10):
            world_seed = rng.randrange(2**32)
            seats = rng.sample(range(players), 2)
            crown = rng.randrange(players)
            for swap, seat in enumerate(seats):
                openings.append(dict(opening=f'n{players}-p{pair}-s{swap}',
                    cluster=f'n{players}-p{pair}', players=players, seed=world_seed,
                    seat=seat, crown=crown, swap=swap))
    rng.shuffle(openings)
    cases = []
    for opening in openings:
        variants = list(VARIANTS)
        rng.shuffle(variants)
        cases.extend(dict(opening, **variant, id=opening['opening']+'-'+variant['key'])
                     for variant in variants)
    return cases


def initialize(config):
    global CONTEXT
    import copy
    import torch
    torch.set_num_threads(1)
    from .game_engine_worker import GameEngineWorker
    from .native_worker import NativeMctsWorker
    from .neural import NeuralPolicy
    from .belief import BeliefPolicy
    from . import cards
    engine = GameEngineWorker(config['engine'], env=dict(os.environ,
        CITADELS_HEURISTIC_MCTS_ENABLED='0'))
    worker = NativeMctsWorker(config['worker'])
    plain = NeuralPolicy(checkpoint=config['policy'], worker=worker, device='cpu')
    if plain.error:
        raise RuntimeError(plain.error)
    plain.belief_policy.disable()
    learned = copy.copy(plain)
    learned.belief_policy = BeliefPolicy(config['belief'])
    if not learned.belief_policy.model:
        raise RuntimeError(learned.belief_policy.error or 'Belief model did not load')
    # Warm the shared policy model and learned scorer before timed evaluation.
    warm = engine.create_game(dict(seed=1719, charSetMode='random', endDistricts=8,
        catalog=cards._catalog, seats=[dict(id=f'p{i}', isBot=True,
        botType='neural', botLevel='hard') for i in range(4)]), 'warm')
    decision = engine.decision('warm')
    sampled = worker.determinize(state=warm, player_id=decision['playerId'], count=4, seed=9, belief=False)
    worker.search(state=sampled['particles'][0], particles=[], root_player_id=decision['playerId'],
        legal_actions=decision['actions'], particle_weights=[1.], model_path=plain.model_path,
        model_version=1, profile=plain.profile, architecture=plain.architecture, device='cpu',
        simulations=1, max_depth=1, c_puct=1., dirichlet_alpha=.3, dirichlet_epsilon=0.,
        seed=1, action_encoding_version=plain.action_version, policy_only=True)
    scorer = learned.belief_policy.candidate_scorer(warm, decision['playerId'])
    if scorer:
        scorer[0](sampled['particles'])
    engine.close_game('warm')
    CONTEXT = config, engine, worker, plain, learned


def run_case(case):
    from . import cards
    from . import neural as neural_module
    config, engine, worker, plain, learned = CONTEXT
    policy = learned if case['belief'] else plain
    learned.belief_policy.histories.clear()
    learned.belief_policy.error = ''; learned.belief_policy.last = None
    out = Path(config['output']); status = out/f'worker-{os.getpid()}.json'
    start = time.perf_counter(); steps = 0; state = {}
    stats = dict(decisions=0, searches=0, visits=0, expansions=0, seconds=0.,
        proposals=0, worlds=0, duplicates=0, refreshes=0, samplingMs=0.,
        essSum=0., essCount=0, budgetOverruns=0, learnedScored=0,
        nativePrivatePhase=0)
    row = dict(case, complete=False)
    gid = case['id']
    def progress():
        atomic_json(status, dict(id=gid, key=case['key'], players=case['players'],
            round=state.get('round'), steps=steps, decisions=stats['decisions'],
            elapsed=round(time.perf_counter()-start, 1)))
    try:
        state = engine.create_game(dict(seed=case['seed'], initialCrownSeat=case['crown'],
            charSetMode='random', endDistricts=8, startingHand=4, startingGold=2,
            catalog=cards._catalog, seats=[dict(id=f'p{i}', name=f'p{i}', isBot=True,
            botType='neural' if i==case['seat'] else 'npc', botLevel='hard')
            for i in range(case['players'])]), gid)
        seen = defaultdict(int)
        progress()
        for steps in range(10000):
            if engine.current(gid).get('gameOver'):
                state = engine.snapshot(gid)
                scores = [s['total'] for s in state['scores']]
                score = scores[case['seat']]; best = max(scores)
                row.update(complete=True, scores=scores, score=score,
                    first=score==best, winShare=(1/scores.count(best) if score==best else 0.),
                    rank=1+sum(s>score for s in scores), rounds=state.get('round'))
                break
            decision = engine.decision(gid)
            state = decision['state']
            # Observe every actual action, including opponents', but all model
            # inputs still go through the per-player visibility allow-list.
            policy.observe_belief(state)
            if state.get('round', 0)>100:
                raise RuntimeError('round limit exceeded')
            actor = decision['playerId']; actions = decision['actions']
            if actor == f"p{case['seat']}":
                policy.belief_policy.last = None
                pending = ((state.get('turn') or {}).get('pending') or {}).get('kind')
                private = bool(pending or state.get('reaction'))
                tick = time.perf_counter(); diagnostics = {}
                action_seed = (case['seed'] ^ (steps*2654435761) ^ (case['seat']*2246822519)) & 0xffffffff
                original = neural_module.random
                neural_module.random = SimpleNamespace(Random=lambda: random.Random(action_seed))
                try:
                    action = policy.decide(state, actor, {'actions':actions}, dict(
                        advancedEnabled=True, timeBudgetMs=config['budgetMs'],
                        simulations=2147483647, maxDepth=2000, particles=4, selection='sample',
                        belief=True, shareInformationHistory=case['history'],
                        progressiveParticles=case['dynamic']), diagnostics=diagnostics)
                finally:
                    neural_module.random = original
                seconds = time.perf_counter()-tick
                stats['decisions'] += 1; stats['seconds'] += seconds
                if diagnostics['method'] != 'forced-action':
                    m = diagnostics['mcts']; stats['searches'] += 1
                    if m['shareInformationHistory'] != case['history'] or m['progressiveParticles'] != case['dynamic']:
                        raise RuntimeError('Ablation switch was not applied')
                    for source, target in [('visits','visits'), ('expansions','expansions'),
                        ('particleProposals','proposals'), ('determinizations','worlds'),
                        ('particleDuplicates','duplicates'), ('particleRefreshes','refreshes'),
                        ('particleSamplingMs','samplingMs')]:
                        stats[target] += m.get(source, 0) or 0
                    last = policy.belief_policy.last
                    ess = m.get('particleEss')
                    if not case['dynamic'] and last:
                        # A fixed learned pool can contain repeated worlds.
                        stats['worlds'] += last['uniqueParticles']-m.get('determinizations', 0)
                        ess = last['effectiveSamples']
                    if ess is not None:
                        stats['essSum'] += ess; stats['essCount'] += 1
                    stats['budgetOverruns'] += seconds > (config['budgetMs']+50)/1000
                    if case['belief']:
                        stats['nativePrivatePhase' if private else 'learnedScored'] += 1
                    if m.get('particleSamplingError'):
                        raise RuntimeError('Learned candidate scoring failed: '+m['particleSamplingError'])
                if policy.belief_policy.error:
                    raise RuntimeError('Belief fallback invalidates this trial: '+policy.belief_policy.error)
            else:
                action = engine.decide_npc(game_id=gid, player_id=actor,
                    seed=(case['seed']+steps)&0xffffffff, heuristic_mcts={'timeBudgetMs':0})
            if action not in actions:
                raise RuntimeError('Illegal action')
            # Detect navigation loops without inspecting hidden information.
            signature = json.dumps((actor, state.get('round'), state.get('turn'), action), sort_keys=True)
            seen[signature] += 1
            if seen[signature] > 30:
                raise RuntimeError('Repeated action loop')
            state = engine.apply(game_id=gid, player_id=actor, action=action)
            if steps % 10 == 0:
                progress()
        else:
            raise RuntimeError('step limit exceeded')
    except Exception as error:
        row.update(error=str(error), traceback=traceback.format_exc())
    finally:
        row.update(stats=stats, seconds=time.perf_counter()-start, steps=steps)
        try:
            engine.close_game(gid)
        except Exception:
            pass
        status.unlink(missing_ok=True)
    return row


def summarize(rows, bootstrap=0):
    import numpy as np
    complete = [r for r in rows if r['complete']]
    result = dict(completed=len(complete), failures=len(rows)-len(complete), groups={}, byPlayers={})
    for variant in VARIANTS:
        group = [r for r in complete if r['key']==variant['key']]
        if not group:
            continue
        searches = sum(r['stats']['searches'] for r in group)
        result['groups'][variant['key']] = dict(variant, games=len(group),
            firsts=sum(r['first'] for r in group), firstRate=statistics.mean(r['first'] for r in group),
            winShares=sum(r['winShare'] for r in group), winShareRate=statistics.mean(r['winShare'] for r in group),
            meanScore=statistics.mean(r['score'] for r in group), meanRank=statistics.mean(r['rank'] for r in group),
            searches=searches, meanVisits=sum(r['stats']['visits'] for r in group)/max(1,searches),
            meanWorlds=sum(r['stats']['worlds'] for r in group)/max(1,searches),
            meanSamplingMs=sum(r['stats']['samplingMs'] for r in group)/max(1,searches),
            budgetOverruns=sum(r['stats']['budgetOverruns'] for r in group),
            learnedScored=sum(r['stats']['learnedScored'] for r in group),
            nativePrivatePhase=sum(r['stats']['nativePrivatePhase'] for r in group))
        result['byPlayers'][variant['key']] = {str(n):dict(games=len(g),firsts=sum(r['first'] for r in g),
            winShares=sum(r['winShare'] for r in g)) for n in range(4,9)
            if (g:=[r for r in group if r['players']==n])}
    if not bootstrap:
        return result
    # Only complete matched 8-configuration blocks and both swapped seats
    # contribute to contrasts. One seed-pair, not one match, is the cluster.
    blocks = defaultdict(dict)
    for r in complete:
        blocks[r['opening']][r['key']] = r
    clusters = defaultdict(list)
    for block in blocks.values():
        if len(block)==8:
            clusters[next(iter(block.values()))['cluster']].append(block)
    clusters = [blocks for blocks in clusters.values() if len(blocks)==2]
    result['matchedClusters'] = len(clusters)
    if not clusters:
        return result
    rng = np.random.default_rng(2026101907)
    strata = defaultdict(list)
    for i, pair in enumerate(clusters):
        strata[next(iter(pair[0].values()))['players']].append(i)
    indices = np.concatenate([rng.choice(group,size=(bootstrap,len(group)),replace=True)
                              for _,group in sorted(strata.items())],axis=1)
    effects = {}
    for metric in ('first','winShare','score'):
        effects[metric] = {}
        for factors in ((0,),(1,),(2,),(0,1),(0,2),(1,2),(0,1,2)):
            values = []
            for pair in clusters:
                contrast = 0.
                for block in pair:
                    for bits in itertools.product((0,1),repeat=3):
                        sign = math.prod(1 if bits[i] else -1 for i in factors)
                        contrast += sign*block[f'b{bits[0]}h{bits[1]}d{bits[2]}'][metric]/(2*2**(3-len(factors)))
                values.append(contrast)
            values = np.asarray(values); boot = values[indices].mean(axis=1)
            name = '*'.join('BHD'[i] for i in factors)
            effects[metric][name] = dict(mean=float(values.mean()),
                ci95=np.quantile(boot,[.025,.975]).tolist(),
                # Bonferroni intervals for the three primary main effects.
                mainEffectCi9833=np.quantile(boot,[.05/6,1-.05/6]).tolist() if len(factors)==1 else None)
    result['effects'] = effects
    result['groupIntervals'] = {}
    for variant in VARIANTS:
        key = variant['key']; result['groupIntervals'][key] = {}
        for metric in ('first','winShare'):
            values = np.array([statistics.mean(block[key][metric] for block in pair) for pair in clusters])
            result['groupIntervals'][key][metric] = np.quantile(values[indices].mean(axis=1),[.025,.975]).tolist()
    return result


def report(output):
    metadata=json.loads((output/'metadata.json').read_text(encoding='utf-8'))
    for key, expected in metadata['hashes'].items():
        if sha(metadata[key])!=expected:raise RuntimeError(key+' changed during experiment')
    for name, expected in metadata['sourceHashes'].items():
        if sha(Path(metadata['sourceRoot'])/name)!=expected:raise RuntimeError(name+' source changed')
    rows = [json.loads(s) for s in (output/'games.jsonl').read_text(encoding='utf-8').splitlines() if s]
    cases={case['id']:case for case in metadata['schedule']}
    if len({r['id'] for r in rows})!=len(rows):raise RuntimeError('Duplicate result IDs')
    for row in rows:
        case=cases[row['id']]
        if any(row[key]!=value for key,value in case.items()):raise RuntimeError('Result/schedule mismatch')
        if row['complete']:
            scores=row['scores'];score=scores[row['seat']]
            if row['score']!=score or row['first']!=(score==max(scores)):
                raise RuntimeError('Incorrect final score or first-place label')
            expected=(1/scores.count(max(scores)) if score==max(scores) else 0.)
            if abs(row['winShare']-expected)>1e-12:raise RuntimeError('Incorrect fractional win')
    result = summarize(rows,bootstrap=10000)
    atomic_json(output/'summary.json',result)
    lines = ['# 三因素战力消融实验','', 'B：学习信念网络；H：按玩家可见历史共享决策；D：持续补充隐藏世界。',
        '',f"完成 {result['completed']} 局，失败 {result['failures']} 局。",'',
        '| 组合 | 信念 | 历史共享 | 动态世界 | 局数 | 第一次数（含并列） | 分摊夺冠点数 | 平均分 | 平均名次 |',
        '|---|---|---|---|---:|---:|---:|---:|---:|']
    for v in VARIANTS:
        g=result['groups'].get(v['key'])
        if g:lines.append(f"| {v['key']} | {int(v['belief'])} | {int(v['history'])} | {int(v['dynamic'])} | {g['games']} | {g['firsts']} | {g['winShares']:.2f} | {g['meanScore']:.2f} | {g['meanRank']:.2f} |")
    lines += ['', '## 因素作用与交互','', '正值表示打开因素后更高。主效应对另外两个开关的四种组合取平均；交互为差上之差，不能当作某一组的绝对夺冠率。',
        '', '| 效应 | 第一率变化，百分点 | 95% 配对区间 | 分摊夺冠率变化，百分点 | 95% 配对区间 |',
        '|---|---:|---|---:|---|']
    for name, effect in result.get('effects',{}).get('first',{}).items():
        other=result['effects']['winShare'][name]
        fmt=lambda ci:f'[{100*ci[0]:+.2f}, {100*ci[1]:+.2f}]'
        lines.append(f"| {name} | {100*effect['mean']:+.2f} | {fmt(effect['ci95'])} | {100*other['mean']:+.2f} | {fmt(other['ci95'])} |")
    lines += ['', '## 解释范围','',
        '- 每个开局和被测座位在全部八组重放；同一种子再交换两个被测座位。仅一个席位使用被测网络，其他为固定困难静态启发式电脑。',
        '- 4–8 人均衡，冻结同一策略权重与信念 checkpoint。B 关闭仍保留原生弱规则采样；H 关闭恢复物理分支独立统计；D 关闭为固定 4 粒子。',
        '- CPU 每行动实际总预算相同，包含初始采样/评分。深度上限 2000，访问分布抽样，无根噪声。学习采样不支持的私人响应阶段保留原生路径并统计次数；意外回退使该局失败。',
        '- 置信区间按交换座位的开局对聚类，在各人数层内 bootstrap 10000 次。三项主效应另给 98.33% Bonferroni 区间（summary.json）；交互及组别排序为探索性分析。',
        '- 失败局不算输赢；仅八组和两个座位都完成的匹配块用于因素对照。原始局数和失败均保留，不能只删除某组的不利场次。',
        '- 本实验不是两名网络玩家的相互得分胜负，也不能直接与此前双网络同桌的 100 局相加；它衡量固定对手群下的整桌夺冠能力，不能外推为多人类房间的效果。',
        '- metadata.json 固定完整赛程、权重/程序/源码哈希；games.jsonl 保存逐局数据、开关和运行诊断。']
    (output/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--report',action='store_true')
    for key in ('engine','worker','policy','belief'):
        parser.add_argument('--'+key,type=Path)
    parser.add_argument('--games-per-group',type=int,default=100)
    parser.add_argument('--budget-ms',type=int,default=5000)
    parser.add_argument('--workers',type=int,default=16)
    parser.add_argument('--seed',type=int,default=2026101903)
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    if args.report:
        print(json.dumps(report(output),ensure_ascii=False,indent=2));return
    if args.budget_ms<=0 or args.workers<=0:
        parser.error('budget-ms and workers must be positive')
    config=dict(output=str(output),budgetMs=args.budget_ms)
    for key in ('engine','worker','policy','belief'):
        path=getattr(args,key)
        if path is None or not path.is_file():parser.error('--'+key+' must name a file')
        config[key]=str(path.resolve())
    cases=schedule(args.games_per_group,args.seed)
    root=Path(__file__).resolve().parents[1]
    sources=[p for folder in ('python_backend','training','native') for p in (root/folder).rglob('*')
             if p.suffix in ('.py','.hpp','.cpp','.json') and p.is_file()]
    metadata=dict(config,workers=args.workers,gamesPerGroup=args.games_per_group,seed=args.seed,
        hashes={key:sha(config[key]) for key in ('engine','worker','policy','belief')},
        sourceHashes={str(p.relative_to(root)):sha(p) for p in sources},schedule=cases,
        sourceRoot=str(root),opponents='one tested network seat; static hard heuristic NPCs',
        device='cpu',selection='sample',initialParticles=4,depthCap=2000)
    meta=output/'metadata.json'
    if meta.exists():
        if json.loads(meta.read_text(encoding='utf-8'))!=metadata:
            raise RuntimeError('Refusing to mix different configurations or source snapshots')
    else:atomic_json(meta,metadata)
    path=output/'games.jsonl'
    rows=[json.loads(s) for s in path.read_text(encoding='utf-8').splitlines() if s] if path.exists() else []
    done={r['id'] for r in rows}
    if len(done)!=len(rows):raise RuntimeError('Duplicate result IDs')
    todo=[c for c in cases if c['id'] not in done]
    print('START',len(todo),'pending /',len(cases),'games',flush=True)
    with ProcessPoolExecutor(max_workers=args.workers,initializer=initialize,initargs=(config,)) as executor:
        jobs={executor.submit(run_case,case):case for case in todo}
        while jobs:
            ready,_=wait(jobs,timeout=25,return_when=FIRST_COMPLETED)
            for future in ready:
                case=jobs.pop(future)
                try:row=future.result()
                except Exception as error:row=dict(case,complete=False,error=str(error))
                rows.append(row)
                with path.open('a',encoding='utf-8') as stream:stream.write(json.dumps(row,ensure_ascii=False)+'\n')
                summary=summarize(rows);atomic_json(output/'summary.json',summary)
                print('FINISHED',row['id'],row['complete'],row.get('first'),row.get('error'),flush=True)
            print('PROGRESS',len(rows),'/',len(cases),flush=True)
    result=report(output)
    print('FINAL',json.dumps(result,ensure_ascii=False),flush=True)
    if result['failures']:raise SystemExit(1)


if __name__=='__main__':
    for variable in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS'):
        os.environ[variable]='1'
    main()
