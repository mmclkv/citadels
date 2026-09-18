# Native MCTS core

这里是逐步迁移训练搜索的 C++ 核心。`mcts_core.hpp` 只负责通用 PUCT 搜索树，
不包含规则实现；规则通过 `GameAdapter<State, Action>` 接入，网络通过
`Evaluator<State, Action>` 接入。

迁移顺序：

1. 为 JS 引擎建立状态/动作序列化协议（`protocol.js`，NDJSON v1）；
2. 建立动作回放校验链路（`replay_protocol.js`、`replay_verify.cpp`），并用强类型动作协议（`action_codec.hpp`）开始实现 C++ 规则适配器；
3. 先迁移并验证可复现随机源（`js_rng.hpp`），再按回放逐块迁移状态变更规则；
4. 用 `state_projection.js` / `state_codec.hpp` 固定搜索元状态，逐步接入 C++ 的状态变更实现；
5. 已迁移选角状态机（`draft_machine.hpp`），下一步接入牌池和角色合法性规则；
6. 已抽出行动阶段基础资源转移（`resource_machine.hpp`），下一步接入角色加成、牌库和建筑例外；
7. 已复刻基本建筑牌堆 UID 与种子洗牌（`district_deck.hpp`），下一步接入抽牌/弃牌堆回收；
8. 已接入抽牌与弃牌堆回收状态（`deck_machine.hpp`），下一步接入角色加成和建筑特殊抽牌规则；
9. 已接入资源规则参数（`resource_rules.hpp`）：商人、建筑师、天文台、图书馆及女巫接管回合；
10. 已迁移建造合法性基础规则（`build_rules.hpp`）：费用、建造限额、同名限制、采石场及生意人/航海家例外；
11. 已迁移建造后的城市状态更新（`city_machine.hpp`）：扣费、手牌/城市数量、建造次数、炼金术士退款基数和首次达标标记；
12. 已迁移回合结束基础逻辑（`turn_machine.hpp`）：炼金术士退款、已行动计数、行动队列推进和待决动作阻塞；
13. 已迁移刺客/盗贼/女巫的角色宣告校验（`declaration_rules.hpp`），下一步接入宣告效果结算；
14. 已迁移叫号阶段刺杀、盗贼和女巫效果结算（`effect_resolution.hpp`），下一步接入完整行动队列和回合接管；
15. 已迁移行动队列排序与效果接入（`call_queue.hpp`），支持刺杀跳过、盗贼结算和女巫接管标记；
16. 已迁移女巫接管回合初始化（`witch_machine.hpp`），继承被施咒角色并避免重复资源加成；
17. 已迁移魔术师手牌能力（`magician_machine.hpp`）：整手交换与将选牌放到牌库底后等量重抽；
18. 已迁移皇帝皇冠与资源转移（`emperor_machine.hpp`）：皇冠转移、最多 1 金币和可复现随机手牌转移；
19. 已迁移外交官建筑交换（`diplomat_machine.hpp`）：堡垒保护、同名限制、达标限制和差价转移；
20. 已迁移领主摧毁与元帅抢夺（`military_machine.hpp`）：费用、长城加价、住持保护、堡垒保护和金币转移；
21. 已迁移修士资源组合与夺金（`monk_machine.hpp`）：蓝色建筑组合校验、平手取前位和富者夺 1 金；
22. 已迁移学者选牌（`scholar_machine.hpp`）：抽 7 选 1，其余牌放回并重洗牌库；
23. 已迁移预言家手牌交换（`prophet_machine.hpp`）：从每位有手牌的对手随机取 1 张，再按队列归还；
24. 已迁移航海家额外奖励（`navigator_machine.hpp`）：额外 4 金或 4 张牌，且只能二选一领取；
3. 接入批量网络评估；
4. 将训练器的自对弈 worker 切换到 native MCTS。

当前文件不替换线上 JS 路径。完成规则适配和一致性测试后，才会启用 native
路径，避免训练数据因规则差异失真。

## 神经网络后端

native mcts_worker 的 GPU evaluator 有三种模式：

- `python-binary`：默认模式。C++ 通过长驻 `gpu_trainer.py`，使用带长度帧的
  float32 二进制批量协议，不再在每个 batch 上编码/解析 JSON。
- 共享内存模式：训练主循环启动一个独立的 `shared_inference_daemon.py`，多个
  `mcts_worker` 通过固定槽位的命名共享内存提交叶节点批量评估请求，由单一
  PyTorch/GPU 进程消费并返回策略/价值结果，避免每个搜索进程重复创建 GPU 上下文。
