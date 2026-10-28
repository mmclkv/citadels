from pathlib import Path
import sys,json,hashlib,statistics
root=Path(r'D:\Users\Jiaming Qiu\citadels');sys.path.insert(0,str(root))
from python_backend.forced_action_eval import summarize
out=root/'test-runs/forced-action-500x60-20261028'
manifest=json.loads((out/'manifest.json').read_text(encoding='utf8'))
raw=(out/'games.jsonl').read_text(encoding='utf8')
lines=raw.splitlines()
if not raw.endswith('\n'):lines=lines[:-1]
attempts=[json.loads(x) for x in lines if x.strip()]
games=list({(g['block'],g['rotation']):g for g in attempts}.values())
partial='--partial' in sys.argv
if not partial:assert len(games)==manifest['games'] and all(g['completed'] for g in games)
for k,digest in manifest['sha256'].items():
    assert hashlib.sha256(Path(manifest['config'][k]).read_bytes()).hexdigest()==digest,k
assert hashlib.sha256(Path(manifest['sourceCheckpoint']).read_bytes()).hexdigest()==manifest['sourceSha256']
good=[g for g in games if g['completed']]
for g in good:
    for label in ('baseline','fast_forward'):
        assert g['instrumentation'][label]['visits']==g['decisions'][label]*manifest['config']['simulations']
blocks={b:[g for g in good if g['block']==b] for b in {g['block'] for g in good}}
for b,gs in blocks.items():
    if len(gs)!=2:
        assert partial
        continue
    assert len({g['openingDealHash'] for g in gs})==1,('opening mismatch',b)
    assert gs[0]['seats']['baseline']==gs[1]['seats']['fast_forward']
    assert gs[0]['seats']['fast_forward']==gs[1]['seats']['baseline']
    assert len({g['seed'] for g in gs})==len({g['crown'] for g in gs})==1
report=summarize(games,20000)
report.update(status='partial' if partial else 'complete',attemptRecords=len(attempts),
    hashesVerified=True,searchBudgetsVerified=True,pairedDealsVerified=True,
    byPlayers={str(n):summarize([g for g in games if g['players']==n],20000) for n in sorted({g['players'] for g in games})})
report['sameTable']={name:sum(g['results']['fast_forward']['pairwise']['baseline']==value for g in good)
                     for name,value in [('wins',1),('ties',.5),('losses',0)]}
report['otherPlayersWinShare']=len(good)-sum(x['winShare'] for x in report['results'].values())
file='partial-analysis.json' if partial else 'analysis.json'
(out/file).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
if not partial:
    labels={'baseline':'关闭连续推进','fast_forward':'开启连续推进'}
    rows=['# 单动作连续推进：同权重、同模拟次数战力对照','',
        '使用冻结的 20092 局策略权重（迁移至 v16/v12，无新增训练），同一原生二进制只切换 fastForwardSingleActions。',
        '每次搜索固定 500 次模拟，深度上限 700；初始粒子 8、持续补充及可见历史共享开启、batch 32、无根噪声、按访问分布随机抽样；使用同一 9500 局信念权重。',
        '30 个独立开局各交换两个网络席位一次，共 60 局。4/6/8 人各 20 局，其余席位使用显式关闭 MCTS 的困难静态启发式。两个搜索席位在各自搜索中仍将另一网络席位视为优化玩家，未精确模拟对手的完整搜索过程。',
        '', '| 方法 | 第一次数（含并列） | 平分冠军份额 | 平均名次 |', '|---|---:|---:|---:|']
    for label,r in report['results'].items():rows.append(f"| {labels[label]} | {r['firsts']}/60 | {r['winShare']:.3f}/60 | {r['meanRank']:.3f} |")
    p=report['paired'];w=p['winShareDifference'];q=p['pairwiseScore'];st=report['sameTable']
    rows+=['',f"开启相对关闭，平分冠军份额差 {w['estimate']*100:+.2f} 个百分点，按 30 个开局聚类的 95% bootstrap CI [{w['95ClusterBootstrap'][0]*100:+.2f}, {w['95ClusterBootstrap'][1]*100:+.2f}]。",
        f"同桌两两比较：开启方 {st['wins']} 胜、{st['ties']} 平、{st['losses']} 负；胜计 1、平计 0.5 的平均得分 {q['estimate']:.3f}，95% CI [{q['95ClusterBootstrap'][0]:.3f}, {q['95ClusterBootstrap'][1]:.3f}]。",
        '', '## 搜索成本', '', '| 方法 | 非强制搜索次数 | 平均搜索耗时（秒） | 含初始信念采样耗时（秒） | 平均展开物理节点 | 平均隐藏世界 |', '|---|---:|---:|---:|---:|---:|']
    for label,r in report['instrumentation'].items():rows.append(f"| {labels[label]} | {r['searches']} | {r['meanSearchSeconds']:.3f} | {r['meanTotalSeconds']:.3f} | {r['meanPhysicalExpansions']:.1f} | {r['meanWorlds']:.1f} |")
    rows+=['','这是同模拟次数评测，不是同时间预算评测。耗时是在 8 进程并发下、各自实际走到的局面上测得，不能当作严格同局面微基准。展开物理节点包含跳过估值的单动作节点，不能当作网络调用次数或决策深度。',
        '', '## 分人数结果', '', '| 人数 | 局数 | 关闭：第一 / 平均名次 | 开启：第一 / 平均名次 | 开启同桌两两得分 |','|---|---:|---:|---:|---:|']
    for n,r in report['byPlayers'].items():
        a,b=r['results']['baseline'],r['results']['fast_forward']
        rows.append(f"| {n} | {r['successfulGames']} | {a['firsts']} / {a['meanRank']:.3f} | {b['firsts']} / {b['meanRank']:.3f} | {b['pairwiseScore']:.3f} |")
    rows+=['','已核验所有对局预算、配对开局发牌哈希、座位互换，以及策略／信念权重与二进制哈希。失败尝试单独保留，不计作胜局；完整结果见 analysis.json，逐局记录见 games.jsonl，复现参数见 manifest.json 与 runner.py。']
    (out/'report.md').write_text('\n'.join(rows)+'\n',encoding='utf8')
print(json.dumps({k:report[k] for k in ('status','successfulGames','failedGames','completeOpeningBlocks','results','paired','instrumentation','sameTable')},ensure_ascii=False,indent=2))
