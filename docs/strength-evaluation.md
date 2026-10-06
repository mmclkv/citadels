# 固定策略战力评测

使用真实 C++ 游戏引擎、确定化、MCTS 和 LibTorch 推理链路，不启动服务器、不训练网络、不替换线上权重。

```powershell
python python_backend/strength_eval.py --checkpoint training-data/checkpoint.json.gz --game-engine native/game_engine_worker.exe --mcts-worker native/mcts_worker_libtorch.exe --output arena.jsonl --selection both --players 4 5 6 7 8 --cycles 20 --simulations 500 --particles 4 --batch 32 --device cuda
```

请将示例路径替换为当前源码编译出的实际产物。可添加 `--baseline 旧权重.json.gz`，以相同开局、座位、搜索预算比较两份权重。程序冻结权重文件，并记录权重与可执行文件的 SHA256；输出文件必须不存在。

每个开局种子轮换所有座位，分别测试最大访问概率动作（argmax）和按访问分布采样（sample）。默认使用固定的静态困难启发式对手，关闭根节点噪声。`--opponent-search-ms 1000` 可改为困难启发式 MCTS 对手，但时间预算受机器负载影响，不保证严格重现。训练控制台的滚动第一率不是该固定评测的替代品。

报告分别列出完成、失败、所有尝试的第一率、完成局第一率与配对名次奖励差。超步数、超回合数、重复局面、空动作及引擎错误均记录为失败，不会悄悄从分母删除。少量局只适合流程检查，不能证明战力变化。

同一开局的不同座位具有相关性：配对区间按完整的“人数 × 独立种子”组估计，至少 30 组才显示近似区间。`promotionEligible` 仅为报告提示，要求完整计划无失败、至少 100 对且区间下界大于零；不会自动更换任何模型。区间并非跨全部对手分布的战力保证。完成局第一率的 Wilson 区间仅是描述性参考，不消除座位相关性与失败偏差。

实战默认仍按访问分布采样；这一工具不改变实战或训练默认参数。新动作编码为 v10，旧 v9 权重仍按 v9 推理，续训时才迁移到 v10。
