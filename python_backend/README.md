# Python 服务器与游戏引擎

Python 自己承载权威游戏引擎和整个服务器后端。浏览器 UI 使用 JavaScript，服务端无需 Node.js。

当前已迁移：

- 30 种建筑、27 种角色的静态目录，以及洗牌、构建牌堆、按人数与扩充模式选角色。
- 确定性的 32 位随机流；创建游戏、发初始手牌、开轮、2～8 人选角及叫号队列入口。
- 通用行动链：领资源、抽牌留牌、角色收入、普通建造、主教代偿建造、实验室／铁匠铺／博物馆、结束回合及轮末确认；刺客、盗贼、女巫接管、行政官逮捕令（含没收响应）、勒索者威胁与揭示、间谍、法师、魔术师、航海家、学者、修士、住持、税务官、皇帝、预言家、艺术家、领主、元帅与外交官的对应流程；领主摧毁后的墓地响应；计分与逐玩家隐私视图。
- 房间创建/加入/恢复身份的数据层；恢复令牌不会出现在公开房间视图中。活动对局中同名重连、断线/离开座位状态及玩家真人/托管标记已迁移。
- 普通 NPC 的 Python 启发式决策和异步驱动；开局时空座补为 NPC，选角与行动均从引擎合法行动中选择，断线/离开的座位可由此驱动接管。
- entity-v1～v5 状态与 action-v8 编码器，以及本地 PyTorch Transformer 推理；默认自动加载仓库发布的策略权重，也支持用 `CITADELS_NEURAL_CHECKPOINT` 覆盖 checkpoint，或用 `CITADELS_NEURAL_PROFILE` / `CITADELS_NEURAL_DEVICE` 配置，并接入 neural bot 座位。
- Python 不完美信息确定化：按视角重分配隐藏手牌、牌库/弃牌、博物馆牌和暗置角色，保留已知牌/公开量并重建未公开叫号队列。
- Python ISMCTS：策略网络座位可按 per-seat simulations/depth/particles 搜索；根粒子先做合法行动集一致性过滤，再按公开观测 belief 加权重采样，共享信息集 PUCT 树，按相对座位的 8 槽位价值反传并受节点上限约束。策略推理支持 TTA（城市、自己手牌、待选牌排列），变体数/超时可配置并记录实际耗时。训练侧可生成 MCTS 访问分布并以策略交叉熵蒸馏；目标覆盖不足时会停止训练。
- OpenAI-compatible Agent：从服务器环境读取外部模型配置，或自动复用已安装/登录的本机 Codex CLI；Codex 网关仅监听 loopback 来源、过滤 CLI 子进程环境变量、使用只读沙箱和 schema 输出约束。Agent 只接收当前玩家净化视图与经引擎试执行校验的候选行动，并支持超时、错误隔离、房主重试或切回普通 NPC。
- LiveKit 语音状态与 JWT 签发：仅凭恢复令牌验证真人座位；honors 房间语音开关、跨域预检和每 IP 限流；密钥只参与服务器端 HS256 签名。
- 可选 FRP 隧道生命周期：默认关闭；显式启用后支持 TOML 生成/外部配置、HTTP(S)/TCP 校验、frpc 子进程日志、状态查询及退出时清理仅由本进程生成的临时配置。
- 训练存档只读/导入 API：列出现有 checkpoint、读取训练配置与编码兼容性、从 loopback 上传并验证 `.json.gz` checkpoint。
- 训练控制台 start/stop/status 已接入 Python 自对弈 PPO 运行时，支持 entity-v5/flat、启发式混合阵容、MCTS 蒸馏、状态指标、压缩权重 checkpoint、optimizer sidecar 与续训。Python 是训练配置的权威归一化实现；旧 checkpoint 中的 JS/C++ 引擎、LibTorch evaluator 和 native worker 字段不会改变 Python 执行路径。`workers` 使用 Windows spawn 多进程和共享内存 CPU 推理模型并行采样，更新阶段串行执行。
- 独立 CLI `python_backend/train.py [config.json]` 直接运行相同的 Python 训练管理器，流式显示日志并在 Ctrl+C/SIGTERM 时请求优雅停止；默认配置仍读取 `training/gpu-train-config.json`。
- 纯 Python 标准库 HTTP/WebSocket 服务：静态页面、训练/权重管理、房间与模型/Agent/语音状态接口，管理员 Basic Auth 控制台，以及浏览器大厅、建房、加入/恢复、配置、座位、开局、操作、重开、聊天和托管控制消息。

管理员凭据优先读取 `CITADELS_ADMIN_USERNAME` / `CITADELS_ADMIN_PASSWORD`，其次读取 `CITADELS_ADMIN_FILE` 或与 JS 服务器相同默认位置的 `server-admin.json`；文件不存在时会安全地用独占创建生成随机凭据。管理状态路由仅允许 loopback 或 HTTPS，并使用定时比较 Basic Auth 凭据。

Windows `start-server.bat` 与项目文档的默认启动方式均直接运行 Python；游戏规则、NPC、策略推理、MCTS 与训练均由 Python 实现。浏览器 UI 仍使用 JavaScript，`src/cards.js` 作为卡牌预览页面的浏览器数据资源保留。旧服务端/训练 JS 实现与旧 native JS 协议层已删除；native C++ 源码是独立的历史实验代码，不由 Python 服务启动或调用。新增游戏动作、WebSocket 消息或 HTTP 路由时，应扩展 Python 引擎和服务端测试。

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

测试直接验证 Python 游戏规则、角色能力、训练运行时、服务端路由与真实 HTTP/WebSocket 传输行为。
