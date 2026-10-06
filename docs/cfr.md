# CFR 初版

本版是无神经网络的表格型 outcome-sampling MCCFR。Python 仅编译/启动进程和显示日志；规则、信息集、遗憾更新和平均策略均在 C++。不需要 PyTorch 或 LibTorch。

## 训练

从仓库根目录执行（Windows 可将 `python` 换成 `.\.python\python.exe`）：

```sh
python python_backend/train_cfr.py --iterations 1000 --min-players 4 --max-players 8 --characters random --save-every 10 --output training-data/cfr/current.jsonl
```

续训，`iterations` 表示追加迭代数：

```sh
python python_backend/train_cfr.py --resume training-data/cfr/current.jsonl --iterations 1000 --output training-data/cfr/current.jsonl
```

每次迭代轮换一个人数，分别为每个座位采样一局并更新该座位。迭代不是游戏局数；4–8 人完整轮换五次迭代会采样 30 局。探索率默认 0.6，仅用于更新玩家的训练采样，实战不额外探索。

日志展示累计迭代、真正终局的采样数、信息集数、因步数保护被丢弃的轨迹。只有终局轨迹更新遗憾与平均策略。策略以临时文件加原子替换保存，恢复时保留全部累计值；相同配置与种子下，中断后续训等价于连续运行。

命令行会锁定输出文件，避免两个任务覆盖同一存档。正常退出和 Ctrl+C 会移除锁；机器断电留下的 `.lock` 文件需确认旧任务已退出后再删除。

初版单进程，不支持神经网络控制台启动 MCCFR。网页训练控制台仍训练原来的 Entity Transformer；混合阵容中的非网络对手现在是 CFR。独立 MCCFR 训练使用上述命令行。

## 真实对局

Linux：

```sh
export CITADELS_CFR_POLICY="$PWD/training-data/cfr/current.jsonl"
python python_backend/run.py 8787 --host 0.0.0.0 --skip-neural-policy
```

Windows PowerShell：

```powershell
$env:CITADELS_CFR_POLICY=(Resolve-Path training-data/cfr/current.jsonl).Path
.\.python\python.exe python_backend/run.py 8787 --host 0.0.0.0 --skip-neural-policy
```

若也需要策略神经网络玩家，移除 `--skip-neural-policy`。FRP 配置仍使用现有环境变量。

启动器用 clang++ 编译独立 `cfr_worker` 和游戏主进程。主进程通过直接双向管道请求策略；仅发送可见信息集与规范化合法动作，不发送完整真实状态。每个主进程共享一个只读策略子进程，退出时回收它。

房间只提供一个“CFR 电脑”。旧 `npc/easy/normal/hard` 配置统一迁移，旧启发式 MCTS 参数不再生效。CFR 不读取神经网络权重文件；其文件格式是独立的 JSONL。

**没有配置权重或未命中信息集时，均匀选择语义合法动作。**启动日志、房间提示和原生响应的 `cfr.hit/configured/fallback` 明确报告这一点，没有隐式启发式回退。不能把新建的均匀策略当成已经训练出强度的电脑。

## 正确性边界

- 使用完整观察/自己行动历史的 SHA-256 链及当前可见局面；不截断历史，不使用 MCTS 的确定化状态或神经网络特征。
- 只记录自己的手牌、公开信息及规则允许查看的私有信息。法师与间谍看到的手牌在效果结束后仍能区分信息集；其他玩家不能读取该观察。真假逮捕令/勒索标记与排列顺序被遮蔽。
- 卡牌 UID、玩家 ID 和按钮顺序不进入策略身份；物理等价副本合并，落地时在副本间均匀映射。合法动作支持不一致会报错，不静默取交集。
- 随机性的定义是均匀采样的初始 uint32 引擎种子。此后规则随机结果由该种子与行动序列确定；不会用启发式信念重采样代替真实机会分布。固定机会概率在反事实比值中抵消，平均策略省略同一个常数尺度。
- 收益使用共享规则的终局名次收益，每个座位更新自己的收益，不按行动者翻转符号。并列名次不保证零和；多人城堡不具有两人零和 CFR 的均衡收敛保证。
- 遗憾与平均策略分开累计。长对局的重要性权重使用有符号对数与独立累计尺度，不裁剪权重，也不把策略改成最后一轮遗憾匹配策略。
- 检查点包含规则/卡牌/编码内容契约。不同平台相同源码可迁移；规则或编码变更会拒绝旧文件。已运行的策略进程读取的是启动时快照，训练写新文件不会自动改变实战策略。

初版优先验证完整记忆的正确性，**尚无局面抽象、在线重求解、并行更新或模型近似**。城堡的信息集规模很大，表格覆盖可能很低；不能承诺只训练若干千局就超过旧困难电脑。应先统计命中率并做固定对手、平衡座位的分人数评测，再决定抽象方案。

现有 `npc_policy.hpp` 仍供神经网络 MCTS 内部模拟和旧策略离线参考使用；真实房间与采样主进程已不调用它。没有将神经网络 MCTS 的内部对手近似策略冒充 CFR。

## 验证

```sh
clang++ -std=c++20 -O2 native/cfr_probe.cpp -o native/cfr_probe
./native/cfr_probe
```

涵盖已知 SHA-256 向量、信息隔离、旧 UID/按钮顺序不变性、语义动作合并、重要性修正的期望值、平均策略、检查点兼容性、超大权重以及 Kuhn Poker 的精确最佳响应可利用度。

原生集成测试：设置 `CITADELS_TEST_CFR_WORKER` 和 `CITADELS_TEST_GAME_ENGINE` 为已编译程序的绝对路径，运行 `python -m unittest python_backend.test_cfr -v`。嵌入式 Python 的模块路径受限时，可通过测试启动脚本显式加入仓库根目录。
