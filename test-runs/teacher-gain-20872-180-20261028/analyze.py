import hashlib,json,sys,shutil
from pathlib import Path
root=Path(r'D:\Users\Jiaming Qiu\citadels');sys.path.insert(0,str(root))
from python_backend.search_gain_eval import summarize,LABELS
out=root/'test-runs/teacher-gain-20872-180-20261028'
manifest=json.loads((out/'manifest.json').read_text(encoding='utf-8'))
rows=list({(g['block'],g['rotation']):g for g in
    (json.loads(line) for line in (out/'games.jsonl').read_text(encoding='utf-8').splitlines())}.values())
assert len(rows)==180 and all(g['completed'] for g in rows)
assert {n:sum(g['players']==n for g in rows) for n in (4,6,8)}=={4:60,6:60,8:60}
for b in range(60):
    gs=[g for g in rows if g['block']==b]
    assert len(gs)==3 and len({g['openingDealHash'] for g in gs})==1
    assert len({tuple(g['seats'][label] for g in gs) for label in LABELS})==3
    assert len({frozenset(g['seats'][label] for g in gs) for label in LABELS})==1
for g in rows:
    for label,budget in zip(LABELS,(0,500,2000)):
        assert g['instrumentation'][label].get('visits',0)==budget*g['decisions'].get(label,0)
for k,h in manifest['sha256'].items():
    assert hashlib.sha256(Path(manifest['config'][k]).read_bytes()).hexdigest()==h,(k,'hash changed')
