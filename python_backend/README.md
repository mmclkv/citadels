# Python 服务与训练编排

## Windows 编译器自动选择

启用策略神经网络时，启动器会检查 clang++ 的目标 ABI：如果 PATH 中先找到的是 LLVM-MinGW，继续查找 PATH、常见 LLVM 安装目录及 Visual Studio 附带的 MSVC clang++，不会因此要求关闭神经网络。仍需安装 Visual Studio C++ Build Tools（包含 Windows SDK）。`--skip-neural-policy` 模式允许继续使用 MinGW，且不加载 PyTorch。

显式设置 `CITADELS_CLANGXX` 时尊重该选择，不会悄悄覆盖；若指定了不兼容的 MinGW，会给出明确错误。可按实际安装位置指定：

```powershell
$env:CITADELS_CLANGXX = 'C:\Program Files\LLVM\bin\clang++.exe'
python python_backend/run.py 8787 --host 0.0.0.0
```

该选择不改变 FRP 环境变量。请使用已安装 PyTorch 的 Python 环境；Windows 不要求命令必须叫 `python3`。

Python 提供 HTTP/WebSocket、房间协议、Agent/语音/FRP 集成及训练调度。`native/game_engine-<源码指纹>`（Windows 为 `.exe`）是独立、有状态的 C++ 游戏主进程，按 gameId 持有权威局面并负责创建对局、合法行动、NPC 选择及动作推进；`native/mcts_worker_libtorch-<源码指纹>`（Windows 为 `.exe`）只接收策略搜索/隐藏信息确定化请求并返回策略，不维护实时房间状态，也不再运行整局自对弈。浏览器 UI 使用 JavaScript，服务端无需 Node.js。

当前已迁移：

- C++ worker 启动/监督、按源代码与 LibTorch 版本自动检查并重编译、JSON-line 请求桥接；实时房间开局、合法行动、状态转移与计分全部通过同一 C++ 引擎。
- 房间创建/加入/恢复身份的数据层；恢复令牌不会出现在公开房间视图中。活动对局中同名重连、断线/离开座位状态及玩家真人/托管标记已迁移。
- 普通 NPC 的 C++ 启发式决策；Python 只负责异步驱动房间，NPC 从 C++ 规则引擎生成的合法行动中选择，断线/离开的座位可由此接管。
- Entity Transformer v6 的状态/动作特征、隐藏信息粒子及信念权重均由 C++ 实现；训练与实战前向分别使用 PyTorch 和 C++ LibTorch，并在训练启动时校验输出一致。实时状态由 game_engine 进程持有；MCTS 使用共享规则实现对搜索树中的未来局面进行模拟。
- OpenAI-compatible Agent：从服务器环境读取外部模型配置，或自动复用已安装/登录的本机 Codex CLI；Codex 网关仅监听 loopback 来源、过滤 CLI 子进程环境变量、使用只读沙箱和 schema 输出约束。Agent 只接收当前玩家净化视图与 C++ worker 枚举的合法行动，并支持超时、错误隔离、房主重试或切回普通 NPC。
- LiveKit 语音状态与 JWT 签发：仅凭恢复令牌验证真人座位；honors 房间语音开关、跨域预检和每 IP 限流；密钥只参与服务器端 HS256 签名。
- 可选 FRP 隧道生命周期：默认关闭；显式启用后支持 TOML 生成/外部配置、HTTP(S)/TCP 校验、frpc 子进程日志、状态查询及退出时清理仅由本进程生成的临时配置。
- 训练存档只读/导入 API：列出现有 checkpoint、读取训练配置与编码兼容性、从 loopback 上传并验证 `.json.gz` checkpoint。
- 训练控制台 start/stop/status 由 Python 调度，PyTorch 在 Python 中执行梯度更新。采样进程逐步请求 game_engine 推进局面；网络行动另行请求 MCTS worker，NPC、合法行动和动作执行留在游戏引擎进程。神经网络决策状态提供策略与价值监督，启发式 NPC 决策状态补充终局价值监督。训练只支持 Entity Transformer v6；checkpoint 使用压缩权重与 optimizer sidecar，可续训。PPO 裁剪目标与优势估计已删除。`workers` 使用 Windows spawn 多进程并行采样，每个采样进程持有自己的游戏引擎和搜索进程。
- Python 服务端启动时分别检查并构建带源码指纹的游戏引擎与搜索 worker。Linux 直接使用 clang++ 和当前 Python PyTorch 安装附带的 LibTorch 头文件/动态库，并自动匹配 PyTorch 的 C++ ABI；Windows 使用 clang++ 与 Visual Studio C++ Build Tools（`VsDevCmd.bat`/`link.exe`）。新版本使用并行的新文件名，运行中的旧进程不会阻止更新；服务退出时关闭本次启动的两个进程。两平台均需安装 clang++ 和 PyTorch；CUDA 版 Linux PyTorch wheel 可用于 LibTorch GPU 推理，CPU wheel 则使用 CPU。
- 独立 CLI `python_backend/train.py [config.json]` 直接运行相同的 Python 训练管理器，流式显示日志并在 Ctrl+C/SIGTERM 时请求优雅停止；默认配置仍读取 `training/gpu-train-config.json`。
- 纯 Python 标准库 HTTP/WebSocket 服务：静态页面、训练/权重管理、房间与模型/Agent/语音状态接口，管理员 Basic Auth 控制台，以及浏览器大厅、建房、加入/恢复、配置、座位、开局、操作、重开、聊天和托管控制消息。

