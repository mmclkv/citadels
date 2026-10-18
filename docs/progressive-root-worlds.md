# 搜索中逐步补充隐藏世界

策略网络实战和训练用的完整 MCTS 默认启用。策略网络架构、状态 v15 / 动作 v11、现有权重和按访问分布抽样的行动方式不变。

## 行为

一次决策先生成少量合法世界（自动模式 4 个；高级模式的 particles 为初始数量）。每约 32 次模拟再提议 4 个新世界，最多累计 1024 个候选；达到上限后继续搜索已有世界。补充节奏不依赖哪个世界的收益更高。定时搜索会根据实际采样及评分开销延长间隔，目标让增量采样开销约占 20%，避免慢信念模型挤掉大部分搜索。固定模拟次数训练不按墙钟调节频率，保持给定种子下的补充节奏可复现。

所有新世界都从搜索开始时冻结的根信息集重新确定化，不从模拟中的未来局面生成。普通路径使用同一原生采样器和弱规则权重；特殊私有选牌、法师已见手牌、灯塔和响应等约束仍由原生确定化器固定。新世界须与根合法动作逐项对齐，否则不进入池。

物理搜索树与各玩家可见历史对应的共享信息集统计始终保留。顺序和批量 MCTS 都支持动态根来源；不会把新世界作为互不相干的整次搜索，也不会清空旧访问量。

世界合并按完整原生快照识别，排除未来随机流；抽取世界后重新采样未来 RNG，避免反复利用某条幸运随机流。其他隐藏区域、顺序及 UID 保留在身份中，避免错误合并会产生不同合法行动的状态。

## 权重

普通采样保留未归一化的原生权重。启用学习信念时，冻结当前模型、真实可见观察及其历史；初始和后续候选都使用同一评分器返回 `log p - log q`。不再先把候选重采样成 4 个等权世界。C++ 通过 `root_candidates` 中间消息请求 Python 评分，评分不调用正在搜索的 worker，避免锁与 IPC 重入。

各批日志权重在同一个尺度上累积，再对整个候选池统一归一化；不能把各批分别归一化后相加。对第 i 个提议，混合权重为 `(1-mix) * exp(logw_i) / sum(exp(logw)) + mix / N`。合并重复世界时累计提议次数和重要性质量，保留其概率，不对唯一世界重新等分。ESS 按提议权重计算，唯一世界数另报。

若后续信念评分失败，保留原有合法世界并停止补充，记录错误，不混入另一种信念分布；IPC 会先得到错误回复，后续请求可继续使用同一进程。模型替换或停用不改变已经开始的搜索。尚未支持学习提议校正的私人响应阶段沿用原生采样。

## 时间和兼容

实战从初始采样前计时，扣除初始采样/评分后把剩余时间给 C++。worker 使用进入请求时的绝对截止时间，后续补充、评分、模型准备与 OOM 重试不重新获得完整预算。单次推理、IPC 评分、状态处理及析构不能硬中断，因此可能有小幅超时。若初始采样已耗尽预算，剩余值至少为 1ms，避免 0 被解释成无限时。

实战 `mcts.progressiveParticles=false` 可保留固定池对照；训练配置内部的 `mctsProgressiveParticles=false` 同理。直接策略对手不补充世界。底层 worker 协议默认关闭以兼容旧调用者；要求动态采样但 worker 未回报支持时，Python 明确报错而非静默用旧逻辑。原生构建器会因头文件变化重新编译。

诊断位于策略状态的 `mcts`：`determinizations`、`particleProposals`、`particleDuplicates`、`particleRefreshes`、`particleEss`、`particleSamplingMs`、`particleSamplingError`、`particleLimit` 和 `totalMs`。候选上限和时间节流是计算保护，不代表已覆盖全部隐藏分布；这一步不实现完整历史后验或新对手模型。

## 验证

`python -m unittest python_backend.test_root_particles python_backend.test_information_sets python_backend.test_batched_mcts python_backend.test_mcts_cycles python_backend.test_neural_selection python_backend.test_opponent_policy_protocol python_backend.test_mcts python_backend.test_belief`

新增原生反例：普通世界占 80%，冒险行动收益为 1；危险世界占 20%，冒险收益为 0；稳妥行动总是 0.85。初始四个世界全是普通情况时，固定池偏向冒险；补充世界后，应转向稳妥。覆盖顺序及 batch=1/8/32/128、访问量保留、候选上限、重复概率质量、跨批日志尺度、混合权重、ESS 和截止时间。

设置 `CITADELS_TEST_GAME_ENGINE` 后还会编译独立规则 worker，在 4/6/8 人真实局面验证增量采样、学习评分消息、失败后的下一次请求、合法动作和主局面非修改性。现有策略权重及信念 checkpoint 的实际 LibTorch 推理另有本地 smoke 验证。本次实现验证不等于已完成新旧战力对照。
