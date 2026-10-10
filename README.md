# 富饶之城 / 荣耀之城（Citadels）— 桌游客户端

基于 [冒險安迪 · 榮耀之城规则](https://andyventure.com/boardgame-citadels/) 与
[27 种角色能力介绍](https://andyventure.com/boardgame-citadels-characters/) 实现的完整桌游客户端。
支持 **单人模式** 与 **联机模式**。浏览器端 JavaScript 负责界面、动画与输入；Python 后端承载 HTTP/WebSocket 与训练编排，实时游戏规则、合法动作和状态转移统一由 C++ worker 执行。训练控制台和独立训练命令均使用 Python 启动器。

## 快速开始

`main` 是开发版；稳定版使用固定的 `vX.Y.Z` 附注标签和独立发布目录，后续 `main` 改动不会自动进入稳定版。
线上启动建议传入 `--require-stable`。发布、按版本部署和回滚步骤见 [版本管理说明](docs/releases.md)。

```bash
python python_backend/run.py 8787 --host 0.0.0.0  # Python HTTP + WebSocket + C++ 游戏 worker
python python_backend/run.py 9000 --host 0.0.0.0  # 指定端口
python python_backend/run.py 8787 --skip-neural-policy  # 跳过神经策略 worker，保留普通 NPC 和游戏规则
```

Windows 推荐双击 `start-server.bat`：它优先使用仓库内 `.python\python.exe`，不需要安装 Node.js。
也可以安装 Python 3.12 后使用上面的命令。服务端没有 Node.js 启动层或服务端副本；默认端口为 8788，示例显式传入 8787，以保持现有书签和防火墙规则。

启动后浏览器打开：

- 本机：`http://localhost:8787`
- 手机：首页和联机大厅沿用原页面；正式对局会自动进入基于 V12 霓虹原型的 `mobile.html`，刷新后继续当前房间。
- 局域网：`http://<你的内网IP>:8787`（启动时会在终端打印，同一 WiFi 下的朋友可直接用它联机；
  浏览器只在 HTTPS 下开放麦克风，所以房间语音需要另外配 HTTPS，见「联机语音」）

服务端由 Python 标准库实现 HTTP 与 WebSocket；仓库自带运行时已包含训练/推理所需依赖。
唯一一个第三方浏览器包（LiveKit 客户端，约 580KB）已经放在 `public/vendor/` 里，
而且只在第一次点「语音」时才加载，单机玩家不会为它多花流量。

## 本地策略神经网络训练

启动服务器后访问 `http://localhost:8787/training.html`，也可以从主菜单进入“神经网络训练”。
训练由 Python 调度，独立 C++ `game_engine-<源码指纹>.exe` 持有并推进每局权威状态；C++/LibTorch `mcts_worker_libtorch-<源码指纹>.exe` 只处理策略搜索与网络前向。训练与真实对局共用这两条调用边界，PyTorch 在训练进程中负责梯度更新。当前电脑已配置项目私有 Python 3.12、PyTorch CUDA 12.6 和 GTX 1660 SUPER 加速环境。

- 支持开始、优雅停止与从 checkpoint 继续训练；停止时会保存当前模型。
- 策略价值网络使用行动者可见的信息；训练支持当前模型与冻结的历史版本混合对弈。Python 训练输入来自 C++ worker 返回的样本，实战视图脱敏只做协议映射，不重新执行规则。
- 开 MCTS 时的搜索由 C++ 按玩家可见信息生成确定化粒子、重建隐藏状态并枚举合法动作；训练与实战都使用配置的粒子数（默认 4），并可按公开事实给粒子加权。
- 使用合法动作枚举与动作掩码，策略只在通过引擎校验的行动中采样。
- 每次 Entity Transformer 训练启动时，Python 会把当前权重导出给 LibTorch worker，双方用相同输入比较策略 logits 与价值输出；超出容差会中止训练并报告最大误差。
- Python 训练调度器按 `workers` 配置并行自对弈；每局仅轮换的主模型训练席位跑完整 MCTS，其他当前模型和历史策略对手使用 LibTorch 直接策略推理，启发式对手保持原有方式。MCTS 策略教师样本只来自训练席位，启发式席位仍可提供纯价值样本；战力指标统计训练席位。低频弱点搜索保留独立的策略梯度训练与完整 MCTS 筛选评测。主进程用 PyTorch 串行执行更新。服务启动时分别检查并构建游戏引擎与搜索 worker，服务退出时清理两个进程。
- 使用 MCTS 访问分布交叉熵与终局价值损失；价值训练和 MCTS 终局回传统一采用争第一目标（90% 夺冠、10% 名次，第一名含并列为 1，非第一名在 -1 到 -0.8 之间）。新检查点记录 `valueObjective=win-first-v1`；旧检查点可以续训，但已有权重需要继续训练适应新目标，replay buffer 每次启动为空。控制台实时显示策略散度、梯度范数、显存、速度、推理延迟、分数和座位胜局，名次统计与 CFR 奖励仍保留历史名次定义。
- Entity Transformer 只支持 v6 架构；`fast`、`balanced`、`large` 三档控制网络规模。建议先用 `fast` 做短跑验证，再按速度选择档位。
- 训练过程的模型存档位于 `training-data/checkpoint-XXXXXX.json.gz`，该目录已加入 `.gitignore`。

也可以绕过网页控制台直接运行 Python 训练任务：

```powershell
.\.python\python.exe python_backend\train.py                         # 默认读取 training/gpu-train-config.json
.\.python\python.exe python_backend\train.py path\to\train-config.json
```

按 Ctrl+C 会请求优雅停止并保存 checkpoint。
- 仓库默认权重为 `models/policy-default.json.gz`：Entity Transformer v6 / fast，来自第 12,047 局训练存档，使用争第一优先的价值目标，保留完整参数精度。未设置 `CITADELS_NEURAL_CHECKPOINT` 时，策略神经网络自动加载此文件；设置该环境变量可使用其他兼容存档。来源、编码版本和 SHA256 记录在 `models/policy-default.meta.json`。部署文件不包含训练历史或 optimizer；`.optimizer.pt` 只用于 GPU 续训。
- Entity Transformer v6 使用 1790 维状态、256 维动作和 v14/v10 编码（兼容 v9 动作权重），扩展城市建筑槽位并编码建筑特殊状态、反应与待处理选择，同时用 UID 字节特征区分动作。旧版本架构不再加载或续训。
- 开局面板把电脑类型选成「策略神经网络」时，可以设置 MCTS 模拟次数与最大搜索深度，默认分别为 5000、2000，并使用 4 份隐藏信息确定化样本。真实对局选择 MCTS 访问概率最大的合法动作，概率并列时选择合法动作列表中靠前的一项；训练仍保留探索采样。搜索基于隐藏信息的随机猜测，不使用对手真实隐藏信息。
- GPU optimizer 状态保存在同编号的 `.optimizer.pt` 文件中；旧 JavaScript checkpoint 可以直接迁移到 GPU 训练。

训练控制接口只允许服务器本机调用：

```text
GET  /api/training/status
GET  /api/training/checkpoint?name=<存档文件名>
POST /api/training/start
POST /api/training/stop
```

控制台的「从存档读取参数」按钮会调用 `GET /api/training/checkpoint`，把所选存档里保存的那份
训练配置（目标局数、网络规模、MCTS、阵容与课程等 30 余项）一键填回面板——换电脑或隔了
几天想按同一套超参数续训时，不必再凭记忆手抄。它只读配置、不改动所选存档，也不下发模型权重。

建议先进行 100～500 局短跑，确认平均整局耗时和损失变化正常，再启动 10,000 局正式训练。
浏览器页面可以关闭，后台训练不会停止；重新打开控制台即可继续查看进度。

## 用手机玩

### 通过 FRP 暴露到公网

服务器支持可选的 FRP 客户端穿透。公网机器需要单独运行 `frps`，本机安装对应版本的
`frpc`；游戏服务器只负责把本机 `8787` 转发到已经配置好的 FRP 服务端。未设置
`CITADELS_FRP_ENABLED=1` 时不会启动 FRP，也不会改变现有局域网玩法。

HTTP 域名穿透示例（Windows PowerShell）：

```powershell
$env:CITADELS_FRP_ENABLED="1"
$env:CITADELS_FRPC_PATH="C:\\tools\\frp\\frpc.exe"
$env:CITADELS_FRP_SERVER_ADDR="公网服务器IP或域名"
$env:CITADELS_FRP_SERVER_PORT="7000"
$env:CITADELS_FRP_TOKEN="与frps一致的token"
$env:CITADELS_FRP_TYPE="http"
$env:CITADELS_FRP_DOMAIN="game.example.com"
python python_backend/run.py 8787 --host 0.0.0.0
```

Linux 使用同名环境变量即可。TCP 模式将 `CITADELS_FRP_TYPE` 设为 `tcp`，并额外设置
`CITADELS_FRP_REMOTE_PORT`；如果已经有完整的 FRP 配置文件，也可以只设置
`CITADELS_FRP_ENABLED=1` 和 `CITADELS_FRP_CONFIG=/path/to/frpc.toml`。FRP 的 token
只从环境变量或外部配置读取，不会写入仓库；生成的临时配置在服务器退出时删除。
启动日志和主页的「启动信息」会显示 frpc 的连接状态，但不会打印 token。

手机和电脑连**同一个 WiFi** 时，手机浏览器直接打开 `http://<电脑内网IP>:8787` 即可
（服务器启动时会在终端打印这个地址，也可以直接扫 `qr-code.png`）。

界面已做移动端适配：纵向布局、手牌与城市横向滑动、行动栏固定在底部、
需要选目标时（领主拆楼、外交官换楼、艺术家美化）目标建筑会高亮并带呼吸动画。
iPhone 底部安全区、横屏小高度设备也都处理了。

主菜单右上角或对局顶部的「主题」按钮可即时切换「经典羊皮纸」与「暗夜赛博霓虹-女性力量」；
选择会保存在浏览器本地，刷新页面或进入联机房间不会影响对局状态。主题只改变客户端视觉，
不会同步给服务器，因此联机玩家可以各自选择界面风格。

卡牌支持高清大图查看：在「角色一览」或「建筑一览」中点击「查看高清大图」；
游戏内卡牌先悬浮查看预览，再点击预览窗中的「查看高清大图」；预览框会拦截自身覆盖区域，不会激活下面的卡牌，鼠标离开卡牌后还会保留 1 秒，方便移入并点击按钮。查看器支持按钮、滚轮或双指缩放，放大后可鼠标/单指拖动画面查看细节；也支持 `+`、`-`、`0` 快捷键、Esc、关闭按钮和点击背景退出。

**手机打不开？** 九成是 Windows 防火墙拦了入站连接，两种解法：

1. 双击 `start-server.bat` — 自动提权放行 8787 端口并启动服务器（推荐）
2. 用**管理员身份**打开 PowerShell 执行：
   ```powershell
   netsh advfirewall firewall add rule name="Citadels Board Game Server" dir=in action=allow protocol=TCP localport=8787
   ```

说明：手机在联机模式里就是一个普通真人座位，和电脑上的人操作完全一样；
想在手机上自己单机玩，直接选单人模式即可，那部分不需要网络。

## 两种玩法

### 单人模式
主菜单 →「单人模式」→ 设置人数（2–8）、电脑难度、结束条件（8 栋 / 7 栋快节奏）、角色组 → 开始。

### 联机模式
主菜单 →「联机模式」→ 创建房间（可设置电脑补位）或输入 4 位房号加入 → 房主点「开始游戏」。

已经开局的房间可以在房间列表点击「观战」，或输入房号后点击「加入」或「观战已开始的房间」。普通加入统一进入观战，即使昵称与已有玩家相同也不会获得其席位；只有经过恢复令牌验证才能恢复玩家身份。电脑端和手机端均可通过「观战视角」下拉框或玩家视角按钮自由切换任意玩家（含电脑），查看该玩家的手牌、角色和可见局面。手机的视角选择器固定在棋盘上方，玩家详情中也可点击「切换到该玩家的视角」。观众不占用玩家座位，不能执行游戏操作；刷新或断线重连会恢复观战身份和所选视角。

服务器每 30 秒检查房间的实际在线玩家和观众。无人在线时保留 3 分钟供重连，超过宽限期自动删除；所有真人明确离开且没有观众等待重连时立即删除。等待开局、进行中和已结束的房间均适用，电脑托管不会延长空房间的保留时间。清理同时取消电脑及断线托管任务、释放 C++ 对局状态；查询房间列表也会触发检查。

- 空缺座位可一键设为电脑；房主可随时调整人数 / 结束条件 / 角色组。
- 玩家中途断线会自动由电脑托管，不会卡住牌局。

### 联机语音（实时通话）

房间里的真人座位可以开麦说话，电脑座位不参与。音频是浏览器之间的 WebRTC 流，
经 **LiveKit**（自建或 LiveKit Cloud）转发，不经过游戏服务器：游戏服务器只负责
给本房间的真人签发一枚短期访问令牌。

**需要 HTTPS。** 浏览器只在安全上下文里提供麦克风（`navigator.mediaDevices`），
所以 `http://192.168.x.x:8787` 这种局域网地址上语音是关着的 —— 页面检测到之后
会直接提示「请用 HTTPS 打开」，不会让用户对着英文报错发愣。`http://127.0.0.1:8787`
和 `http://localhost:8787` 属于安全上下文，本机自测可以直接用。

服务器没配 LiveKit 时，界面里不会出现任何语音入口（连「语音」开关都不显示）。配置只放在
**运行游戏服务器的机器上**，改完重启服务器：

| 环境变量 | 用途 |
|---|---|
| `LIVEKIT_URL` | LiveKit 服务地址，`wss://xxx.livekit.cloud` 或自建 `wss://voice.example.com` |
| `LIVEKIT_API_KEY` | LiveKit 的 API Key |
| `LIVEKIT_API_SECRET` | LiveKit 的 API Secret，**只留在服务器端**，不下发给浏览器 |
| `LIVEKIT_TOKEN_TTL` | 令牌有效期秒数，默认 21600（6 小时），允许 60–86400 |

配置好之后，创建房间的表单和房间内的配置行都会多出一个「语音」开关（默认开）。
房主在大厅里可以随时关掉（开局后大厅收起，要改得等下一局）；关掉后服务器会立刻拒绝
为这个房间签发新令牌，已经连上的人还能把当前这句说完。

**准备一台 LiveKit 服务器**，两条路：

- **LiveKit Cloud**：建一个项目，把项目里的 `wss://` 地址和一对 Key/Secret 填进上面三个变量。
- **自建**：从 [LiveKit Releases](https://github.com/livekit/livekit/releases) 下载
  `livekit-server` 二进制，写一份带 `keys:` 的配置文件后启动。快速自测可以直接用
  dev 模式（固定 `devkey`/`secret`，仅适合本机验证）：
  ```bash
  livekit-server --dev --bind 127.0.0.1     # 对应 LIVEKIT_URL=ws://127.0.0.1:7880
  ```
  对外提供服务时务必换成正式 Key/Secret，并让 LiveKit 走 TLS —— 页面在 HTTPS 下
  只能连 `wss://`，混合内容会被浏览器拦掉。

**自建 LiveKit 放在 nginx 后面**时，除了 WebSocket 升级，还要把 LiveKit 的
`/rtc`（信令）和 `/twirp`（服务端 API）都转发过去，缺一个就连不上：

```nginx
location /rtc {
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
}
location /twirp {
    proxy_pass http://127.0.0.1:7880;
    proxy_set_header Host $host;
}
```

**用法**：进入对局后点顶栏的「语音」（PC 上是右下角 ☰ 菜单里的语音按钮）加入，
也可以再点一次退到静音。连上之后侧栏会自动切到语音页签，里面有每个人的音量滑杆、
静音和「退出语音」。谁在说话，玩家面板和语音列表上会同时亮起，用的是 LiveKit
服务端的语音活动检测，不依赖客户端猜。麦克风权限被拒时不会把人踢出语音，只退回
「麦克风不可用，当前只能听到别人说话」的收听状态；浏览器拦截自动播放时，面板里会出现
「点击开启声音」的按钮。

**权限边界**：令牌接口 `/api/voice/token` 必须带上该座位的 `resumeToken` 才签发，
未入座、电脑座位、房主关掉房间语音的情况一律拒绝；令牌只能进本房间（房间名是
`citadels-<房号>`），并且按 IP 限流（每分钟 30 次）。`/api/voice/status` 只报告
「是否已配置」和缺哪一项，不返回服务器地址和密钥。

验证（不需要真实麦克风：用系统 Edge + 合成音源，并起一个本地 LiveKit dev 服务器）：

```bash
node --test test/voice.test.js        # 令牌签发、鉴权、限流、前后端接线
node test/voice-e2e.js                # 真实浏览器 + 真实 LiveKit 服务器的端到端
# 需要 playwright-core 与 livekit-server；BROWSER_CHANNEL=msedge 可指定浏览器
```

### AI Agent 电脑（大模型决策）

普通电脑使用浏览器或服务器内的启发式规则。AI Agent 则由游戏服务器向模型发送
该玩家可见的局面、角色说明及合法动作，模型选择一个动作，服务器校验并执行，
再把更新后的局面交给模型继续决策。每个选角、资源选择、建筑和能力操作都经过
模型请求；游戏速度设置控制动作之间的间隔，不会跳过模型等待。

旧版 `f64238e` 的 Agent 只是启发式规则包装，不调用模型；本实现替换了该行为。

**默认无需配置模型 API。** 运行 Python 服务或双击 `start-server.bat` 时，服务器会
检测本机 `codex` 命令，并通过一个内置的 loopback-only HTTP 网关调用当前 Windows
用户已经登录的 Codex。该网关的兼容接口是
`POST http://127.0.0.1:8787/api/codex/v1/chat/completions`，仅允许本机请求，账户令牌
不会发给浏览器或局域网玩家。首次使用前需要在这台电脑上安装并登录 Codex；可用
`codex --version` 和 `codex login` 检查。

本机网关使用官方支持的 `codex exec` 非交互模式、只读沙盒、临时会话和 JSON Schema
结构化输出。游戏状态只通过 stdin 发送，Codex 子进程不会继承游戏服务器的模型密钥等
环境变量。每一步仍由游戏引擎校验，非法答案不会执行。

如需指定本机 Codex 的行为，可设置：

| 环境变量 | 用途 |
|---|---|
| `CITADELS_CODEX_COMMAND` | Codex CLI 可执行文件，默认 `codex` |
| `CITADELS_CODEX_MODEL` | 可选，指定 Codex 使用的模型；留空沿用 CLI 默认模型 |
| `CITADELS_CODEX_REASONING_EFFORT` | 推理强度，默认 `low` |
| `CITADELS_CODEX_TIMEOUT_MS` | 单次 Codex 运行超时，默认 120000 毫秒 |
| `CITADELS_DISABLE_LOCAL_CODEX` | 设为 `1` 可禁用内置本机网关 |

也可以继续使用外部模型服务。模型调用采用
[Chat Completions 接口](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)，
支持提供该接口与 JSON 输出的兼容服务。一旦设置下列任一模型连接参数，服务器会优先
使用外部服务而不是本机 Codex。配置只放在**运行游戏服务器的机器上**：

| 环境变量 | 用途 |
|---|---|
| `CITADELS_AGENT_BASE_URL` | 模型 API 基础地址（例如 `https://api.openai.com/v1`，默认也是此地址） |
| `CITADELS_AGENT_MODEL` | 服务商提供的模型名，必填 |
| `CITADELS_AGENT_API_KEY` | 模型 API 密钥；本机 loopback 模型服务可不填 |
| `CITADELS_AGENT_TIMEOUT_MS` | 单次请求超时，默认 30000 毫秒，允许 1000–120000 |

可以设置上述环境变量后运行 Python 服务。Python 启动器从进程环境读取配置；可在启动前通过
PowerShell `$env:变量名="值"` 设置本机专用配置。
`.env` 已被 Git 忽略；不要把真实密钥放进 `public/`、浏览器存储或 GitHub Pages。
修改模型配置后重启游戏服务器。GitHub Pages 仍然只负责静态前端；本机 Codex 网关
必须随游戏服务器运行，不能部署到 GitHub Pages。

使用方式：

- 单人设置或联机创建房间时选择「AI Agent 电脑」。单人 Agent 对局也运行在服务器，
  可沿用联机的刷新重连机制；普通电脑的单人模式仍可离线使用。
- 房间内，房主可以逐个切换电脑类型，混合普通电脑和 Agent。
- GitHub Pages 仅托管前端。在设置中的「游戏服务器地址」填入已部署的 HTTPS 游戏服务器
  地址（不是模型 API 地址），游戏服务器负责保管密钥并调用模型。留空使用当前站点。
- `/api/agent/status` 仅报告是否配置及模型名，不返回密钥。配置存在不等于模型可达，
  首次决策会验证实际连接。
- 界面显示「正在请求模型决策」。超时、HTTP 错误或非法模型输出会暂停，房主可以
  「重试模型」或明确选择「改用普通电脑」，不会偷偷退回启发式策略。
- 模型思考期间若对局重开、关闭或状态变化，旧答案会被取消或丢弃。

验证（均使用本地模拟模型，无付费 API 请求；验证协议和行为，不代表真实模型棋力）：

```bash
.python\python.exe python_backend\test_agent.py
.python\python.exe python_backend\test_server.py
# 已安装 Playwright + Chromium 时，可选运行真实浏览器验证：
node test/agent-browser.js
# 使用系统 Edge 时设置 BROWSER_CHANNEL=msedge
```

## 已实现的规则

### 卡牌
- **建筑牌 68 张**：皇家（黄）12、宗教（蓝）11、商业（绿）20、军事（红）11、独特（紫）14。
- **紫色独特建筑全部可用**：图书馆、天文台、铁匠铺、实验室、魔法学院、鬼城、墓地、长城、堡垒、巨龙门、大学、博物馆、采石场。

### 角色 21 个（含基本版 + 黑暗城市 + 加强版）
| 编号 | 可选角色 |
|---|---|
| 1 | 刺客、女巫 |
| 2 | 盗贼 |
| 3 | 魔术师、预言家 |
| 4 | 国王、皇帝、贵族 |
| 5 | 主教、修士 |
| 6 | 商人、炼金术士、生意人 |
| 7 | 建筑师、航海家、学者 |
| 8 | 领主、外交官、元帅 |
| 9 | 皇后、艺术家 |

角色组选项：`基本版`（8 个）／`黑暗城市扩充`（9 个）／`加强版混合`（每号随机）。

### 流程
1. **移除角色牌**：按人数明置 / 暗置移除（4 号角色不会被明置移除）。
2. **选角**：2 人 / 3 人局每人持有 2 张角色牌（含「选 1 弃 1」的埋牌机制）；4–8 人局依次传递选牌，末位从剩余 2 张中选 1；7–8 人局末位可查看暗置牌。
3. **叫号行动**：按编号顺序行动，被刺杀者跳过、被施咒者只能领资源（随后女巫接管）。
4. **回合内**：领取资源（2 金 或 抽 2 留 1）→ 使用角色能力 → 建造（通常 1 栋）。
5. **结束计分**：建筑费用总和 + 五色齐全 3 分 + 率先达标 4 分（其余达标者 2 分）+ 特殊建筑加分。

## 目录结构

```
citadels/
├── python_backend/    # Python HTTP + WebSocket 服务、训练编排与联机房间；NPC 策略在 C++ worker
├── src/
│   ├── cards.js       # 浏览器牌面元数据；Python 权威数据在 python_backend/cards.py
├── training/          # Python 模型、编码器、MCTS 与训练器
├── public/
│   ├── index.html     # 主菜单 / 设置 / 大厅 / 对局 / 结算
│   ├── style.css      # 羊皮纸中世纪风格（浅色）
│   ├── app.js         # 客户端逻辑，本地与联机共用同一套 UI
│   ├── vendor/        # 第三方 UMD 包（LiveKit 客户端，首次用语音时才加载）
│   ├── themes/        # 主题管理器、资源 manifest 与 neon CSS
│   └── assets/themes/neon/cards/
│       ├── roles/{thumb,full}/      # 21 张角色卡的两级 WebP
│       └── districts/{thumb,full}/  # 30 种建筑卡的两级 WebP
└── test/
    ├── simulate.js    # 引擎冒烟：2–8 人 × 3 角色组全量对局
    ├── net.js         # 联机链路：建房 / 加入 / 开局 / 完整对局
    ├── voice.test.js  # 联机语音：令牌签发 / 鉴权 / 限流 / 前后端接线
    ├── voice-e2e.js   # 联机语音：真实浏览器 + 真实 LiveKit 服务器
    ├── dom-smoke.js   # 客户端 UI：极简 DOM 桩驱动整局渲染
    └── theme-assets.js # neon 主题卡图 manifest 与文件完整性
```

## 测试

```bash
node test/simulate.js          # 22 组配置 × 3 局，检查不卡死、计分自洽
node test/dom-smoke.js 5 mixed 8   # 客户端渲染整局（参数：人数 角色组 结束栋数）
node test/theme-assets.js      # 检查 21 角色 / 30 建筑的 full/thumb 资源
node test/net.js 8787          # 需先启动服务器
node --test test/voice.test.js # 联机语音令牌与接线（不需要 LiveKit 服务器）
```

## 已知取舍

- 已实现暗黑扩展角色行政官、间谍、勒索者、法师、住持和税务官；行政官/勒索者的标记使用引擎状态中的隐藏标记表示。
- 2 人局沿用修订版规则（每人 2 张角色牌、8 栋结束），而非旧版 12 栋。
- 建筑牌采用基本版配置（68 张），未加入全部 30 张紫色扩展建筑，以避免引入资料来源未明确记载的能力。
