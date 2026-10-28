/* =========================================================================
 * <c-citadels-lobby> — PC 端与移动端共用的「首页 / 单人设置 / 联机大厅」组件。
 *
 * 把 public/index.html 里的 screen-home / screen-setup / screen-lobby 三段
 * 标记，以及 public/app.js 里对应的开局前逻辑（节奏、MCTS 配置、房间列表、
 * 大厅渲染、WebSocket 前段驱动）搬进一个 Shadow DOM 组件，供 index.html 与
 * mobile.html 同时复用，避免维护两份拷贝。
 *
 * 页面侧接口：
 *   el.onGameStart = ({ ws, send, myId, roomId, name, state }) => { ... }
 *       对局开始/恢复时（phase !== 'lobby'）调用一次，随后 socket 交给页面。
 *   el.returnToHome()
 *       回到主菜单时由页面调用，组件回收 socket、保留恢复凭据、回首页。
 *   el.returnToLobby(state)
 *       联机房间重开时由页面调用，组件收回 socket 并显示大厅房间。
 *   el.reconnect()
 *       对局中断线时由页面调用，重连并用本地令牌恢复，成功后再次触发 onGameStart。
 *   组件会在每次切屏时设置 document.documentElement 的 data-lobby-screen
 *   属性（home | setup | lobby | game），宿主页面据此隐藏自己的对局界面。
 *
 * 单文件、无构建、原生 ES2020，node --check 可通过。
 * ========================================================================= */
