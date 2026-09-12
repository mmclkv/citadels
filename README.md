# 富饶之城 / 荣耀之城（Citadels）— 桌游客户端

基于 [冒險安迪 · 榮耀之城规则](https://andyventure.com/boardgame-citadels/) 与
[27 种角色能力介绍](https://andyventure.com/boardgame-citadels-characters/) 实现的完整桌游客户端。
支持 **单人模式**（与电脑 NPC 对战，引擎跑在浏览器里）和 **联机模式**（与真人同房间对战，引擎跑在服务器）。

## 快速开始

```bash
node server.js            # 默认端口 8787
node server.js 9000       # 指定端口
```

启动后浏览器打开：

- 本机：`http://localhost:8787`
- 局域网：`http://<你的内网IP>:8787`（启动时会在终端打印，同一 WiFi 下的朋友可直接用它联机）

零依赖：只用到 Node 内置模块（HTTP、WebSocket 手写实现），无需 `npm install`。

## 本地策略神经网络训练

启动服务器后访问 `http://localhost:8787/training.html`，也可以从主菜单进入“神经网络训练”。
训练器不依赖 Python 或第三方 npm 包，直接复用游戏引擎，在独立 Node.js 子进程中执行共享策略网络自对弈。

- 支持开始、优雅停止与从 checkpoint 继续训练；停止时会保存当前模型。
- 所有座位使用同一个策略价值网络，并且网络输入来自 `Engine.sanitize`，不会读取对手手牌、隐藏角色或牌库顺序。
- 使用合法动作枚举与动作掩码，策略只在通过引擎校验的行动中采样。
- 使用 PPO 裁剪目标、价值损失与探索熵；控制台实时显示损失曲线、速度、推理延迟、分数和座位胜局。
- `fast`、`balanced`、`large` 三档约为 12.4 万、32.1 万、61.6 万参数；当前电脑建议先用 `balanced` 跑 100 局基准，再决定是否使用 `large`。
- 模型存档位于 `training-data/checkpoint-XXXXXX.json.gz`，该目录已加入 `.gitignore`。

训练控制接口只允许服务器本机调用：

```text
GET  /api/training/status
POST /api/training/start
POST /api/training/stop
```

建议先进行 100～500 局短跑，确认平均整局耗时和损失变化正常，再启动 10,000 局正式训练。
浏览器页面可以关闭，后台训练不会停止；重新打开控制台即可继续查看进度。

## 用手机玩

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

- 空缺座位可一键设为电脑；房主可随时调整人数 / 结束条件 / 角色组。
- 玩家中途断线会自动由电脑托管，不会卡住牌局。

### AI Agent 电脑（大模型决策）

普通电脑使用浏览器或服务器内的启发式规则。AI Agent 则由游戏服务器向模型发送
该玩家可见的局面、角色说明及合法动作，模型选择一个动作，服务器校验并执行，
再把更新后的局面交给模型继续决策。每个选角、资源选择、建筑和能力操作都经过
模型请求；游戏速度设置控制动作之间的间隔，不会跳过模型等待。

旧版 `f64238e` 的 Agent 只是启发式规则包装，不调用模型；本实现替换了该行为。

**默认无需配置模型 API。** 运行 `node server.js` 或双击 `start-server.bat` 时，服务器会
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

可以设置上述环境变量后运行 `node server.js`。支持 `--env-file` 的 Node 也可以在
仓库根目录创建本机专用 `.env`，写入以上变量，再运行 `node --env-file=.env server.js`。
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
node --test test/agent.test.js test/agent-net.test.js
node --test test/codex-agent-gateway.test.js
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
├── server.js          # HTTP + WebSocket 服务、房间管理、电脑托管驱动
├── src/
│   ├── cards.js       # 建筑牌与角色牌数据（Node / 浏览器共用）
│   ├── engine.js      # 规则引擎状态机（Node / 浏览器共用）
│   └── ai.js          # NPC 启发式决策（easy / normal / hard）
├── public/
│   ├── index.html     # 主菜单 / 设置 / 大厅 / 对局 / 结算
│   ├── style.css      # 羊皮纸中世纪风格（浅色）
│   ├── app.js         # 客户端逻辑，本地与联机共用同一套 UI
│   ├── themes/        # 主题管理器、资源 manifest 与 neon CSS
│   └── assets/themes/neon/cards/
│       ├── roles/{thumb,full}/      # 21 张角色卡的两级 WebP
│       └── districts/{thumb,full}/  # 30 种建筑卡的两级 WebP
└── test/
    ├── simulate.js    # 引擎冒烟：2–8 人 × 3 角色组全量对局
    ├── net.js         # 联机链路：建房 / 加入 / 开局 / 完整对局
    ├── dom-smoke.js   # 客户端 UI：极简 DOM 桩驱动整局渲染
    └── theme-assets.js # neon 主题卡图 manifest 与文件完整性
```

## 测试

```bash
node test/simulate.js          # 22 组配置 × 3 局，检查不卡死、计分自洽
node test/dom-smoke.js 5 mixed 8   # 客户端渲染整局（参数：人数 角色组 结束栋数）
node test/theme-assets.js      # 检查 21 角色 / 30 建筑的 full/thumb 资源
node test/net.js 8787          # 需先启动服务器
```

## 已知取舍

- 未实现需要额外配件的角色：行政官（逮捕令标记）、勒索者（威胁标记）、间諜、稅務官。
- 2 人局沿用修订版规则（每人 2 张角色牌、8 栋结束），而非旧版 12 栋。
- 建筑牌采用基本版配置（68 张），未加入全部 30 张紫色扩展建筑，以避免引入资料来源未明确记载的能力。