- `libtorch`：可选直连模式。C++ 直接加载项目 Python wheel 内的 LibTorch，绕过
  Python 进程和 IPC。该模式需要用 C++20、`CITADELS_LIBTORCH` 以及 torch 的
  include/lib 重新编译 `mcts_worker`；Node 侧配置
  `nativeInferenceBackend: 'libtorch'` 后启用。

后端不同 ⇒ 产物不同：没有链接 torch 的产物拿去跑 libtorch 请求会直接抛
「当前 mcts_worker 未编译 LibTorch 后端」。因此各后端编译到各自的产物上
（`mcts_worker.exe` / `mcts_worker_libtorch.exe`），互不覆盖；此外只要
`native/` 下有比产物更新的源文件，启动训练时会自动重新编译，避免长期复用
过期二进制。编译输出先落 `.tmp` 再改名，编译失败不会留下半截 exe。

两种模式都使用同一份 flat float32 权重文件，并保留 `modelVersion` 热加载逻辑。

价值头固定输出 8 个玩家槽位。slot 0 是当前行动者，后续槽位按座位顺序循环排列；
不足 8 人的槽位为无效 mask。mcts_worker 返回 `valueVector`，同时保留
`value = valueVector[0]` 供旧客户端兼容；GPU batch 协议也返回 8 个 float 的向量。

## JS/C++ 输入编码协议：状态 v6 / 动作 v6

`training/train.js` 与 `native/state_features.hpp` 共用版本化的 672 维实体槽位状态编码：
前 32 维是全局回合/阶段/待决动作字段，随后是从当前玩家视角开始的 8 个座位，
每个座位 80 维：基础玩家特征占 0–19，角色编号占 20–28，27 个角色的精确身份占 29–55，
最多 8 张城区建筑的实体槽位占 56–79。六个暗版角色（行政官、间谍、勒索者、法师、住持、
税务官）均有独立身份特征。对手手牌只使用公开的 `handCount`，精确角色只使用已经公开的角色，
因此**特征本身**不引入额外隐藏信息。注意这只是「编码不添料」，不等于搜索看不到隐藏信息：
worker 拿到的是一份完整游戏状态，里面写了谁的手牌、牌库顺序与未打出的角色，规则模拟就
按这些真牌推进 —— 见下一节。此版本同时消除了旧编码中角色身份、建筑槽位和费用统计之间的
索引重叠。动作编码为 256 维，前 43 个槽位编码动作类型（包含行政官/勒索者的选角目标子动作），
后续编码相对目标座位、角色编号/身份、模式、颜色、建筑属性、金币/手牌参数和稳定卡牌引用；
覆盖所有六个新增角色的专属行动，不再把任意字段哈希到特征桶中。`state_features_probe` 和
`action_features_probe` 用于逐元素跨语言回归检查。

## 搜索根的隐藏信息约定（确定化由调用方负责）

`mcts_worker` 无法分辨收到的状态是「真实局面」还是「猜测局面」——它照单全收。因此
隐藏信息的安全完全取决于调用方：**JS 侧每次搜索前都必须先把根局面确定化**，
即把对手手牌、牌库顺序、暗置移除、对手未打出的角色换成一份与公开信息一致的随机猜测，
再在猜测局面上重新枚举合法动作一并送进来。两个调用点分别是
`training/train.js`（`alignedDeterminization`，JS 与 native 两条分支共用）与
`lib/local-neural-bot.js`（实战神经网络电脑平均 4 份猜测）。
`test/train-search-blindness.test.js` 会逐个搜索调用比对「交进搜索的根 == 确定化产出的克隆」。

动作列表必须在**同一份**猜测局面上枚举：建造/法师/行政官等动作带实体 uid，用真局面的
列表配猜测局面的树会让 `mcts_worker.cpp` 的合法性比对失败，退化成均匀先验。

六个新增暗版角色已接入原生 MCTS 规则模拟：行政官逮捕令及建造响应、间谍调查/取牌、
勒索者威胁标记/赎回/揭示、法师查看/取牌/立即建造、住持的宗教建筑金币收入与8号角色保护，
主教的宗教建筑抽牌及代付建造差额（按金币交还手牌），
税务官建造收税与主动收取。选择 C++ MCTS 后，基本版、暗版和混合版对局均在原生搜索中推进这些效果；
JS 仍是外层正式对局状态的权威引擎，并按 C++ 搜索返回的动作推进。独立 `rulesEngine: cpp`
整局训练后端尚未打通，因此控制台仍禁用该选项，服务端也会拒绝该配置。

终局价值只由竞争排名决定：并列玩家共享同一名次，下一名跳过并列名次；绝对分数
与分差不进入奖励。JS 训练目标、JS MCTS 终局值、C++ MCTS/worker 终局值使用同一规则。