assert hashlib.sha256(Path(manifest['sourceCheckpoint']).read_bytes()).hexdigest()==manifest['sourceSha256']
report=summarize(rows)
(out/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
by_players={str(n):{k:v['metrics']['firstRateDifference'] for k,v in
    summarize([g for g in rows if g['players']==n])['paired'].items()} for n in (4,6,8)}
(out/'by-player-confidence.json').write_text(json.dumps(by_players,ensure_ascii=False,indent=2),encoding='utf-8')
names=dict(direct='直接策略',mcts500='500 次搜索',mcts2000='2000 次搜索')
lines=['# 冻结 20872 权重：搜索教师收益评测','',
'180 局全部完成：60 个开局各轮换三次座位；4／6／8 人局各 60 局。直接策略、500 次搜索、2000 次搜索同桌对战，其他座位为显式禁用搜索的困难启发式。','',
'| 方法 | 第一次数（含并列） | 夺冠率 | 平分冠军份额 | 平均名次 |',
'|---|---:|---:|---:|---:|']
for label in LABELS:
    r=report['ranking'][label]
    lines.append(f"| {names[label]} | {r['firsts']}/180 | {r['firsts']/180:.1%} | {r['winShare']:.3f}/180 | {r['meanRank']:.3f} |")
lines+=['','结论依据整体夺冠率的开局聚类区间：']
for pair,p in report['paired'].items():
    a,b=pair.split('-');lo,hi=p['metrics']['firstRateDifference']['95ClusterBootstrap']
    conclusion='有正向收益的统计支持' if lo>0 else '有负向收益的统计支持' if hi<0 else '差异尚不确定，区间包含零'
    lines.append(f'- {names[a]}相对{names[b]}：{conclusion}。')
lines+=['','## 同桌配对差异','',
'置信区间按完整开局重采样（每组保留三次轮换），10000 次 bootstrap。正的夺冠率差、冠军份额差表示前者更强；两两得分 50% 为持平。各区间为逐项 95% 区间，未作多重比较校正。','',
'| 比较 | 夺冠率差及 95% CI | 冠军份额差及 95% CI | 同桌两两得分及 95% CI |',
'|---|---:|---:|---:|']
for pair,p in report['paired'].items():
    a,b=pair.split('-');m=p['metrics']
    def diff(k):
        x=m[k];lo,hi=x['95ClusterBootstrap'];return f"{x['estimate']*100:+.2f} pp [{lo*100:+.2f}, {hi*100:+.2f}]"
    x=m['pairwiseScore'];lo,hi=x['95ClusterBootstrap']
    lines.append(f"| {names[a]} − {names[b]} | {diff('firstRateDifference')} | {diff('winShareDifference')} | {x['estimate']:.1%} [{lo:.1%}, {hi:.1%}] |")
lines+=['','## 按人数','', '| 人数 | 直接策略第一 | 500 次第一 | 2000 次第一 |','|---|---:|---:|---:|']
for n,rs in report['byPlayers'].items():
    lines.append('| '+n+' | '+' | '.join(f"{rs[k]['firsts']}/60" for k in LABELS)+' |')
lines+=['','分人数的夺冠率差与 95% 开局聚类区间（相对直接策略）：','',
        '| 人数 | 500 次搜索 | 2000 次搜索 |','|---|---:|---:|']
for n,stats in by_players.items():
    values=[]
    for pair in ('mcts500-direct','mcts2000-direct'):
        x=stats[pair];lo,hi=x['95ClusterBootstrap']
        values.append(f"{x['estimate']*100:+.2f} pp [{lo*100:+.2f}, {hi*100:+.2f}]")
    lines.append('| '+n+' | '+' | '.join(values)+' |')
lines+=['','整体样本支持搜索有效，但目前只有 4 人局显示明确的分组收益；6／8 人局区间包含零，不能认定在这些人数下也稳定提高夺冠率。2000 次相对 500 次也未显示明确的额外收益。']
lines+=['','## 实际搜索规模','', '| 方法 | 非强制决策数 | 平均搜索耗时 | 含初始采样耗时 | 平均展开节点 | 平均隐藏世界 | 最高概率动作改变比例 |',
'|---|---:|---:|---:|---:|---:|---:|']
for k,x in report['instrumentation'].items():
    lines.append(f"| {names[k]} | {x['searches']} | {x['meanSearchSeconds']:.3f}s | {x['meanTotalSeconds']:.3f}s | {x['meanExpansions']:.1f} | {x['meanParticlesUsed']:.1f} | {x['meanChangedBest']:.1%} |")
lines+=['','## 配置与边界','',
'- 冻结 checkpoint-020872，源文件、评测模型、信念权重、原生引擎及搜索二进制 SHA256 见 manifest.json；完成后全部复核未变。',
'- 同一权重语义迁移 v15/v11 → v16/v12，新输入权重置零；未追加训练，三种方法共用同一迁移模型。',
'- 使用训练配置指定的 9500 局信念权重；初始粒子 8、持续补充开启、可见历史共享开启、单动作快进开启、batch 32、深度上限 700。',
'- 无根探索噪声；三种方法均按概率抽样，温度 1。本实验评估无噪声搜索策略的战力增益，不等同于训练时加入噪声及温度退火后的每个教师样本质量。',
'- 增加模拟也会增加隐藏世界数，这是当前完整搜索方法的预算收益；本实验没有单独消融深度与粒子数。',
'- 同桌比较反映该混合阵容中的相对战力，不代表对所有其他阵容、人类对手都成立。',
'- 已逐局核对 500／2000 的累计访问次数；完整开局的发牌哈希及三种方法的座位轮换一致。',
'- 未重启游戏服务器，未修改训练进程或生产权重。','',
'- 前 12 局使用 8 路并行，随后保留结果并以 16 路完成剩余对局；固定模拟次数不依赖运行速度。',
'',
'复现：在仓库根目录运行 `python python_backend/search_gain_eval.py --output <新目录> --blocks 60 --workers 16 --checkpoint training-data/checkpoint-020872-pfast-aentity-v6-m500-crandom-s114514.json.gz`。使用 manifest.json 指定的版本及哈希；runner.py 是执行时脚本的源代码快照。']
(out/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
if not (out/'runner.py').exists():
    shutil.copyfile(root/'python_backend/search_gain_eval.py',out/'runner.py')
if Path(__file__).resolve() != (out/'analyze.py').resolve():
    shutil.copyfile(__file__,out/'analyze.py')
print(json.dumps(report,ensure_ascii=False,indent=2))