管理员凭据优先读取 `CITADELS_ADMIN_USERNAME` / `CITADELS_ADMIN_PASSWORD`，其次读取 `CITADELS_ADMIN_FILE` 或与 JS 服务器相同默认位置的 `server-admin.json`；文件不存在时会安全地用独占创建生成随机凭据。管理状态路由仅允许 loopback 或 HTTPS，并使用定时比较 Basic Auth 凭据。

Windows `start-server.bat` 与项目文档的默认启动方式均直接运行 Python，启动时会先启动或重编译 C++ worker；若 worker 不可用，实时游戏会明确失败，不会回退到另一套规则。浏览器 UI 仍使用 JavaScript。旧服务端/训练 JS 实现及 Python 后端中的规则、计分、确定化、编码和 MCTS 模块已移出运行包；`test/` 下的 Python reference 仅供回归夹具使用，不参与服务端运行。

启动 Python 服务（默认使用 `127.0.0.1:8788`；可由位置参数覆盖，也读取托管环境的 `PORT`，监听地址可用 `--host` / `CITADELS_HOST` / `HOST` 覆盖）：

```powershell
.\.python\python.exe python_backend\run.py 8788
```

默认只监听本机。局域网部署可显式传入 `--host 0.0.0.0`；公网部署仍应单独配置 TLS 反向代理、管理员凭据与防火墙。

Python 回归测试（项目私有 Python 在 Windows 上使用隔离路径，因此直接执行测试脚本）：

```powershell
.\.python\python.exe python_backend\test_roles.py
.\.python\python.exe python_backend\test_server.py
.\.python\python.exe python_backend\test_agent.py
.\.python\python.exe python_backend\test_voice.py
.\.python\python.exe python_backend\test_training_config.py
.\.python\python.exe python_backend\test_training_runtime.py
```

测试验证 C++ worker 接口调用、NPC/Agent 边界、训练运行时、服务端路由与真实 HTTP/WebSocket 传输行为；`test/` 下保留的 Python reference 只用于构造测试状态。

## 历史策略对手池

主训练默认使用 `selfPlayMode=random-batch`。每个批次开始时，在配置的人数范围内随机确定本批人数，再均匀抽取当前模型≥1、历史模型≥0、启发式≥0且总和等于本批人数的整数阵容。没有历史版本或历史池被关闭时，将抽到的历史数量转为当前模型数量。同一批各局保持人数与三类数量一致，轮换并打乱席位，具体历史版本逐局独立抽取；下一批重新抽取人数和阵容。随机种子和批次首局编号决定结果，与并行进程数无关。主进程将阵容随任务发给 spawn 子进程，不由各进程自行重抽。控制台与日志显示本批的实际数量，训练历史也保存批次阵容。

全网络、网络加启发式、课程模式仍可显式选择，沿用以下旧模式的席位数量和概率规则。随机批次模式不使用 `networkPlayerCount`、课程递增设置或非零的 `historicalOpponentProbability` 来决定数量；历史比例设为 0 仍可停用历史对手。独立弱点发现阶段保留其冻结目标及成对验证安排，不受主批次随机阵容影响。阵容回归检查：`python python_backend/test_batch_composition.py`。

历史池默认启用 `historicalPoolSize=8`、`historicalOpponentProbability=0.5`。在旧阵容模式中，每局保留一个轮换的当前模型席位；其他网络席位独立按该概率从历史池均匀抽取版本，整局固定。全网络、混合和课程阵容决定网络席位总数；只有一个网络席位时，历史池不替换它。无可用历史版本时全部使用当前模型。容量或概率设为 0 可以关闭。

