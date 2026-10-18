# 三因素战力消融

已完成的 800 局结果见[2026-10-19 消融报告](ablation-results-20261019.md)，包含配对区间、交互、基础设施重放记录和不含重放数据的敏感性分析。

`python_backend/ablation_eval.py` 对学习信念网络 B、玩家可见历史决策共享 H、持续补充根隐藏世界 D 做完整 2×2×2 实验。默认各 100 局、总计 800 局，CPU 每行动总预算 5000ms；以整桌第一次数（含并列）和按并列人数分摊的夺冠点数为主要结果。

H 的运行时开关为 `mcts.shareInformationHistory`（worker 协议为同名字段）。默认 true，正常实战与训练行为不变。false 同时停用模拟内观察历史维护、以当前行动者信息集定位物理子节点、为每个物理节点保留独立统计，重现修复前的策略融合；仍对网络输入执行相同的信息可见性掩码。原生反例验证开启时估值约 0.5、关闭时虚高至约 1，两种 MCTS 核心均覆盖。要求关闭但 worker 不支持该开关时明确报错。

每组 4–8 人各 20 局。50 个全新世界种子，每个选两个不同的被测座位重放；每个开局/座位再重放全部八个组合。每局只有一个被测网络席位，其余均为困难静态启发式电脑。全部组固定同一策略权重、同一学习信念 checkpoint、同一原生规则引擎和搜索 worker。最大深度 2000、初始 4 世界、按根访问分布抽样，无根噪声。暖机在计时评测前完成，进程内只用一个策略模型路径。

B 关闭只禁用学习信念网络，保留原生弱规则权重。B 开启、D 关闭时使用原有 16 候选重采样为 4 粒子的路径；D 开启使用本次完整的动态世界实现，包括统一权重池、重复质量合并及开销节流，因此 D 的效应不是只改变一个数量常数。私人响应阶段不支持的学习提议仍按设计使用原生采样，计数单列；任何意外模型回退使该局失败，不能把回退组当作信念已开启。

脚本保存完整赛程、每局开关和分数、诊断、失败以及权重/程序/源码哈希。报告生成会重新验证这些哈希与结果标签。建议在独立源码快照中运行；恢复评测必须保持同样的参数和源码，不会混合不同版本结果。统计按世界种子及两个座位聚类，在人数层内 bootstrap 10000 次，给出三个主效应、三个二阶交互和一个三阶交互。三项主效应另给 98.33% Bonferroni 区间；交互、分人数结果和最高组别的排序属于探索性分析。

此设计衡量固定启发式对手群下的整桌夺冠能力。它不使用“两名网络玩家相互比最终得分”的胜负口径，不能与此前双网络同桌的实验直接相加，也不能代表多人类房间。

运行示例（路径替换为冻结快照的实际文件）：

```sh
python python_backend/ablation_eval.py --output results --engine game_engine --worker mcts_worker --policy policy-default.json.gz --belief belief-checkpoint.npz --games-per-group 100 --budget-ms 5000 --workers 16
python python_backend/ablation_eval.py --output results --report
```

测试：`python -m unittest python_backend.test_ablation_eval python_backend.test_information_sets python_backend.test_root_particles python_backend.test_neural_selection python_backend.test_opponent_policy_protocol`。
