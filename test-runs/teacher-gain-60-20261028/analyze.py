from pathlib import Path
import json,statistics,sys,hashlib
import numpy as np
OUT=Path(r'D:\Users\Jiaming Qiu\citadels\test-runs\teacher-gain-60-20261028')
labels=('direct','mcts500','mcts2000')
raw=(OUT/'games.jsonl').read_text(encoding='utf8')
lines=raw.splitlines()
if raw and not raw.endswith('\n'):lines=lines[:-1]
attempts=[json.loads(line) for line in lines if line.strip()]
games=list({(g['block'],g['rotation']):g for g in attempts}.values())
good=[g for g in games if g['completed']]
partial='--partial' in sys.argv
if not partial and len(good)!=60:raise RuntimeError(f'Evaluation incomplete: {len(good)}/60')
manifest=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
assert hashlib.sha256(Path(manifest['sourceCheckpoint']).read_bytes()).hexdigest()==manifest['sourceSha256']
for key,digest in manifest['sha256'].items():
    assert hashlib.sha256(Path(manifest['config'][key]).read_bytes()).hexdigest()==digest,key
for game in good:
    assert len(set(game['seats'].values()))==3
    for label,budget in [('mcts500',500),('mcts2000',2000)]:
        assert game['instrumentation'][label]['visits']==budget*game['decisions'][label]
blocks={b:[g for g in good if g['block']==b] for b in {g['block'] for g in good}}
blocks={b:gs for b,gs in blocks.items() if len(gs)==3}
for block,gs in blocks.items():
    assert len({g['seed'] for g in gs})==1 and len({g['crown'] for g in gs})==1
    expected=set(gs[0]['seats'].values())
    for label in labels:assert {g['seats'][label] for g in gs}==expected
def results(rows):
    return {label:{'games':len(rows),'firsts':sum(g['results'][label]['first'] for g in rows),
            'winShare':sum(g['results'][label]['winShare'] for g in rows),
            'meanRank':statistics.mean(g['results'][label]['rank'] for g in rows),
            'pairwise':{other:statistics.mean(g['results'][label]['comparisons'][other] for g in rows) for other in labels if other!=label}}
            for label in labels}
report={'status':'partial' if partial else 'complete','successfulGames':len(good),'failedCases':len(games)-len(good),
        'attemptRecords':len(attempts),'uniqueCases':len(games),'completeOpeningBlocks':len(blocks),
        'allSearchBudgetsVerified':True,'checkpointAndBinaryHashesVerified':True,'results':results(good),
        'byPlayers':{str(n):results([g for g in good if g['players']==n]) for n in sorted({g['players'] for g in good})}}
rng=np.random.default_rng(20261028)
paired={}
if blocks:
    for a,b in [('mcts500','direct'),('mcts2000','direct'),('mcts2000','mcts500')]:
        delta=np.array([statistics.mean(g['results'][a]['winShare']-g['results'][b]['winShare'] for g in gs) for gs in blocks.values()])
        score=np.array([statistics.mean(g['results'][a]['comparisons'][b] for g in gs) for gs in blocks.values()])
        picks=rng.integers(len(delta),size=(20000,len(delta)))
        paired[a+'-'+b]={'winShareDifference':float(delta.mean()),'winShareDifference95CI':np.quantile(delta[picks].mean(1),[.025,.975]).tolist(),
                         'pairwiseScore':float(score.mean()),'pairwiseScore95CI':np.quantile(score[picks].mean(1),[.025,.975]).tolist()}
report['paired']=paired
report['instrumentation']={}
for label in ('mcts500','mcts2000'):
    count=sum(g['decisions'][label] for g in good)
    visits=sum(g['instrumentation'][label]['visits'] for g in good)
    report['instrumentation'][label]={'searches':count,'totalVisits':visits,
        'meanUniqueWorlds':sum(g['instrumentation'][label]['particlesUsed'] for g in good)/count,
        'meanExpansions':sum(g['instrumentation'][label]['expansions'] for g in good)/count,
        'changedBestFraction':sum(g['instrumentation'][label]['changedBest'] for g in good)/count}
