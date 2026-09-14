# Native MCTS core

这里是逐步迁移训练搜索的 C++ 核心。`mcts_core.hpp` 只负责通用 PUCT 搜索树，
不包含规则实现；规则通过 `GameAdapter<State, Action>` 接入，网络通过
`Evaluator<State, Action>` 接入。

迁移顺序：

1. 为 JS 引擎建立状态/动作序列化协议（`protocol.js`，NDJSON v1）；
2. 建立动作回放校验链路（`replay_protocol.js`、`replay_verify.cpp`），并用强类型动作协议（`action_codec.hpp`）开始实现 C++ 规则适配器；
3. 先迁移并验证可复现随机源（`js_rng.hpp`），再按回放逐块迁移状态变更规则；
4. 用 `state_projection.js` / `state_codec.hpp` 固定搜索元状态，逐步接入 C++ 的状态变更实现；
3. 接入批量网络评估；
4. 将训练器的自对弈 worker 切换到 native MCTS。

当前文件不替换线上 JS 路径。完成规则适配和一致性测试后，才会启用 native
路径，避免训练数据因规则差异失真。