启动时从训练数据目录的 `checkpoint-*.json.gz` 恢复历史池，每次保存新 checkpoint 后在下一批采样前更新。优先选取约一半近期存档和一半跨较早历史均匀分布的存档；不兼容的选项会由其他版本补足。只接纳相同网络规模、有效权重、兼容状态/动作编码、明确声明 `win-first-v1` 的 entity-v6 存档；旧名次目标的存档可以作为续训起点，但不会进入历史对手池。不会自动读取其他目录的训练存档。

历史权重导出为本次训练专用的不可变临时快照，不随当前网络更新。采样进程在每局开始读取原子更新的清单，因此 Windows spawn 子进程也能看到新版本。只在批次结束后淘汰快照，不删除原有 checkpoint。重启根据存档重新选择池成员。

历史对手同样通过原有隐藏信息确定化与 C++ ISMCTS 决策，关闭根节点探索噪声，并按搜索分布（温度 1）选择动作。其决策不产生策略或价值训练样本；当前网络席位继续产生搜索策略监督与争第一价值监督，启发式席位继续提供价值样本。Replay buffer 保留此前当前网络产生的样本。`networkReward`、`networkWinRate`、`networkScore` 及按人数统计只计算本局当前网络席位，不把历史对手计入；控制台显示本局当前/历史网络人数和池成员数，状态的 `historicalCheckpoints` 列出本局历史版本。

此功能增加对手多样性，不保证胜率提升。搜索 worker 仍复用一个模型实例；不同版本交替行动时会重新加载权重，采样速度可能降低。每个决策内的模拟席位仍由该次调用的同一网络评估，这次改动没有实现搜索树内逐席位使用不同网络。

回归检查：`python python_backend/test_historical_policy_pool.py`，真实采样/续训检查：`python python_backend/test_historical_selfplay.py`。

## 自动寻找弱点的对手

默认每经过 `weaknessSearchEvery=2000` 局主训练对局，在批次边界暂停主模型更新，复制并冻结主模型，独立训练一个针对性对手。`weaknessTrainingGames=64` 控制其训练局数，`weaknessEvaluationPairs=32` 控制验证对数；总计最多额外进行 64 + 2×32 = 128 局。该流程串行执行，不计入主训练的对局数、胜率或 Replay buffer，完成后继续原有主训练。间隔设为 0、历史池容量设为 0 或历史对手比例设为 0 都会关闭该流程。课程训练只有一个网络席位时仍可发现对手，但要等主阵容增加网络席位后才抽取它们。

对手从主模型权重初始化，使用独立 Adam 优化器及直接策略采样，通过带裁剪的策略梯度（PPO）学习自己争第一的终局回报；价值监督沿用 `win-first-v1`，没有“只要主模型输就奖励”的目标。其训练对局包含一个冻结主模型席位；其他席位混合冻结主模型与现有历史池版本。覆盖配置中的人数范围，并随种子和对局序号轮换席位、初始皇冠和相对位置。隐藏信息仍经原有 C++ 确定化与可见状态编码处理。只有对手自己的动作产生训练样本；未完赛的样本丢弃。主模型权重、优化器和 Torch 随机状态保持隔离。

验证使用与训练不同的种子流。在每个相同初始局面、相同席位与背景对手的案例中，比较初始化版本与训练后的对手；全部演员关闭根节点探索噪声，使用相同 ISMCTS 预算和历史池所用的温度 1 动作采样。模型在验证期间不更新。所有计划中的成对对局都必须完赛；冻结主模型第一名率须下降，单侧精确成对符号检验 p≤0.05，且对手自身第一名率须提高，才接受候选。并列第一按第一名计，与已有训练统计一致。该门槛是单次发现的经验筛选，不构成跨多次尝试的统计保证，也不保证对人类胜率提高。

通过的候选保存为 `checkpoint-<主训练局数>-opponent-<种子>.json.gz`，带入池验证报告。历史池最多为这类对手预留约四分之一容量（至少一个），其余继续保留普通历史版本；未通过或被停止的候选不保存为池成员。完整报告另存于训练数据目录下的 `weakness-search/report-*.json`，包括成对结果、第一名率和 p 值。控制台显示当前阶段和验证结果。每次主 checkpoint 保存最新发现状态，续训按下一个间隔继续；池成员仍从已保存且通过验证的候选恢复。

此实现是有限预算的近似回应训练，未实现完整 PSRO 的元博弈求解或搜索树内多模型评估。新增发现阶段会延长训练耗时；主训练的策略蒸馏目标和训练阵容配置不变。回归检查：`python python_backend/test_weakness_search.py`，真实训练检查包含于 `test_historical_selfplay.py`。
