# Python 服务与训练编排

Python 提供 HTTP/WebSocket、房间协议、Agent/语音/FRP 集成及训练调度。`native/game_engine-<源码指纹>.exe` 是独立、有状态的 C++ 游戏主进程，按 gameId 持有权威局面并负责创建对局、合法行动、NPC 选择及动作推进；`native/mcts_worker_libtorch-<源码指纹>.exe` 只接收策略搜索/隐藏信息确定化请求并返回策略，不维护实时房间状态，也不再运行整局自对弈。浏览器 UI 使用 JavaScript，服务端无需 Node.js。

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
- Python 服务端启动时分别检查并构建带源码指纹的游戏引擎与搜索 worker。游戏引擎仅依赖 C++/clang++；搜索 worker 另外依赖 LibTorch。新版本使用并行的新文件名，运行中的旧进程不会阻止更新；服务退出时关闭本次启动的两个进程。需安装 clang++、Visual Studio C++ Build Tools（提供 `VsDevCmd.bat`/`link.exe`）以及项目虚拟环境内的 PyTorch LibTorch。
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
