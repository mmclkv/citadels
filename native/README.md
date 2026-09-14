# Native MCTS core

这里是逐步迁移训练搜索的 C++ 核心。`mcts_core.hpp` 只负责通用 PUCT 搜索树，
不包含规则实现；规则通过 `GameAdapter<State, Action>` 接入，网络通过
`Evaluator<State, Action>` 接入。

迁移顺序：

1. 为 JS 引擎建立状态/动作序列化协议（`protocol.js`，NDJSON v1）；
2. 实现 C++ 规则适配器，并用相同回放逐动作比对 JS 结果；
3. 接入批量网络评估；
4. 将训练器的自对弈 worker 切换到 native MCTS。

当前文件不替换线上 JS 路径。完成规则适配和一致性测试后，才会启用 native
路径，避免训练数据因规则差异失真。