report['npcWinShare']=len(good)-sum(v['winShare'] for v in report['results'].values())
probe=Path(r'C:\Users\Jiaming Qiu\citadels\tmp\search-depth-diagnosis-20261028\report.json')
if probe.exists():
    report['depthProbe']=json.loads(probe.read_text(encoding='utf8'))
    if not partial:(OUT/'depth-probe.json').write_text(probe.read_text(encoding='utf8'),encoding='utf8')
name='partial-analysis.json' if partial else 'analysis.json'
(OUT/name).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
if not partial:
    text=['# 搜索收益同桌评测（2026-10-28）','','已完成 60 局，20 个开局各轮换三次座位。三种方法同时参赛，使用冻结的 20092 局权重。',
          '迁移到 v16/v12，但没有追加训练；新信息输入初始不改变旧网络输出。此实验检验搜索方法与预算，不代表新编码经过训练后的战力。','',
          '| 方法 | 第一次数（含并列） | 平分冠军份额 | 平均名次 |','|---|---:|---:|---:|']
    for label,v in report['results'].items():text.append(f"|{label}|{v['firsts']}/60|{v['winShare']:.3f}/60|{v['meanRank']:.3f}|")
    text+=['','其他玩家为显式禁用 MCTS 的困难静态启发式。初始粒子 8、持续补充开启、深度上限 700、batch 32、无探索噪声；三者均按概率抽样。使用同一 9500 局信念权重。',
           '已逐局核对访问次数，500/2000 预算均实际完成；已核对三个座位轮换及源权重、模型、信念和二进制哈希。','',
           '## 按开局聚类的配对统计','','正的夺冠份额差表示前者更好；置信区间按 20 个开局整体重采样，不把同一开局的三次轮换视为独立。']
    for label,v in paired.items():text.append(f"- {label}：夺冠份额差 {v['winShareDifference']*100:+.2f} 个百分点，95% CI [{v['winShareDifference95CI'][0]*100:+.2f}, {v['winShareDifference95CI'][1]*100:+.2f}]；同桌两两得分 {v['pairwiseScore']:.3f}，95% CI [{v['pairwiseScore95CI'][0]:.3f}, {v['pairwiseScore95CI'][1]:.3f}]。")
    text+=['','## 搜索实际规模','']
    for label,v in report['instrumentation'].items():text.append(f"- {label}：{v['searches']} 次非强制搜索，平均 {v['meanUniqueWorlds']:.1f} 个不同隐藏世界，平均展开 {v['meanExpansions']:.1f} 个节点，最高概率动作相对直接策略改变比例 {v['changedBestFraction']:.1%}。")
    text+=['','持续补充按固定间隔增加世界，因此增加模拟次数也同时增加世界数量，不能等同于只增加搜索深度。',
           '独立结构探针使用 4/8 人、启发式对手的六个快照，关闭学习信念以隔离树结构。探针仅在源代码副本中记录深度，不改变正式评测算法；不能将这些快照当作完整战力评测。详见 depth-probe.json。',
           '', '原始对局包含资源不足时的旧失败尝试记录；统计使用每个开局/轮换最后一次结果，失败并未计作获胜。正式结果的所有 60 个唯一案例已完成。',
           '', '复现信息：manifest.json、runner.py、engine.build.json、worker.build.json、games.jsonl。新增编码、训练固定验证集、迁移兼容及控制台说明见 ../../docs/training-reliability.md。']
    (OUT/'report.md').write_text('\n'.join(text)+'\n',encoding='utf8')
print(json.dumps({k:report[k] for k in ('status','successfulGames','failedCases','completeOpeningBlocks','results','paired','instrumentation')},ensure_ascii=False,indent=2))