(function () {
  'use strict';

  const NET_SESSION_KEY = 'citadels.net.session';
  const NET_PLAYER_SESSIONS_KEY = 'citadels.net.playerSessions';
  const NET_NAME_KEY = 'citadels.net.name';
  const SCENARIOS = (window.CitCards && window.CitCards.SCENARIOS) || [];
  const SCENARIO_OPTIONS = '<option value="">不使用剧本</option>' +
    SCENARIOS.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('');

  /* 标记：完整照搬 index.html 第 19–223 行的三段 <section>，只补了 3 个
     data-desktop-only（见下方 CSS 注释）。 */
  const MARKUP = `
<section id="screen-home" class="screen active">
  <div class="home-wrap">
    <div class="theme-control" aria-label="界面主题">
      <span>主题</span>
      <div class="theme-options">
        <button class="theme-option" type="button" data-theme-choice="classic">经典</button>
        <button class="theme-option" type="button" data-theme-choice="neon">霓虹</button>
      </div>
    </div>
    <div class="home-title">
      <div class="crown">冠</div>
      <h1>富饶之城</h1>
      <p class="sub">荣耀之城 · Citadels</p>
      <p class="home-version" id="home-version" aria-live="polite">版本信息加载中…</p>
    </div>
    <p class="home-desc">
      你是中世纪的一城之主。每轮秘密选择一名角色，运用其能力赚取金币、夺取资源、大兴土木。
      当有人建起第 8 座城区时，城邦的价值将被清算，最高分者加冕为王。
    </p>
    <div class="home-modes">
      <button class="mode-card" id="btn-single">
        <div class="mode-icon">▣</div>
        <div class="mode-name">单人模式</div>
        <div class="mode-tip">与电脑对手同场博弈，支持 2–8 人</div>
      </button>
      <button class="mode-card" id="btn-online">
        <div class="mode-icon">◎</div>
        <div class="mode-name">联机模式</div>
        <div class="mode-tip">创建房间或输入房号，与好友对战</div>
      </button>
      <button class="mode-card" id="btn-debug-game" type="button">
        <div class="mode-icon">⚙</div>
        <div class="mode-name">调试模式</div>
        <div class="mode-tip">编辑任意对局状态，公开手牌并手动推进</div>
      </button>
      <a class="mode-card" href="./replays.html" id="btn-replays">
        <div class="mode-icon">▶</div>
        <div class="mode-name">查看录像</div>
        <div class="mode-tip">浏览已完成对局，播放或逐步复盘</div>
      </a>
      <button class="mode-card" id="btn-rules">
        <div class="mode-icon">≡</div>
        <div class="mode-name">规则速查</div>
        <div class="mode-tip">角色能力、建筑效果与计分方式</div>
      </button>
      <button class="mode-card" id="btn-all-roles" type="button">
        <div class="mode-icon">♛</div>
        <div class="mode-name">角色一览</div>
        <div class="mode-tip">查看全部角色卡与角色能力</div>
      </button>
      <button class="mode-card" id="btn-all-buildings" type="button">
        <div class="mode-icon">▤</div>
        <div class="mode-name">建筑一览</div>
        <div class="mode-tip">查看全部建筑卡与特殊效果</div>
      </button>
      <button class="mode-card" id="btn-scenarios" type="button">
        <div class="mode-icon">▥</div>
        <div class="mode-name">剧本一览</div>
        <div class="mode-tip">查看各剧本的角色与独特建筑</div>
      </button>
      <a class="mode-card training-link" href="./training.html" data-desktop-only>
        <div class="mode-icon">◇</div>
        <div class="mode-name">神经网络训练</div>
        <div class="mode-tip">本机自对弈、损失曲线与 checkpoint</div>
      </a>
    </div>
    <button class="btn ghost home-console-btn" id="btn-server-console" type="button" data-desktop-only>
      服务器控制台
    </button>
    <button class="btn ghost home-console-btn" id="btn-server-startup" type="button" data-desktop-only>
      启动信息
    </button>
    <footer class="home-foot">规则与卡牌资料参考 <a href="https://andyventure.com/boardgame-citadels/" target="_blank" rel="noopener">冒險安迪 · 榮耀之城</a></footer>
  </div>
</section>

<!-- ============================ 剧本一览 ============================ -->
<section id="screen-scenarios" class="screen">
  <div class="panel wide-panel scenario-panel">
    <div class="scenario-heading"><h2>剧本一览</h2><button class="btn ghost" type="button" data-goto="home">返回主页</button></div>
    <label class="field"><span>选择剧本</span><select id="scenario-reference-choice">${SCENARIOS.map(s => '<option value="' + s.id + '">' + s.name + '</option>').join('')}</select></label>
    <p class="dim small scenario-note">以下为剧本原始配置。开局时按人数适配：两人不使用 9 号角色，皇帝改为国王；三、四人皇后改为艺术家；经典组合在三人、八人局加入艺术家。</p>
    <h3 class="section-title" id="scenario-role-heading">角色</h3>
    <div class="char-grid scenario-grid" id="scenario-reference-roles"></div>
    <h3 class="section-title" id="scenario-district-heading">独特建筑</h3>
    <div class="char-grid scenario-grid" id="scenario-reference-districts"></div>
  </div>
</section>

<!-- ============================ 单人设置 ============================ -->
<section id="screen-setup" class="screen">
  <div class="panel wide-panel">
    <h2>单人模式设置</h2>
    <div class="setup-grid">
      <label class="field">
        <span>玩家总数（含电脑）</span>
        <select id="cfg-players">
          <option value="2">2 人</option>
          <option value="3">3 人</option>
          <option value="4" selected>4 人</option>
          <option value="5">5 人（最佳）</option>
          <option value="6">6 人</option>
          <option value="7">7 人</option>
          <option value="8">8 人</option>
        </select>
      </label>
      <label class="field">
        <span>电脑类型</span>
        <select id="cfg-bot-type">
          <option value="npc-hard" selected>启发式电脑（MCTS）</option>
          <option value="neural">策略神经网络（仓库自带权重）</option>
          <option value="agent">AI Agent 电脑（大模型决策，需要联网）</option>
        </select>
      </label>
      <label class="field search-only">
        <span>搜索时间预算（ms）</span>
        <input id="cfg-search-time" type="number" min="1" step="1" value="10000" inputmode="numeric">
      </label>
      <div class="field search-only">
        <button id="cfg-advanced-toggle" class="btn ghost" type="button" aria-expanded="false" aria-controls="cfg-mcts-advanced">高级选项</button>
      </div>
      <div id="cfg-mcts-advanced" class="setup-grid mcts-advanced" hidden>
        <label class="field">
          <span>MCTS 模拟次数</span>
          <input id="cfg-mcts-sims" type="number" min="1" step="1" placeholder="自动" inputmode="numeric">
        </label>
        <label class="field">
          <span>MCTS 最大搜索深度</span>
          <input id="cfg-mcts-depth" type="number" min="1" step="1" placeholder="自动" inputmode="numeric">
        </label>
        <label class="field">
          <span>MCTS 隐藏信息粒子数</span>
          <input id="cfg-mcts-particles" type="number" min="1" step="1" placeholder="自动" inputmode="numeric">
        </label>
        <p class="dim small mcts-hint">搜索达到时间预算或模拟次数上限时结束。启发式电脑的参数留空时自动配置。</p>
      </div>
      <label class="field">
        <span>结束条件</span>
        <select id="cfg-end">
          <option value="8" selected>建成 8 栋（标准）</option>
          <option value="7">建成 7 栋（加快）</option>
        </select>
      </label>
      <label class="field">
        <span>角色组</span>
        <select id="cfg-chars">
          <option value="base" selected>基本版（8 角色）</option>
          <option value="dark">黑暗城市扩充（9 角色）</option>
          <option value="mixed">加强版混合（每号随机）</option>
          <option value="custom">自选角色</option>
        </select>
      </label>
      <div class="role-custom-picker" id="cfg-role-picker" hidden></div>
      <label class="field">
        <span>剧本</span><select id="cfg-scenario">${SCENARIO_OPTIONS}</select>
      </label>
      <p class="dim small" id="cfg-scenario-hint">选择剧本后，角色组设置不生效。</p>
      <label class="field">
        <span>你的名字</span>
        <input id="cfg-name" type="text" value="我" maxlength="10">
      </label>
    </div>
    <label class="field"><span>游戏服务器地址（AI Agent / 策略神经网络需要；留空使用当前站点）</span>
      <input id="cfg-server" type="url" placeholder="https://你的游戏服务器"></label>
    <p class="dim small" id="cfg-agent-status" role="status">普通电脑可以离线玩；AI Agent 和策略神经网络通过游戏服务器运行。</p>
    <div class="btn-row">
      <button class="btn ghost" data-goto="home">返回</button>
      <button class="btn primary" id="btn-start-single">开始游戏</button>
    </div>
  </div>
</section>

<!-- ============================ 联机大厅 ============================ -->
<section id="screen-lobby" class="screen">
  <div class="panel wide-panel">
    <h2 id="lobby-title">联机大厅</h2>

    <div id="lobby-pre">
      <label class="field"><span>游戏服务器地址（留空使用当前站点）</span>
        <input id="net-server" type="url" placeholder="https://你的游戏服务器"></label>
      <p class="dim small" id="net-agent-status" role="status">AI Agent 需要模型服务；策略神经网络可直接使用仓库自带权重。</p>
      <div class="lobby-cols">
        <div class="lobby-box">
          <h3>创建房间</h3>
          <label class="field"><span>你的昵称</span><input id="net-name" type="text" value="玩家" maxlength="10"></label>
          <label class="field"><span>房间人数</span>
            <select id="net-players">
              <option value="2">2 人</option><option value="3">3 人</option>
              <option value="4" selected>4 人</option><option value="5">5 人</option>
              <option value="6">6 人</option><option value="7">7 人</option><option value="8">8 人</option>
            </select>
          </label>
          <label class="field"><span>模式</span><select id="net-team-mode"><option value="off" selected>个人战</option><option value="on">团队战（2v2 / 3v3 / 4v4）</option></select></label>
          <label class="field"><span>断线/离开后电脑托管默认值</span>
            <select id="net-auto-host"><option value="on" selected>开启</option><option value="off">关闭</option></select>
          </label>
          <p class="dim small">每位玩家都可以在对局菜单中单独调整自己的托管选项。电脑座位和策略网络参数在创建房间后设置。</p>
          <label class="field"><span>结束条件</span>
            <select id="net-end"><option value="8" selected>建成 8 栋</option><option value="7">建成 7 栋（加快）</option></select>
          </label>
          <label class="field"><span>角色组</span>
            <select id="net-chars"><option value="base" selected>基本版</option><option value="dark">黑暗城市扩充</option><option value="mixed">加强版混合</option><option value="custom">自选角色</option></select>
          </label>
          <div class="role-custom-picker" id="net-role-picker" hidden></div>
          <label class="field voice-capable" hidden><span>房间语音</span>
            <select id="net-voice"><option value="on" selected>开启</option><option value="off">关闭</option></select>
          </label>
          <label class="field"><span>剧本</span><select id="net-scenario">${SCENARIO_OPTIONS}</select></label>
          <p class="dim small" id="net-scenario-hint">选择剧本后，角色组设置不生效。</p>
          <p class="dim small voice-capable" hidden>语音由 LiveKit 转发音频，真人座位之间可实时通话；电脑座位不参与语音。</p>
          <button class="btn primary block" id="btn-create">创建房间</button>
        </div>
        <div class="lobby-box">
          <h3>加入房间</h3>
          <label class="field"><span>房间编号</span><input id="net-code" type="text" placeholder="4 位房号" maxlength="4" autocomplete="off"></label>
          <button class="btn primary block" id="btn-join">加入</button>
          <button class="btn ghost block" id="btn-spectate">观战已开始的房间</button>
          <button class="btn ghost block" id="btn-refresh">刷新房间列表</button>
          <div class="room-list" id="room-list"><div class="dim">加载中…</div></div>
        </div>
      </div>
      <div class="btn-row"><button class="btn ghost" data-goto="home">返回</button></div>
    </div>

    <div id="lobby-room" hidden>
      <div class="room-head">
        <div class="room-code">房号 <b id="r-code">----</b></div>
        <div class="room-cfg">
          <label class="field inline"><span>人数</span>
            <select id="r-players"><option value="2">2</option><option value="3">3</option><option value="4" selected>4</option>
              <option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></label>
          <label class="field inline"><span>模式</span><select id="r-team-mode"><option value="off" selected>个人</option><option value="on">团队</option></select></label>
          <label class="field inline"><span>结束</span>
            <select id="r-end"><option value="8" selected>8 栋</option><option value="7">7 栋</option></select></label>
          <label class="field inline"><span>角色</span>
            <select id="r-chars"><option value="base" selected>基本版</option><option value="dark">黑暗扩充</option><option value="mixed">混合</option><option value="custom">自选角色</option></select></label>
          <label class="field inline voice-capable" hidden><span>语音</span>
            <select id="r-voice"><option value="on" selected>开</option><option value="off">关</option></select></label>
          <label class="field inline"><span>剧本</span><select id="r-scenario">${SCENARIO_OPTIONS}</select></label>
        </div>
      </div>
      <div class="role-custom-picker" id="r-role-picker" hidden></div>
      <div class="seat-grid" id="seat-grid"></div>
      <p class="dim small" id="r-scenario-hint">选择剧本后，角色组设置不生效。</p>
      <p class="dim small">把房间号告诉朋友即可加入；房主可以在每个座位卡片内设置电脑类型和策略网络参数。</p>
      <div class="btn-row">
        <button class="btn ghost" id="btn-leave">离开房间</button>
        <button class="btn ghost" id="btn-net-shuffle">打乱座位</button>
        <button class="btn primary" id="btn-net-start">开始游戏</button>
      </div>
    </div>
  </div>
</section>
`;

  /* 只重声明 themes/neon/theme.css 中会命中首页/设置/大厅的规则。
     原规则前缀是 html[data-theme="neon"]，在 Shadow DOM 中匹配不到，
     这里统一改写成 :host([data-theme="neon"])。布局仍由 style.css 负责，
     两个 <link> 直接指向页面同名样式表。 */
  const NEON_CSS = `
:host { display:none; }
:host([data-active]) { display:flex; flex-direction:column; }
/* mode="mobile" 时隐藏 PC 专属入口：训练链接、服务器控制台、启动信息 */
:host([mode="mobile"]) [data-desktop-only] { display:none; }
#screen-scenarios { align-items:center; overflow-y:auto; padding:24px 12px; }
.scenario-panel { min-width:0; flex-shrink:0; }
.scenario-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
.scenario-heading h2 { margin:0; flex:1; }
.scenario-heading .btn { flex-shrink:0; }
.scenario-note { margin:14px 0; line-height:1.7; }
.scenario-grid { grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); }
.scenario-grid .ref-card { min-width:0; padding:12px; background:var(--paper2); color:var(--ink); }
.scenario-grid .rc-art { aspect-ratio:2/3; object-fit:contain; }
@media(max-width:600px) {
  #screen-scenarios { padding:12px 8px; }
  .scenario-panel { width:100%; max-width:100%; padding:16px 12px; }
  .scenario-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .scenario-grid .ref-card p { font-size:12px; }
}

/* 霓虹主题变量：原定义在 html[data-theme="neon"] 上，无法命中 Shadow 内部选择器，
   在宿主元素上镜像一份，供下面的霓虹规则取用。 */
:host([data-theme="neon"]) {
  color-scheme:dark;
  --bg:#050a12; --bg2:#091321;
  --paper:rgba(9,16,27,.92); --paper2:rgba(4,11,20,.88);
  --ink:#eaf7ff; --ink2:#b4c9d8; --dim:#7890a4;
  --line:#1b3a4e; --line2:#2b6379;
  --gold:#f0bc45; --gold-l:#7f6528; --gold-d:#ffd977;
  --shadow:0 8px 28px rgba(0,0,0,.28); --shadow2:0 16px 50px rgba(0,0,0,.42);
  --c-yellow:#f0bc45; --c-yellow-d:#ffd977;
  --c-blue:#45c8ff; --c-blue-d:#a0e7ff;
  --c-green:#4bda9a; --c-green-d:#9bf4c5;
  --c-red:#ff5e67; --c-red-d:#ff9da2;
  --c-purple:#bf71ff; --c-purple-d:#e1b7ff;
  --ui-cyan:#43e4ff; --ui-magenta:#ff4fc7;
  --ui-panel:rgba(7,14,25,.88); --ui-panel-strong:rgba(5,11,20,.96);
}
:host([data-theme="neon"]) .screen { position:relative; z-index:1; }

/* 主题切换控件（非霓虹时 theme-option 用浅色底） */
:host(:not([data-theme="neon"])) .theme-control .theme-option { background:rgba(255,253,248,.72); }

/* 主菜单 */
:host([data-theme="neon"]) #screen-home {
  align-items:center;
  overflow:auto;
  padding:calc(48px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right))
          calc(30px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
}
:host([data-theme="neon"]) #screen-home.active > * { margin:auto; }
:host([data-theme="neon"]) .home-wrap { max-width:980px; text-align:left; }
:host([data-theme="neon"]) .home-wrap::before {
  content:"";
  position:absolute;
  inset:12% 4% 10%;
  z-index:-1;
  opacity:.62;
  background:
    linear-gradient(90deg, transparent 0 5%, rgba(67,228,255,.18) 5.1% 5.35%, transparent 5.45% 14%, rgba(255,79,199,.15) 14.1% 14.3%, transparent 14.4% 100%),
    repeating-linear-gradient(90deg, transparent 0 7%, rgba(67,228,255,.11) 7.1% 7.35%, transparent 7.45% 12%),
    linear-gradient(180deg, transparent 0 48%, rgba(67,228,255,.12) 48.1% 48.35%, transparent 48.5%);
  clip-path:polygon(0 22%,8% 22%,8% 9%,14% 9%,14% 30%,24% 30%,24% 0,30% 0,30% 17%,38% 17%,38% 6%,44% 6%,44% 27%,52% 27%,52% 13%,59% 13%,59% 31%,68% 31%,68% 4%,74% 4%,74% 22%,82% 22%,82% 10%,89% 10%,89% 26%,100% 26%,100% 100%,0 100%);
}
:host([data-theme="neon"]) .home-title { margin:0 0 14px; }
:host([data-theme="neon"]) .home-title .crown { color:var(--ui-magenta); filter:drop-shadow(0 0 12px rgba(255,79,199,.55)); }
:host([data-theme="neon"]) .home-title h1 {
  color:var(--ink);
  background:none;
  -webkit-text-fill-color:initial;
  text-shadow:0 0 22px rgba(67,228,255,.34);
  font-size:clamp(36px,6vw,58px);
}
:host([data-theme="neon"]) .home-title .sub { color:var(--ui-cyan); }
:host([data-theme="neon"]) .home-desc { margin:0 0 26px; color:var(--ink2); max-width:560px; }
:host([data-theme="neon"]) .home-modes { justify-content:flex-start; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
:host([data-theme="neon"]) .mode-card {
  width:auto;
  min-height:132px;
  padding:17px 15px;
  text-align:left;
  background:linear-gradient(145deg,rgba(9,22,35,.95),rgba(7,13,24,.82));
  border:1px solid var(--line);
  border-radius:4px;
  box-shadow:inset 0 1px 0 rgba(234,247,255,.06),var(--shadow);
  color:var(--ink);
  clip-path:polygon(0 10px,10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%);
}
:host([data-theme="neon"]) .mode-card:hover { transform:translateY(-3px); border-color:var(--ui-cyan); box-shadow:0 0 22px rgba(67,228,255,.16),inset 0 1px 0 rgba(234,247,255,.1); }
:host([data-theme="neon"]) .mode-icon { color:var(--ui-cyan); font-size:25px; margin-bottom:15px; }
:host([data-theme="neon"]) .mode-name { color:var(--ink); letter-spacing:.08em; }
:host([data-theme="neon"]) .mode-tip { color:var(--dim); }
:host([data-theme="neon"]) .home-foot { color:var(--dim); text-align:left; }
:host([data-theme="neon"]) .home-foot a { color:var(--ui-cyan); }
.home-version{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dim);overflow-wrap:anywhere}

/* 面板、输入框、按钮 */
:host([data-theme="neon"]) .panel,
:host([data-theme="neon"]) .lobby-box {
  background:var(--ui-panel);
  border-color:var(--line);
  box-shadow:var(--shadow2),inset 0 1px 0 rgba(234,247,255,.055);
  border-radius:4px;
}
:host([data-theme="neon"]) .panel h2,
:host([data-theme="neon"]) .lobby-box h3 { color:var(--ui-cyan); border-color:var(--line2); }
:host([data-theme="neon"]) .field>span,
:host([data-theme="neon"]) .dim { color:var(--dim); }
:host([data-theme="neon"]) button,
:host([data-theme="neon"]) input,
:host([data-theme="neon"]) select { color:var(--ink); }
:host([data-theme="neon"]) button:focus-visible,
:host([data-theme="neon"]) input:focus-visible { outline:2px solid var(--ui-cyan); outline-offset:3px; }
:host([data-theme="neon"]) input,
:host([data-theme="neon"]) select { background:rgba(4,11,20,.8); border-color:var(--line2); color:var(--ink); }
:host([data-theme="neon"]) input:focus,
:host([data-theme="neon"]) select:focus {
  outline:none;
  border-color:var(--ui-cyan);
  box-shadow:0 0 0 3px rgba(67,228,255,.14),0 0 14px rgba(67,228,255,.30);
}
:host([data-theme="neon"]) .btn {
  background:rgba(9,22,35,.84);
  color:var(--ink);
  border-color:var(--line2);
  border-radius:4px;
}
:host([data-theme="neon"]) .btn:hover { background:rgba(17,43,58,.92); border-color:var(--ui-cyan); }
:host([data-theme="neon"]) .btn.primary {
  background:linear-gradient(180deg,#1b7f99,#14576d);
  border-color:var(--ui-cyan);
  color:#e9fbff;
  text-shadow:0 0 8px rgba(67,228,255,.4);
}
:host([data-theme="neon"]) .btn.ghost { background:transparent; }

/* 大厅房间与座位 */
:host([data-theme="neon"]) .room-item,
:host([data-theme="neon"]) .seat { background:rgba(7,17,29,.78); border-color:var(--line); }
:host([data-theme="neon"]) .room-item:hover { border-color:var(--ui-cyan); background:rgba(12,33,47,.88); }
:host([data-theme="neon"]) .room-item .ri-code,
:host([data-theme="neon"]) .room-code b { color:var(--ui-cyan); }
:host([data-theme="neon"]) .seat.me { border-color:var(--ui-magenta); background:rgba(39,14,43,.48); box-shadow:0 0 0 2px rgba(255,79,199,.15); }

/* 窄屏变体（theme.css 中的 @media(max-width:820px) 对应项） */
@media (max-width:820px) {
  :host([data-theme="neon"]) .theme-control { top:10px; right:12px; }
  :host([data-theme="neon"]) .home-wrap { max-width:560px; }
  :host([data-theme="neon"]) .home-modes { grid-template-columns:1fr; }
  :host([data-theme="neon"]) .mode-card { min-height:0; }
}
`;

  class CCitadelsLobby extends HTMLElement {
    connectedCallback() {
      if (this.__built) { syncHostTheme(); return; }
      this.__built = true;
      const host = this;
      const root = this.attachShadow({ mode: 'open' });

      /* ----- 样式：同一份页面样式表 + 霓虹改写 + 宿主显隐 ----- */
      const linkStyle = document.createElement('link');
      linkStyle.rel = 'stylesheet';
      linkStyle.href = new URL('./style.css', document.baseURI).href;
      const linkTheme = document.createElement('link');
      linkTheme.rel = 'stylesheet';
      linkTheme.href = new URL('./themes/neon/theme.css', document.baseURI).href;
      const styleEl = document.createElement('style');
      styleEl.textContent = NEON_CSS;
      root.append(linkStyle, linkTheme, styleEl);

      /* ----- 标记：放进 <template>，再克隆进 Shadow ----- */
      const tpl = document.createElement('template');
      tpl.innerHTML = MARKUP;
      root.appendChild(tpl.content.cloneNode(true));

      /* 组件自带一个 toast（复制过来的错误提示会调用 toast()，页面无此节点） */
      const toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.hidden = true;
      root.appendChild(toastEl);

      /* ============================ Shadow 作用域工具 ============================ */
      const $ = s => root.querySelector(s);
      const $$ = s => Array.from(root.querySelectorAll(s));
      const roleGroups = {};
      (window.CitCards && window.CitCards.CHARACTERS || []).forEach(role => {
        (roleGroups[role.num] = roleGroups[role.num] || []).push(role);
      });
      const customRoleSelections = {};
      Object.keys(roleGroups).forEach(number => customRoleSelections[number] = roleGroups[number].map(role => role.id));
      function renderRolePickers() {
        ['cfg', 'net', 'r'].forEach(prefix => {
          const box = $('#' + prefix + '-role-picker');
          if (!box) return;
          box.innerHTML = '<div class="role-picker-title">每个编号至少选一个角色；选中多个时开局随机抽取</div>' +
            Object.keys(roleGroups).sort((a, b) => Number(a) - Number(b)).map(number =>
              '<fieldset class="role-number-group"><legend>' + number + ' 号</legend><button type="button" class="btn tiny role-select-all" data-role-number="' + number + '">全选</button><div class="role-choice-list">' +
              roleGroups[number].map(role => '<label><input type="checkbox" data-role-number="' + number + '" data-role-id="' + role.id + '" checked><span>' + escapeHtml(role.name) + '</span></label>').join('') +
              '</div></fieldset>').join('');
          box.addEventListener('change', event => {
            const input = event.target.closest('input[data-role-id]');
            if (!input) return;
            const number = input.dataset.roleNumber;
            const chosen = Array.from(box.querySelectorAll('input[data-role-id]'))
              .filter(node => node.dataset.roleNumber === number && node.checked);
            if (!chosen.length) { input.checked = true; toast('每个编号至少保留一个角色'); return; }
            customRoleSelections[number] = chosen.map(node => node.dataset.roleId);
            syncRolePickers();
            if (prefix === 'r' && App.lobbyState) sendRoomConfig();
          });
          box.addEventListener('click', event => {
            const button = event.target.closest('.role-select-all');
            if (!button) return;
            const number = button.dataset.roleNumber;
            customRoleSelections[number] = roleGroups[number].map(role => role.id);
            syncRolePickers();
            if (prefix === 'r' && App.lobbyState) sendRoomConfig();
          });
        });
        syncRolePickers();
      }
      function syncRolePickers() {
        ['cfg', 'net', 'r'].forEach(prefix => {
          const box = $('#' + prefix + '-role-picker');
          if (!box) return;
          box.querySelectorAll('input[data-role-id]').forEach(input => {
            input.checked = (customRoleSelections[input.dataset.roleNumber] || []).includes(input.dataset.roleId);
            input.disabled = prefix === 'r' && !(App.lobbyState && App.lobbyState.seats && App.lobbyState.seats[0] && App.lobbyState.seats[0].id === App.myId);
          });
        });
      }
      function sendRoomConfig() {
        Net.send({ t: 'config', config: { playerCount: Number($('#r-players').value), teamMode: $('#r-team-mode').value === 'on', endDistricts: Number($('#r-end').value),
          charSetMode: $('#r-chars').value, customRoleSelections, scenario: $('#r-scenario').value, voice: $('#r-voice').value === 'on' } });
      }
      function syncTeamPlayerOptions(prefix) {
        const team = $('#' + prefix + '-team-mode').value === 'on';
        const select = $('#' + prefix + '-players');
        Array.from(select.options).forEach(option => {
          option.disabled = team && !['4', '6', '8'].includes(option.value);
        });
        if (team && !['4', '6', '8'].includes(select.value)) select.value = '4';
        const endSelect = $('#' + prefix + '-end');
        if (endSelect) {
          endSelect.disabled = team;
          if (team) endSelect.value = '8';
        }
      }
      async function loadHomeVersion() {
        const label = $('#home-version');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          // Live servers expose their startup identity; Pages releases ship version.json.
          for (const path of ['./api/version', './version.json']) {
            try {
              const response = await fetch(new URL(path, document.baseURI), {
                cache: 'no-store', signal: controller.signal
              });
              if (!response.ok) continue;
              const release = await response.json();
              if (!release || typeof release.version !== 'string' || !release.version) continue;
              const channel = release.channel === 'stable' ? '稳定版' :
                release.channel === 'development' ? '开发版' : '';
              label.textContent = '版本：' + release.version + (channel ? ' · ' + channel : '');
              if (typeof release.commit === 'string') label.title = '提交：' + release.commit;
              return;
            } catch (_) { /* Try the static release identity when no live endpoint exists. */ }
          }
          label.textContent = '版本信息暂不可用';
        } finally { clearTimeout(timeout); }
      }
      function el(tag, cls, html) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
      }

      function syncHostTheme() {
        const t = document.documentElement.getAttribute('data-theme') || 'neon';
        host.setAttribute('data-theme', t);
      }

      let toastTimer = null;
      function toast(msg) {
        toastEl.textContent = msg; toastEl.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
      }
      function escapeHtml(x) {
        return String(x == null ? '' : x).replace(/[&<>"']/g, m =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
      }
      /* 下面三个是复制代码里会被调到、但已属对局内职责的函数，这里用最小占位保证调用不变。 */
      function renderBotDebug() { /* 电脑决策调试属对局内 */ }
      function hideEvent() { /* 事件弹层属对局内 */ }
      function voiceSync() { $$('.voice-capable').forEach(node => { node.hidden = true; }); } // 语音属对局内，统一下沉到页面
      function clearGameBoardView() {
        // 这些容器在组件里不存在（属对局界面），$ 返回 null 时会安全跳过。
        ['#draft-pool', '#opponents', '#my-city', '#my-hand'].forEach(sel => {
          const node = $(sel);
          if (node) node.innerHTML = '';
        });
        App._reveal = Object.create(null);
        App.noticeSeen = 0;
        hideEvent(true);
      }

      /* ============================== 全局状态（shim） ============================== */
      const App = {
        mode: 'net',           // 'net'（包含服务器托管的单人房间）
        localServerGame: false,
        state: null,
        myId: null,
        myIdx: null,
        name: '玩家',
        lastCfg: null,
        noticeSeen: null,
        paused: false,
        lobbyState: null,
        leavingNetGame: false,
        botDebugOpen: false,
        botDebugEntries: [],
        chatHistory: [],
        _reveal: {}
      };

      let selectedGameServer = '';
      try { selectedGameServer = localStorage.getItem('citadels.gameServer') || ''; } catch (_) { /* storage unavailable */ }

      function loadNetSession() {
        try {
          const raw = window.localStorage.getItem(NET_SESSION_KEY);
          const data = raw ? JSON.parse(raw) : null;
          if (data && data.server && data.server !== gameServerBase()) return null;
          return data && data.token && data.roomId ? data : null;
        } catch (e) { return null; }
      }
      function loadPlayerSession(roomId) {
        try {
          const server = gameServerBase();
          const sessions = JSON.parse(window.localStorage.getItem(NET_PLAYER_SESSIONS_KEY) || '{}');
          const saved = sessions[JSON.stringify([server, roomId])];
          if (saved && saved.token && saved.server === server && saved.roomId === roomId) return saved;
        } catch (e) { /* 存储不可用或旧数据损坏 */ }
        // 迁移尚未记录身份类型的旧玩家会话；服务端仍会验证恢复凭据。
        const current = loadNetSession();
        return current && current.roomId === roomId && !current.spectating ? current : null;
      }
      function saveNetSession(token, roomId, name, spectating = false) {
        if (!token || !roomId) return;
        try {
          const session = { token, roomId, name: name || '', server: gameServerBase(), spectating };
          if (!spectating) {
            let sessions = {};
            try { sessions = JSON.parse(window.localStorage.getItem(NET_PLAYER_SESSIONS_KEY) || '{}') || {}; }
            catch (e) { /* 忽略损坏的旧凭据 */ }
            sessions[JSON.stringify([session.server, roomId])] = session;
            window.localStorage.setItem(NET_PLAYER_SESSIONS_KEY, JSON.stringify(sessions));
          }
          window.localStorage.setItem(NET_SESSION_KEY, JSON.stringify(session));
        } catch (e) { /* 隐私模式或存储被禁用 */ }
      }
      function clearNetSession() {
        try { window.localStorage.removeItem(NET_SESSION_KEY); } catch (e) { /* ignore */ }
      }
      function forgetPlayerSession(roomId) {
        try {
          const sessions = JSON.parse(window.localStorage.getItem(NET_PLAYER_SESSIONS_KEY) || '{}');
          delete sessions[JSON.stringify([gameServerBase(), roomId])];
          window.localStorage.setItem(NET_PLAYER_SESSIONS_KEY, JSON.stringify(sessions));
        } catch (e) { /* 存储不可用或旧数据损坏 */ }
      }
      function loadNetName() {
        try { return (window.localStorage.getItem(NET_NAME_KEY) || '').trim(); }
        catch (e) { return ''; }
      }
      function saveNetName(name) {
        try {
          if (name && name.trim()) window.localStorage.setItem(NET_NAME_KEY, name.trim().slice(0, 10));
          else window.localStorage.removeItem(NET_NAME_KEY);
        } catch (e) { /* 隐私模式或存储被禁用 */ }
      }
      const netNameInput = $('#net-name');
      if (netNameInput) {
        netNameInput.value = loadNetName() || netNameInput.value || '玩家';
        netNameInput.addEventListener('input', () => saveNetName(netNameInput.value));
      }

      function gameServerBase() {
        const url = new URL(selectedGameServer || location.origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
          throw new Error('请输入有效的游戏服务器地址');
        }
        if (location.protocol === 'https:' && url.protocol !== 'https:') {
          throw new Error('当前网页使用 HTTPS，游戏服务器也需要 HTTPS');
        }
        return url.href.replace(/\/$/, '');
      }
      async function checkAgentServer() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(gameServerBase() + '/api/agent/status', { cache: 'no-store', signal: controller.signal });
          if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
            throw new Error('当前地址没有 Agent 后端。GitHub Pages 用户请填写已部署的游戏服务器地址');
          }
          const status = await response.json();
          if (!status.configured) throw new Error(status.message || '游戏服务器尚未配置 AI 模型');
          return true;
        } catch (e) {
          const message = e.name === 'AbortError' || e instanceof TypeError
            ? '无法连接 Agent 后端，请检查游戏服务器地址和网络连接' : e.message;
          ['#cfg-agent-status', '#net-agent-status'].forEach(sel => { const node = $(sel); if (node) node.textContent = message; });
          toast(message);
          return false;
        } finally { clearTimeout(timer); }
      }
      async function checkNeuralServer() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(gameServerBase() + '/api/neural/status', { cache: 'no-store', signal: controller.signal });
          if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
            throw new Error('当前地址没有策略神经网络后端，请启动游戏服务器');
          }
          const status = await response.json();
          if (!status.configured) throw new Error(status.message || '服务器上没有可用的策略神经网络权重');
          const message = status.message || ('已加载 ' + status.checkpoint);
          ['#cfg-agent-status', '#net-agent-status'].forEach(sel => { const node = $(sel); if (node) node.textContent = message; });
          return true;
        } catch (e) {
          const message = e.name === 'AbortError' || e instanceof TypeError
            ? '无法连接策略神经网络后端，请检查游戏服务器地址' : e.message;
          ['#cfg-agent-status', '#net-agent-status'].forEach(sel => { const node = $(sel); if (node) node.textContent = message; });
          toast(message);
          return false;
        } finally { clearTimeout(timer); }
      }
      const DEFAULT_MCTS_CONFIG = { simulations: 5000, maxDepth: 2000, particles: 4 };
      const seatAdvancedOpen = new Set();
      let singleAdvancedOpen = false;
      let singleSearchType = 'npc-hard';
      function readSearchBudget() {
        const input = $('#cfg-search-time');
        return Math.max(1, Math.floor(Number(input.value) || 10000));
      }
      function readHeuristicAdvanced() {
        const advanced = {};
        if (!singleAdvancedOpen) return advanced;
        [['#cfg-mcts-sims', 'simulations'], ['#cfg-mcts-depth', 'maxDepth'], ['#cfg-mcts-particles', 'particles']].forEach(([id, key]) => {
          if ($(id).value.trim() !== '') advanced[key] = Math.max(1, Math.floor(Number($(id).value) || 1));
        });
        return advanced;
      }
      function readMctsConfig(simsId, depthId, particlesId) {
        const valueOrDefault = (id, fallback) => {
          const node = $(id);
          const raw = node ? String(node.value).trim() : '';
          return raw === '' ? fallback : Number(raw);
        };
        const readInteger = (id, fallback, minimum) => {
          const value = valueOrDefault(id, fallback);
          return Math.max(minimum, Math.floor(Number.isFinite(value) ? value : fallback));
        };
        return { mctsSimulations: readInteger(simsId, DEFAULT_MCTS_CONFIG.simulations, 0),
          mctsMaxDepth: readInteger(depthId, DEFAULT_MCTS_CONFIG.maxDepth, 0),
          mctsParticles: readInteger(particlesId, DEFAULT_MCTS_CONFIG.particles, 1) };
      }
      function syncSearchFields() {
        [['#screen-setup', '#cfg-bot-type']].forEach(pair => {
          const root = $(pair[0]);
          const select = $(pair[1]);
          if (!root || !select) return;
          const show = select.value !== 'agent';
          Array.from(root.querySelectorAll('.search-only')).forEach(node => { node.hidden = !show; });
          $('#cfg-mcts-advanced').hidden = !show || !singleAdvancedOpen;
          $('#cfg-advanced-toggle').setAttribute('aria-expanded', String(singleAdvancedOpen));
          $('#cfg-advanced-toggle').textContent = singleAdvancedOpen ? '收起高级选项' : '高级选项';
          if (singleSearchType !== select.value) {
            const defaults = [
              ['#cfg-mcts-sims', DEFAULT_MCTS_CONFIG.simulations], ['#cfg-mcts-depth', DEFAULT_MCTS_CONFIG.maxDepth],
              ['#cfg-mcts-particles', DEFAULT_MCTS_CONFIG.particles]
            ];
            defaults.forEach(([id, value]) => { $(id).value = select.value === 'neural' ? String(value) : ''; });
            singleSearchType = select.value;
          }
        });
      }
      function normalizeBotSelection(type) {
        return {
          botType: type === 'agent' || type === 'neural' ? type : 'npc',
          botLevel: 'hard'
        };
      }
      async function startPythonSingle(cfg) {
        if (cfg.botType === 'agent' && !(await checkAgentServer())) return;
        if (cfg.botType === 'neural' && !(await checkNeuralServer())) return;
        if (Net.roomId) {
          Net.send({ t: 'leaveRoom' });
          Net.roomId = null;
          clearNetSession();
        }
        App.localServerGame = true;
        App.mode = 'net'; App.leavingNetGame = false;
        Net.startGameRequested = false;
        App.state = null; App.myId = null; App.noticeSeen = 0;
        App.botDebugEntries = [];
        clearGameBoardView();
        Net.name = cfg.name;
        Net.connect(() => {
          Net.autoStart = true;
          Net.send({ t: 'createRoom', name: cfg.name, config: Object.assign({
            playerCount: cfg.players, bots: cfg.players - 1, botType: cfg.botType, botLevel: cfg.level,
            endDistricts: cfg.end, charSetMode: cfg.chars, scenario: cfg.scenario, voice: false,
            customRoleSelections,
            mcts: Object.assign({ timeBudgetMs: readSearchBudget(), advancedEnabled: singleAdvancedOpen }, cfg.botType === 'neural' ? {
              simulations: Number($('#cfg-mcts-sims').value) || 5000,
              maxDepth: Number($('#cfg-mcts-depth').value) || 2000,
              particles: Number($('#cfg-mcts-particles').value) || 4
            } : {}),
            heuristicMcts: { timeBudgetMs: readSearchBudget(), advancedEnabled: singleAdvancedOpen, advanced: readHeuristicAdvanced() }
          }, readMctsConfig('#cfg-mcts-sims', '#cfg-mcts-depth', '#cfg-mcts-particles')) });
        });
      }

      /* ============================== 联机驱动（开局前） ============================== */
      const Net = {
        autoStart: false,
        startGameRequested: false,
        debugState: null,
        ws: null, myId: null, roomId: null, name: '', onState: null, afterHello: null,
        reconnectTimer: null, reconnectDelay: 1000, heartbeatTimer: null,
        handedOver: false,   // 已把 socket 交给页面接管
        recoveringRoomId: null,
        startHeartbeat() {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) this.send({ t: 'heartbeat', ts: Date.now() });
          }, 5000);
        },
        stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; },
        connect(cb, options = {}) {
          let endpoint;
          try { endpoint = gameServerBase().replace(/^http/, 'ws'); }
          catch (e) { this.afterHello = null; toast(e.message); return; }
          if (options.resume !== false && !options.forceReconnect && this.ws &&
              this.ws.readyState === 1 && this.ws.url.replace(/\/$/, '') === endpoint) return cb && cb();
          if (this.ws) {
            this.ws.onclose = null; this.ws.onmessage = null;
            this.stopHeartbeat(); this.ws.close();
          }
          this.afterHello = cb || this.afterHello || null;
          this.ws = new WebSocket(endpoint);
          this.ws.onopen = () => {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
            this.reconnectDelay = 1000;
            this.startHeartbeat();
            const saved = options.resume === false ? null : (options.session ||
              (this.recoveringRoomId && loadPlayerSession(this.recoveringRoomId)) || loadNetSession());
            this.send({ t: 'hello', name: this.name,
              resumeToken: saved && saved.token, roomId: saved && saved.roomId });
          };
          this.attach();
          this.ws.onerror = () => toast('无法连接服务器');
        },
        // 安装消息/断开处理；returnToHome() 会把 socket 从页面手里收回时再调一次。
        attach() {
          const ws = this.ws;
          if (!ws) return;
          ws.onmessage = ev => {
            let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
            this.handle(m);
          };
          ws.onclose = () => {
            this.stopHeartbeat();
            if (this.handedOver) return;   // 已交给页面，断线由页面处理
            toast('与服务器的连接已断开');
            // 刷新服务或短暂断网时，自动使用本地令牌回到原房间。
            if (!loadNetSession() || this.reconnectTimer) return;
            const delay = this.reconnectDelay;
            this.reconnectDelay = Math.min(8000, Math.round(this.reconnectDelay * 1.6));
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.connect(() => this.send({ t: 'listRooms' }));
            }, delay);
          };
        },
        send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
        handle(m) {
          switch (m.t) {
            case 'hello':
              this.myId = m.youId;
              if (!m.resumed && this.afterHello) {
                const cb = this.afterHello; this.afterHello = null; cb();
              } else if (m.resumed) this.afterHello = null;
              break;
            case 'rooms': renderRoomList(m.rooms); break;
            case 'joined':
              if (this.recoveringRoomId === m.roomId && m.state.spectating) {
                this.recoveringRoomId = null;
                this.send({ t: 'leaveRoom' });
                toast('未能恢复原玩家席位，请确认房间仍是原来的对局；如需旁观，请点击观战');
                return;
              }
              const recoveredPlayer = this.recoveringRoomId === m.roomId;
              this.recoveringRoomId = null;
              this.myId = m.youId; this.roomId = m.roomId;
              if (m.resumeToken) saveNetSession(m.resumeToken, m.roomId, this.name, !!m.state.spectating);
              if (m.resumed || recoveredPlayer) toast('已重新连接房间');
              App.myId = m.youId;
              App.botDebugEntries = [];
              if (App.botDebugOpen) renderBotDebug();
              // 大厅里加入 → 从 0 开始；中途加入 → 对齐进度，不回放历史
              App.noticeSeen = (m.state.notices && m.state.notices.length)
                ? m.state.notices[m.state.notices.length - 1].seq : 0;
              App.paused = false; hideEvent(true);
              if (m.state.phase === 'lobby') {
                if (!App.localServerGame) { renderLobbyRoom(m.state); showScreen('lobby'); }
                if (this.autoStart) { this.autoStart = false; this.requestAutoStart(); }
              } else {
                this.autoStart = false;
                handOver(m.state);
              }
              break;
            case 'state':
              if (App.leavingNetGame) break;
              App.state = m.state;
              if (m.state.you) App.myId = m.state.you;
              if (m.state.phase === 'lobby' && App.localServerGame) {
                App.chatHistory = [];
                clearGameBoardView();
                this.requestAutoStart();
              } else if (m.state.phase === 'lobby') {
                App.chatHistory = [];
                renderLobbyRoom(m.state); showScreen('lobby');
              } else {
                handOver(m.state);
              }
              break;
            case 'error': this.autoStart = false; this.recoveringRoomId = null; toast('✗ ' + m.error); break;
          }
        },
        requestAutoStart() {
          if (this.startGameRequested) return;
          this.startGameRequested = true;
          this.send({ t: 'startGame', debugState: this.debugState || undefined });
          this.debugState = null;
        },
      };

      /* ============================== 大厅渲染 ============================== */
      function renderRoomList(rooms) {
        const box = $('#room-list');
        if (!box) return;
        box.innerHTML = '';
        if (!rooms || !rooms.length) { box.appendChild(el('div', 'dim', '暂无房间，创建一个吧')); return; }
        rooms.forEach(r => {
          const d = el('div', 'room-item');
          d.innerHTML = '<div><div class="ri-code">' + r.id + '</div>' +
            '<div class="ri-info">' + escapeHtml(r.name) + ' · ' + r.playerCount + ' 人 · ' +
            (r.phase === 'lobby' ? '等待中' : '进行中') + '</div></div>';
          d.onclick = () => { $('#net-code').value = r.id; };
          if (loadPlayerSession(r.id)) {
            const reconnect = el('button', 'btn tiny primary', '重连');
            reconnect.type = 'button';
            reconnect.onclick = e => {
              e.stopPropagation();
              $('#net-code').value = r.id;
              $('#btn-join').click();
            };
            d.appendChild(reconnect);
          }
          if (r.phase !== 'lobby') {
            const watch = el('button', 'btn tiny', '观战');
            watch.type = 'button';
            watch.onclick = e => {
              e.stopPropagation();
              $('#net-code').value = r.id;
              $('#btn-spectate').click();
            };
            d.appendChild(watch);
          }
          box.appendChild(d);
        });
      }

      function syncScenarioChoice(prefix, canEdit = true) {
        const selected = $('#' + prefix + '-scenario');
        const chars = $('#' + prefix + '-chars');
        const hint = $('#' + prefix + '-scenario-hint');
        const picker = $('#' + prefix + '-role-picker');
        if (!selected || !chars) return;
        const scenario = SCENARIOS.find(s => s.id === selected.value);
        selected.disabled = !canEdit;
        chars.disabled = !!scenario || !canEdit;
        if (picker) {
          picker.hidden = !!scenario || chars.value !== 'custom';
          picker.querySelectorAll('input, button').forEach(control => { control.disabled = !!scenario || !canEdit; });
        }
        if (hint) hint.textContent = scenario ? scenario.name + '：使用固定角色和 14 张独特建筑，角色组设置不生效。两人皇帝改为国王；少于五人皇后改为艺术家；三人、八人经典组合加入艺术家。'
          : chars.value === 'custom' ? '未使用剧本：按编号选择角色；同一编号选中多个时开局随机抽取一个。'
          : '未使用剧本：按角色组选择角色，所有建筑加入牌堆。';
      }
      function renderLobbyRoom(st) {
        App.lobbyState = st;
        $('#lobby-pre').hidden = true;
        $('#lobby-room').hidden = false;
        $('#r-code').textContent = st.roomId;
        $('#lobby-title').textContent = '房间 ' + st.roomId;
        if (st.config) {
          $('#r-players').value = String(st.config.playerCount || 4);
          $('#r-team-mode').value = st.config.teamMode ? 'on' : 'off';
          syncTeamPlayerOptions('r');
          $('#r-end').value = String(st.config.endDistricts || 8);
          $('#r-chars').value = st.config.charSetMode || 'base';
          $('#r-scenario').value = st.config.scenario || '';
          $('#r-voice').value = st.config.voice === false ? 'off' : 'on';
          if (st.config.customRoleSelections) {
            Object.keys(roleGroups).forEach(number => customRoleSelections[number] = st.config.customRoleSelections[number] || roleGroups[number].map(role => role.id));
            syncRolePickers();
          }
        }
        voiceSync();
        const grid = $('#seat-grid');
        grid.innerHTML = '';
        const seats = st.seats || [];
        const amHost = seats.length && seats[0].id === App.myId;
        syncScenarioChoice('r', amHost);
        seats.forEach((s, i) => {
          const d = el('div', 'seat' + (s.taken ? ' taken' : '') + (s.id === App.myId ? ' me' : ''));
          const heuristicLabel = '启发式电脑';
          const botLabel = s.isBot ? (s.botType === 'agent' ? 'AI Agent' : s.botType === 'neural' ? '策略神经网络' : heuristicLabel) : (s.taken ? '真人玩家' : '可加入');
          d.innerHTML = '<div class="seat-no">座位 ' + (i + 1) + (i === 0 ? ' · 房主' : '') + '</div>' +
            '<div class="seat-name">' + (s.taken ? escapeHtml(s.name) : '空缺') + '</div>' +
            '<div class="seat-tag">' + (s.disconnected ? '已断连' : s.left ? '已离开' :
              botLabel) + '</div>';
          if (amHost && i > 0) {
            const ops = el('div', 'seat-ops');
            const b1 = el('button', 'btn tiny', s.isBot ? '换人' : '设为电脑');
            b1.onclick = () => Net.send({ t: 'setSeat', index: i, kind: s.isBot ? 'open' : 'bot' });
            ops.appendChild(b1);
            if (s.isBot) {
              const type = el('select');
              type.setAttribute('aria-label', s.name + '的电脑类型');
              type.innerHTML = '<option value="npc-hard">启发式电脑</option><option value="neural">策略神经网络（仓库权重）</option><option value="agent">AI Agent（模型）</option>';
              type.value = s.botType === 'npc' ? 'npc-hard' : (s.botType || 'npc-hard');
              type.onchange = () => Net.send({ t: 'setSeat', index: i, kind: 'bot', botType: type.value });
              ops.appendChild(type);
              if (s.botType === 'neural' || (s.botType === 'npc' && s.botLevel === 'hard')) {
                const neural = s.botType === 'neural';
                const cfg = (neural ? s.mcts : s.heuristicMcts) || {};
                const box = el('div', 'seat-mcts');
                const advancedKey = st.roomId + ':' + i + ':' + s.botType;
                const sendSearchConfig = (updates) => Net.send({ t: 'setSeat', index: i, kind: 'bot', botType: type.value,
                  [neural ? 'mcts' : 'heuristicMcts']: Object.assign({}, cfg, updates) });
                const budget = el('label', 'seat-mcts-field search-budget');
                budget.innerHTML = '<span>搜索时间预算（ms）</span>';
                const time = document.createElement('input');
                time.type = 'number'; time.min = '1'; time.step = '1';
                time.value = String(cfg.timeBudgetMs == null || cfg.timeBudgetMs < 1 ? 10000 : cfg.timeBudgetMs);
                time.onchange = () => {
                  if (!time.checkValidity()) { time.reportValidity(); return; }
                  sendSearchConfig({ timeBudgetMs: time.value });
                };
                budget.appendChild(time); box.appendChild(budget);
                const toggle = el('button', 'btn tiny', '高级选项');
                toggle.type = 'button';
                const advanced = el('div', 'seat-mcts mcts-advanced');
                advanced.id = 'seat-advanced-' + i;
                toggle.setAttribute('aria-controls', advanced.id);
                const syncAdvanced = () => {
                  const open = cfg.advancedEnabled === true || seatAdvancedOpen.has(advancedKey);
                  advanced.hidden = !open;
                  toggle.setAttribute('aria-expanded', String(open));
                  toggle.textContent = open ? '收起高级选项' : '高级选项';
                };
                toggle.onclick = () => {
                  const open = advanced.hidden;
                  advanced.hidden = !open;
                  toggle.setAttribute('aria-expanded', String(open));
                  toggle.textContent = open ? '收起高级选项' : '高级选项';
                  if (open) seatAdvancedOpen.add(advancedKey);
                  else seatAdvancedOpen.delete(advancedKey);
                  const values = {};
                  ['simulations', 'maxDepth', 'particles'].forEach((key, index) => {
                    const raw = advanced.querySelectorAll('input')[index].value.trim();
                    if (raw) values[key] = Number(raw);
                  });
                  sendSearchConfig(neural ? Object.assign({}, values, { advancedEnabled: open }) :
                    { advancedEnabled: open, advanced: open ? values : {} });
                };
                syncAdvanced();
                box.appendChild(toggle);
                const fields = [
                  ['模拟次数上限', 'simulations', 5000],
                  ['最大搜索深度', 'maxDepth', 2000],
                  ['隐藏信息粒子数', 'particles', 4]
                ];
                fields.forEach(([label, key, fallback]) => {
                  const field = el('label', 'seat-mcts-field');
                  field.innerHTML = '<span>' + label + '</span>';
                  const input = document.createElement('input');
                  input.type = 'number'; input.min = '1'; input.step = '1'; input.placeholder = '自动';
                  const current = neural ? cfg : (cfg.advanced || {});
                  const roomValue = st.config && st.config['mcts' + key[0].toUpperCase() + key.slice(1)];
                  input.value = current[key] == null ? (neural ? String(roomValue == null ? fallback : roomValue) : '') : String(current[key]);
                  input.onchange = () => {
                    if (!input.checkValidity()) { input.reportValidity(); return; }
                    if (neural) sendSearchConfig({ advancedEnabled: true, [key]: input.value || fallback });
                    else {
                      const values = Object.assign({}, cfg.advanced);
                      if (input.value.trim() === '') delete values[key];
                      else values[key] = input.value;
                      sendSearchConfig({ advancedEnabled: true, advanced: values });
                    }
                  };
                  field.appendChild(input); advanced.appendChild(field);
                });
                advanced.appendChild(el('span', 'hint seat-mcts-title', '展开时使用手动参数；收起后按时间预算自动搜索并调整深度。'));
                box.appendChild(advanced); ops.appendChild(box);
              }
            }
            d.appendChild(ops);
          }
          grid.appendChild(d);
        });
        $('#btn-net-start').style.display = amHost ? '' : 'none';
        $('#btn-net-shuffle').style.display = amHost ? '' : 'none';
      }

      /* ============================== 屏幕切换 ============================== */
      function showScreen(name) {
        const map = { home: 'screen-home', setup: 'screen-setup', lobby: 'screen-lobby', scenarios: 'screen-scenarios' };
        $$('.screen').forEach(s => s.classList.remove('active'));
        const id = map[name];
        if (id) { const node = $('#' + id); if (node) node.classList.add('active'); }
        if (name === 'game') host.removeAttribute('data-active');
        else host.setAttribute('data-active', '');
        document.documentElement.setAttribute('data-lobby-screen', name);
      }

      function syncThemeOptions() {
        const tm = window.CitadelThemeManager;
        const cur = document.documentElement.getAttribute('data-theme') || (tm && tm.current) || 'neon';
        $$('[data-theme-choice]').forEach(b => {
          const on = b.getAttribute('data-theme-choice') === cur;
          b.classList.toggle('selected', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }

      /* ============================== 对局接管 ============================== */
      let started = false;
      let pendingGameState = null;
      let gameStartCallback = host.onGameStart;
      Object.defineProperty(host, 'onGameStart', {
        configurable: true,
        get: () => gameStartCallback,
        set(callback) {
          gameStartCallback = callback;
          if (pendingGameState && typeof callback === 'function') handOver(pendingGameState);
        }
      });
      function handOver(state) {
        if (started) return;
        App.state = state;
        if (state && state.you) App.myId = state.you;
        // 自动恢复可能早于 app.js/mobile.js 加载完成。此时继续由大厅
        // 接收状态和发送心跳，等页面注册渲染回调后再交出最新状态。
        if (typeof gameStartCallback !== 'function') {
          pendingGameState = state;
          return;
        }
        pendingGameState = null;
        started = true;
        // 交出 socket：停心跳、清重连定时器、卸下自己的消息处理，页面接管 onmessage。
        Net.handedOver = true;
        Net.stopHeartbeat();
        clearTimeout(Net.reconnectTimer); Net.reconnectTimer = null;
        const ws = Net.ws;
        if (ws) ws.onmessage = null;
        showScreen('game');
        const cb = host.onGameStart;
        if (typeof cb === 'function') {
          try {
            cb({ ws: ws, send: o => Net.send(o), myId: App.myId, roomId: Net.roomId, name: Net.name,
                 state: state, localServerGame: !!App.localServerGame });
          } catch (err) {
            console.error('Citadels game handover failed', err);
            toast('对局界面加载失败，请刷新页面重试');
          }
        }
      }

      function returnToHome() {
        // 让服务器先把我们移出房间，避免页面把界面收起后仍收到对局 state。
        // 保留本地恢复令牌，玩家可以从主菜单输入原房间号重新认领座位。
        if (Net.ws && Net.ws.readyState === 1 && Net.roomId) Net.send({ t: 'leaveRoom' });
        Net.roomId = null;
        Net.handedOver = false;
        Net.startGameRequested = false;
        started = false;
        pendingGameState = null;
        App.state = null; App.myId = null; App.leavingNetGame = false;
        App.localServerGame = false; App.lobbyState = null;
        Net.attach();                                   // 收回 socket 的消息处理
        if (Net.ws && Net.ws.readyState === 1) Net.startHeartbeat();
        $('#lobby-pre').hidden = false; $('#lobby-room').hidden = true;
        $('#lobby-title').textContent = '联机大厅';
        showScreen('home');
      }
      host.returnToHome = returnToHome;

      // 结算后「返回房间」时由页面调用：收回 socket，
      // 直接显示大厅房间，房主可以再开一局。
      host.returnToLobby = function (state) {
        App.localServerGame = false;
        Net.autoStart = true;
        Net.startGameRequested = false;
        Net.handedOver = false;
        started = false;
        pendingGameState = null;
        Net.attach();
        if (Net.ws && Net.ws.readyState === 1) Net.startHeartbeat();
        if (state) {
          App.state = state;
          if (state.you) App.myId = state.you;
          renderLobbyRoom(state);
        }
        showScreen('lobby');
      };

      // 对局中断线：socket 已交给页面，页面（mobile.js）检测到断开后调用它重连。
      // 复位 handedOver/started，重连成功后 handle() 会再次 handOver 并回调 onGameStart。
      host.reconnect = function () {
        Net.handedOver = false;
        started = false;
        Net.connect(() => Net.send({ t: 'listRooms' }));
      };

      /* ============================== 事件绑定 ============================== */
      function openExtra(kind) {
        /* 一览、规则与控制台入口交由宿主页面处理：
           composed 事件可穿越 Shadow 边界，页面监听 citadels-extra 打开自己的弹层。 */
        host.dispatchEvent(new CustomEvent('citadels-extra', {
          detail: { kind: kind }, bubbles: true, composed: true
        }));
      }

      host.startDebugGame = function (state) {
        const players = state && state.players;
        if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
          toast('调试对局需要 2–8 名玩家'); return;
        }
        App.localServerGame = true;
        App.mode = 'net'; App.leavingNetGame = false;
        App.state = null; App.myId = null; App.noticeSeen = 0;
        App.botDebugEntries = [];
        clearGameBoardView();
        Net.name = players[0].name || '调试玩家';
        Net.debugState = state;
        Net.startGameRequested = false;
        Net.autoStart = true;
        Net.connect(() => Net.send({ t: 'createRoom', name: Net.name, config: {
          playerCount: players.length, bots: 0, botType: 'npc', botLevel: 'hard',
          endDistricts: Number((state.config || {}).endDistricts) || 8,
          charSetMode: 'base', autoHost: false, voice: false
        }}), { resume: false });
      };

      ['#cfg-server', '#net-server'].forEach(sel => {
        const input = $(sel);
        if (!input) return;
        input.value = selectedGameServer;
        input.onchange = () => {
          selectedGameServer = input.value.trim();
          try { localStorage.setItem('citadels.gameServer', selectedGameServer); } catch (_) { /* storage unavailable */ }
          ['#cfg-server', '#net-server'].forEach(other => { const node = $(other); if (node) node.value = selectedGameServer; });
        };
      });

      const TM = window.CitadelThemeManager;
      if (TM && typeof TM.onChange === 'function') TM.onChange(() => { syncHostTheme(); syncThemeOptions(); });
      $$('[data-theme-choice]').forEach(b => b.onclick = () => {
        if (TM && typeof TM.apply === 'function') TM.apply(b.getAttribute('data-theme-choice'));
        syncHostTheme(); syncThemeOptions();
      });

      $$('[data-goto]').forEach(b => b.onclick = () => {
        const target = b.dataset.goto;
        if (target === 'home' && Net.roomId) {
          Net.send({ t: 'leaveRoom' });
          if (App.lobbyState) forgetPlayerSession(Net.roomId);
          Net.roomId = null;
          clearNetSession();
        }
        App.leavingNetGame = false;
        showScreen(target);
      });

      $('#btn-single').onclick = () => showScreen('setup');
      $('#btn-debug-game').onclick = () => openExtra('debug-game');
      $('#btn-online').onclick = () => {
        App.leavingNetGame = false;
        showScreen('lobby');
        Net.name = $('#net-name').value || '玩家';
        Net.connect(() => { Net.send({ t: 'listRooms' }); });
      };
      $('#btn-rules').onclick = () => openExtra('rules');
      $('#btn-all-roles').onclick = () => openExtra('all-roles');
      $('#btn-all-buildings').onclick = () => openExtra('all-buildings');
      function renderScenarioReference() {
        const scenario = SCENARIOS.find(s => s.id === $('#scenario-reference-choice').value);
        if (!scenario) return;
        const cards = window.CitCards;
        const theme = window.CitadelThemeManager;
        const roles = scenario.characters.map(id => cards.CHAR_MAP[id]);
        const districts = cards.districtsForScenario(scenario.id).filter(d => d.color === 'purple');
        const renderCard = (card, role) => {
          const asset = theme && (role ? theme.roleAsset(card, 'thumb') : theme.districtAsset(card, 'thumb'));
          return '<article class="ref-card" data-scenario-card="' + escapeHtml(role ? card.id : card.en) + '">' +
            (asset ? '<img class="rc-art" src="' + escapeHtml(asset) + '" alt="' + escapeHtml(card.name) + '" loading="lazy" decoding="async">' : '') +
            '<h4>' + (role ? '<span class="rc-num">' + card.num + '</span>' : '') + escapeHtml(card.name) + '</h4>' +
            '<span class="rc-en">' + escapeHtml(card.en) + (role ? '' : ' · ' + card.cost + ' 金') + '</span>' +
            '<p>' + escapeHtml(card.desc || '') + '</p></article>';
        };
        $('#scenario-role-heading').textContent = '角色（' + roles.length + ' 张）';
        $('#scenario-district-heading').textContent = '独特建筑（' + districts.length + ' 张）';
        $('#scenario-reference-roles').innerHTML = roles.map(c => renderCard(c, true)).join('');
        $('#scenario-reference-districts').innerHTML = districts.map(c => renderCard(c, false)).join('');
      }
      $('#btn-scenarios').onclick = () => { renderScenarioReference(); showScreen('scenarios'); };
      $('#scenario-reference-choice').onchange = renderScenarioReference;
      if (TM && typeof TM.onChange === 'function') TM.onChange(() => {
        if ($('#screen-scenarios').classList.contains('active')) renderScenarioReference();
      });
      if ($('#btn-server-console')) $('#btn-server-console').onclick = () => openExtra('console');
      if ($('#btn-server-startup')) $('#btn-server-startup').onclick = () => openExtra('startup');

      // 搜索预算默认显示，详细参数由高级选项按钮控制。
      const botTypeSel = $('#cfg-bot-type');
      if (botTypeSel) botTypeSel.onchange = syncSearchFields;
      $('#cfg-advanced-toggle').onclick = () => {
        singleAdvancedOpen = !singleAdvancedOpen;
        syncSearchFields();
      };
      syncSearchFields();

      $('#btn-start-single').onclick = () => {
        const botSelection = normalizeBotSelection($('#cfg-bot-type').value);
        const cfg = {
          players: Number($('#cfg-players').value),
          level: botSelection.botLevel,
          botType: botSelection.botType,
          end: Number($('#cfg-end').value),
          chars: $('#cfg-chars').value,
          scenario: $('#cfg-scenario').value,
          customRoleSelections,
          name: ($('#cfg-name').value || '我').trim()
        };
        App.lastCfg = cfg; App.mode = 'net'; App.localServerGame = true; App.name = cfg.name;
        startPythonSingle(cfg);
      };

      // 联机
      $('#btn-create').onclick = async () => {
        App.localServerGame = false;
        App.leavingNetGame = false;
        Net.name = ($('#net-name').value || '玩家').trim();
        Net.connect(() => {
          Net.send({
            t: 'createRoom', name: Net.name, config: Object.assign({
              playerCount: Number($('#net-players').value),
              teamMode: $('#net-team-mode').value === 'on',
              endDistricts: Number($('#net-end').value),
              charSetMode: $('#net-chars').value,
              customRoleSelections,
              scenario: $('#net-scenario').value,
              autoHost: $('#net-auto-host').value === 'on',
              voice: $('#net-voice').value === 'on'
            })
          });
        });
        App.mode = 'net';
      };
      $('#btn-join').onclick = () => {
        App.leavingNetGame = false;
        const code = ($('#net-code').value || '').trim().toUpperCase();
        if (code.length !== 4) { toast('请输入 4 位房间号'); return; }
        App.localServerGame = false;
        Net.name = ($('#net-name').value || '玩家').trim();
        const saved = loadPlayerSession(code);
        const resumeToken = saved && saved.token;
        Net.recoveringRoomId = resumeToken ? code : null;
        // Force a fresh handshake so the entered room's saved credential is
        // checked before falling back to an ordinary room-code join.
        Net.connect(() => {
          if (resumeToken) {
            Net.recoveringRoomId = null;
            toast('未能恢复原玩家席位，请确认房间仍是原来的对局；如需旁观，请点击观战');
            return;
          }
          Net.send({ t: 'joinRoom', roomId: code, name: Net.name });
        }, resumeToken ? { forceReconnect: true, session: saved } : { resume: false, forceReconnect: true });
        App.mode = 'net';
      };
      $('#btn-refresh').onclick = () => Net.send({ t: 'listRooms' });
      $('#btn-spectate').onclick = () => {
        const code = ($('#net-code').value || '').trim().toUpperCase();
        if (code.length !== 4) { toast('请输入 4 位房间号'); return; }
        App.leavingNetGame = false;
        App.localServerGame = false;
        Net.recoveringRoomId = null;
        Net.name = ($('#net-name').value || '观众').trim();
        Net.connect(() => Net.send({ t:'spectateRoom', roomId:code, name:Net.name }), {resume:false});
        App.mode = 'net';
      };
      $('#btn-leave').onclick = () => {
        App.lobbyState = null;
        Net.send({ t: 'leaveRoom' });
        forgetPlayerSession(Net.roomId);
        Net.roomId = null;
        clearNetSession();
        $('#lobby-pre').hidden = false; $('#lobby-room').hidden = true;
        $('#lobby-title').textContent = '联机大厅';
        Net.send({ t: 'listRooms' });
      };
      $('#btn-net-start').onclick = () => Net.send({ t: 'startGame' });
      $('#btn-net-shuffle').onclick = () => Net.send({ t: 'shuffleSeats' });
      ['cfg', 'net'].forEach(prefix => {
        $('#' + prefix + '-scenario').onchange = () => syncScenarioChoice(prefix);
        $('#' + prefix + '-chars').onchange = () => syncScenarioChoice(prefix);
        syncScenarioChoice(prefix);
      });
      renderRolePickers();
      $('#r-chars').onchange = () => { syncScenarioChoice('r', !!(App.lobbyState && App.lobbyState.seats[0] && App.lobbyState.seats[0].id === App.myId)); sendRoomConfig(); };
      $('#r-scenario').onchange = () => { syncScenarioChoice('r', !!(App.lobbyState && App.lobbyState.seats[0] && App.lobbyState.seats[0].id === App.myId)); sendRoomConfig(); };
      ['r-players', 'r-team-mode', 'r-end', 'r-chars', 'r-voice', 'r-scenario'].forEach(id => {
        if (id === 'r-chars' || id === 'r-scenario') return;
        const node = $('#' + id);
        if (!node) return;
        node.onchange = () => {
          Net.send({
            t: 'config', config: {
              playerCount: Number($('#r-players').value),
              teamMode: $('#r-team-mode').value === 'on',
              endDistricts: Number($('#r-end').value),
              charSetMode: $('#r-chars').value,
              customRoleSelections,
              scenario: $('#r-scenario').value,
              voice: $('#r-voice').value === 'on'
            }
          });
        };
      });
      ['net', 'r'].forEach(prefix => {
        const mode = $('#' + prefix + '-team-mode');
        mode.onchange = () => {
          syncTeamPlayerOptions(prefix);
          if (prefix === 'r') sendRoomConfig();
        };
        syncTeamPlayerOptions(prefix);
      });

      /* ----- 初始状态：镜像主题、显示首页、尝试用本地会话恢复 ----- */
      syncHostTheme();
      syncThemeOptions();
      showScreen('home');
      loadHomeVersion();

      const savedNetSession = loadNetSession();
      if (savedNetSession) {
        App.mode = 'net';
        Net.name = savedNetSession.name || '玩家';
        Net.connect(() => Net.send({ t: 'listRooms' }));
      }
    }
  }

  if (!customElements.get('c-citadels-lobby')) {
    customElements.define('c-citadels-lobby', CCitadelsLobby);
  }
})();
