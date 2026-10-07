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
 *       回到主菜单/离开对局时由页面调用，组件回收 socket、清会话、回首页。
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
      <button class="mode-card" id="btn-rules">
        <div class="mode-icon">≡</div>
        <div class="mode-name">规则速查</div>
        <div class="mode-tip">角色能力、建筑效果与计分方式</div>
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
      <label class="field" hidden>
        <span>电脑难度（兼容旧配置）</span>
        <select id="cfg-level">
          <option value="easy">简单</option>
          <option value="normal" selected>普通</option>
          <option value="hard">困难</option>
        </select>
      </label>
      <label class="field">
        <span>电脑类型</span>
        <select id="cfg-bot-type">
          <option value="npc-easy">启发式电脑 · 简单</option>
          <option value="npc-normal">启发式电脑 · 普通</option>
          <option value="npc-hard" selected>启发式电脑 · 困难（MCTS）</option>
          <option value="neural">策略神经网络（仓库自带权重）</option>
          <option value="agent">AI Agent 电脑（大模型决策，需要联网）</option>
        </select>
      </label>
      <label class="field neural-only" hidden>
        <span>MCTS 模拟次数（0 = 关闭）</span>
        <input id="cfg-mcts-sims" type="number" min="0" step="50" value="500" inputmode="numeric">
      </label>
      <label class="field neural-only" hidden>
        <span>MCTS 最大搜索深度（0 = 自动 700）</span>
        <input id="cfg-mcts-depth" type="number" min="0" step="10" value="700" inputmode="numeric">
      </label>
      <label class="field neural-only" hidden>
        <span>MCTS 隐藏信息粒子数</span>
        <input id="cfg-mcts-particles" type="number" min="1" step="1" value="4" inputmode="numeric">
      </label>
      <p class="dim small neural-only mcts-hint" hidden>策略神经网络电脑默认只按网络策略走子。填大于 0 的模拟次数后，服务器会在指定份数的隐藏信息猜测上做蒙特卡洛树搜索，粒子越多越稳但每步越慢。</p>
      <label class="field">
        <span>电脑节奏</span>
        <select id="cfg-speed">
          <option value="slow">慢速（看得最清楚）</option>
          <option value="normal" selected>标准</option>
          <option value="fast">快速（老手）</option>
        </select>
      </label>
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
        </select>
      </label>
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
          <p class="dim small">电脑座位和策略网络参数在创建房间后，分别设置在对应的座位卡片内。</p>
          <label class="field"><span>结束条件</span>
            <select id="net-end"><option value="8" selected>建成 8 栋</option><option value="7">建成 7 栋（加快）</option></select>
          </label>
          <label class="field"><span>角色组</span>
            <select id="net-chars"><option value="base" selected>基本版</option><option value="dark">黑暗城市扩充</option><option value="mixed">加强版混合</option></select>
          </label>
          <label class="field voice-capable" hidden><span>房间语音</span>
            <select id="net-voice"><option value="on" selected>开启</option><option value="off">关闭</option></select>
          </label>
          <p class="dim small voice-capable" hidden>语音由 LiveKit 转发音频，真人座位之间可实时通话；电脑座位不参与语音。</p>
          <button class="btn primary block" id="btn-create">创建房间</button>
        </div>
        <div class="lobby-box">
          <h3>加入房间</h3>
          <label class="field"><span>房间编号</span><input id="net-code" type="text" placeholder="4 位房号" maxlength="4" autocomplete="off"></label>
          <button class="btn primary block" id="btn-join">加入</button>
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
          <label class="field inline"><span>结束</span>
            <select id="r-end"><option value="8" selected>8 栋</option><option value="7">7 栋</option></select></label>
          <label class="field inline"><span>角色</span>
            <select id="r-chars"><option value="base" selected>基本版</option><option value="dark">黑暗扩充</option><option value="mixed">混合</option></select></label>
          <label class="field inline voice-capable" hidden><span>语音</span>
            <select id="r-voice"><option value="on" selected>开</option><option value="off">关</option></select></label>
        </div>
      </div>
      <div class="seat-grid" id="seat-grid"></div>
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
        speed: 'normal',       // 电脑行动节奏：slow | normal | fast
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
      function saveNetSession(token, roomId, name) {
        if (!token || !roomId) return;
        try {
          window.localStorage.setItem(NET_SESSION_KEY,
            JSON.stringify({ token: token, roomId: roomId, name: name || '', server: gameServerBase() }));
        } catch (e) { /* 隐私模式或存储被禁用 */ }
      }
      function clearNetSession() {
        try { window.localStorage.removeItem(NET_SESSION_KEY); } catch (e) { /* ignore */ }
      }

      /* --------------------------- 电脑行动节奏 --------------------------- */
      const PACE = {
        slow:   { draft: 1700, big: 2100, act: 1300, min: 700, label: '慢速' },
        normal: { draft: 1050, big: 1300, act: 820,  min: 430, label: '标准' },
        fast:   { draft: 420,  big: 480,  act: 330,  min: 190, label: '快速' }
      };
      const SPEED_ORDER = ['slow', 'normal', 'fast'];
      PACE.slow.label = '慢速';
      PACE.normal.label = '标准';
      PACE.fast.label = '快速';

      function loadSpeed() {
        let v = null;
        try { v = window.localStorage.getItem('citadels.speed'); } catch (e) { /* 隐私模式 */ }
        App.speed = PACE[v] ? v : 'normal';
      }
      function saveSpeed() {
        try { window.localStorage.setItem('citadels.speed', App.speed); } catch (e) { /* 忽略 */ }
      }
      function pace() { return PACE[App.speed] || PACE.normal; }

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
      const DEFAULT_MCTS_CONFIG = { simulations: 500, maxDepth: 700, particles: 4 };
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
      function syncNeuralOnlyFields() {
        [['#screen-setup', '#cfg-bot-type']].forEach(pair => {
          const root = $(pair[0]);
          const select = $(pair[1]);
          if (!root || !select) return;
          const show = select.value === 'neural';
          Array.from(root.querySelectorAll('.neural-only')).forEach(node => { node.hidden = !show; });
          if (show) {
            const defaults = [
              ['#cfg-mcts-sims', DEFAULT_MCTS_CONFIG.simulations], ['#cfg-mcts-depth', DEFAULT_MCTS_CONFIG.maxDepth],
              ['#cfg-mcts-particles', DEFAULT_MCTS_CONFIG.particles]
            ];
            defaults.forEach(([id, value]) => { const input = $(id); if (input && String(input.value).trim() === '') input.value = String(value); });
          }
        });
      }
      const HEURISTIC_BOT_LEVELS = { 'npc-easy': 'easy', 'npc-normal': 'normal', 'npc-hard': 'hard' };
      function normalizeBotSelection(type, fallbackLevel) {
        const level = HEURISTIC_BOT_LEVELS[type];
        if (level) return { botType: 'npc', botLevel: level };
        return {
          botType: type === 'agent' || type === 'neural' ? type : 'npc',
          botLevel: ['easy', 'normal', 'hard'].includes(fallbackLevel) ? fallbackLevel : 'hard'
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
        App.state = null; App.myId = null; App.noticeSeen = 0;
        App.botDebugEntries = [];
        clearGameBoardView();
        Net.name = cfg.name;
        Net.connect(() => {
          Net.autoStart = true;
          Net.send({ t: 'createRoom', name: cfg.name, config: Object.assign({
            playerCount: cfg.players, bots: cfg.players - 1, botType: cfg.botType, botLevel: cfg.level,
            endDistricts: cfg.end, charSetMode: cfg.chars, botPace: pace().act, voice: false
          }, readMctsConfig('#cfg-mcts-sims', '#cfg-mcts-depth', '#cfg-mcts-particles')) });
        });
      }

      /* ============================== 联机驱动（开局前） ============================== */
      const Net = {
        autoStart: false,
        ws: null, myId: null, roomId: null, name: '', onState: null, afterHello: null,
        reconnectTimer: null, reconnectDelay: 1000, heartbeatTimer: null,
        handedOver: false,   // 已把 socket 交给页面接管
        startHeartbeat() {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) this.send({ t: 'heartbeat', ts: Date.now() });
          }, 5000);
        },
        stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; },
        connect(cb) {
          let endpoint;
          try { endpoint = gameServerBase().replace(/^http/, 'ws'); }
          catch (e) { this.afterHello = null; toast(e.message); return; }
          if (this.ws && this.ws.readyState === 1 && this.ws.url.replace(/\/$/, '') === endpoint) return cb && cb();
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
            const saved = loadNetSession();
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
              this.myId = m.youId; this.roomId = m.roomId;
              if (m.resumeToken) saveNetSession(m.resumeToken, m.roomId, this.name);
              App.myId = m.youId;
              App.botDebugEntries = [];
              if (App.botDebugOpen) renderBotDebug();
              // 大厅里加入 → 从 0 开始；中途加入 → 对齐进度，不回放历史
              App.noticeSeen = (m.state.notices && m.state.notices.length)
                ? m.state.notices[m.state.notices.length - 1].seq : 0;
              App.paused = false; hideEvent(true);
              if (m.state.phase === 'lobby') {
                if (!App.localServerGame) { renderLobbyRoom(m.state); showScreen('lobby'); }
                if (this.autoStart) { this.autoStart = false; this.send({ t: 'startGame' }); }
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
                this.send({ t: 'startGame' });
              } else if (m.state.phase === 'lobby') {
                App.chatHistory = [];
                renderLobbyRoom(m.state); showScreen('lobby');
              } else {
                handOver(m.state);
              }
              break;
            case 'error': this.autoStart = false; toast('✗ ' + m.error); break;
          }
        }
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
          box.appendChild(d);
        });
      }

      function renderLobbyRoom(st) {
        App.lobbyState = st;
        $('#lobby-pre').hidden = true;
        $('#lobby-room').hidden = false;
        $('#r-code').textContent = st.roomId;
        $('#lobby-title').textContent = '房间 ' + st.roomId;
        if (st.config) {
          $('#r-players').value = String(st.config.playerCount || 4);
          $('#r-end').value = String(st.config.endDistricts || 8);
          $('#r-chars').value = st.config.charSetMode || 'base';
          $('#r-voice').value = st.config.voice === false ? 'off' : 'on';
        }
        voiceSync();
        const grid = $('#seat-grid');
        grid.innerHTML = '';
        const seats = st.seats || [];
        const amHost = seats.length && seats[0].id === App.myId;
        seats.forEach((s, i) => {
          const d = el('div', 'seat' + (s.taken ? ' taken' : '') + (s.id === App.myId ? ' me' : ''));
          const heuristicLabel = s.botLevel === 'easy' ? '启发式电脑 · 简单' : s.botLevel === 'hard' ? '启发式电脑 · 困难' : '启发式电脑 · 普通';
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
              type.innerHTML = '<option value="npc-easy">启发式电脑 · 简单</option><option value="npc-normal">启发式电脑 · 普通</option><option value="npc-hard">启发式电脑 · 困难</option><option value="neural">策略神经网络（仓库权重）</option><option value="agent">AI Agent（模型）</option>';
              type.value = s.botType === 'npc' ? 'npc-' + (s.botLevel || 'normal') : (s.botType || 'npc-normal');
              type.onchange = () => Net.send({ t: 'setSeat', index: i, kind: 'bot', botType: type.value });
              ops.appendChild(type);
              if (s.botType === 'neural') {
                const mcts = s.mcts || {};
                const box = el('div', 'seat-mcts');
                box.innerHTML = '<span class="seat-mcts-title">MCTS 参数</span>';
                const fields = [
                  ['模拟次数', 'simulations', 500, 0, 50],
                  ['最大深度', 'maxDepth', 700, 0, 10],
                  ['粒子数', 'particles', 4, 1, 1]
                ];
                fields.forEach(([label, key, fallback, min, step]) => {
                  const field = el('label', 'seat-mcts-field');
                  field.innerHTML = '<span>' + label + '</span>';
                  const input = document.createElement('input');
                  input.type = 'number'; input.min = String(min); input.step = String(step);
                  const roomValue = st.config && st.config['mcts' + key[0].toUpperCase() + key.slice(1)];
                  input.value = String(mcts[key] == null ? (roomValue == null ? fallback : roomValue) : mcts[key]);
                  input.onchange = () => {
                    const current = s.mcts || {};
                    Net.send({ t: 'setSeat', index: i, kind: 'bot', botType: type.value, mcts: {
                      simulations: key === 'simulations' ? input.value : current.simulations == null ? 500 : current.simulations,
                      maxDepth: key === 'maxDepth' ? input.value : current.maxDepth == null ? 700 : current.maxDepth,
                      particles: key === 'particles' ? input.value : current.particles == null ? 4 : current.particles
                    }});
                  };
                  field.appendChild(input); box.appendChild(field);
                });
                ops.appendChild(box);
              }
              if (s.botType === 'npc' && s.botLevel === 'hard') {
                const cfg = s.heuristicMcts || {};
                const box = el('div', 'seat-mcts heuristic-mcts');
                box.innerHTML = '<span class="seat-mcts-title">启发式 MCTS</span>';
                const field = el('label', 'seat-mcts-field');
                field.innerHTML = '<span>搜索时间预算 ms</span>';
                const input = document.createElement('input');
                input.type = 'number'; input.min = '1'; input.step = '1';
                input.value = String(cfg.timeBudgetMs == null ? 10000 : cfg.timeBudgetMs);
                input.onchange = () => {
                  if (!input.checkValidity()) { input.reportValidity(); return; }
                  Net.send({ t: 'setSeat', index: i, kind: 'bot', botType: type.value,
                    heuristicMcts: { timeBudgetMs: input.value } });
                };
                field.appendChild(input); box.appendChild(field);
                box.appendChild(el('span', 'hint', '所有局面共用此预算；模拟次数随实际速度自适应，粒子数、深度和 rollout 自动配置。'));
                ops.appendChild(box);
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
        const map = { home: 'screen-home', setup: 'screen-setup', lobby: 'screen-lobby' };
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
      function handOver(state) {
        if (started) return;
        started = true;
        App.state = state;
        if (state && state.you) App.myId = state.you;
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
            cb({ ws: ws, send: o => Net.send(o), myId: App.myId, roomId: Net.roomId, name: Net.name, state: state });
          } catch (err) { /* 页面接管后的异常不应影响大厅 */ }
        }
      }

      function returnToHome() {
        // 让服务器先把我们移出房间，避免页面把界面收起后仍收到对局 state。
        if (Net.ws && Net.ws.readyState === 1 && Net.roomId) Net.send({ t: 'leaveRoom' });
        clearNetSession();
        Net.roomId = null;
        Net.handedOver = false;
        started = false;
        App.state = null; App.myId = null; App.leavingNetGame = false;
        App.localServerGame = false; App.lobbyState = null;
        Net.attach();                                   // 收回 socket 的消息处理
        if (Net.ws && Net.ws.readyState === 1) Net.startHeartbeat();
        $('#lobby-pre').hidden = false; $('#lobby-room').hidden = true;
        $('#lobby-title').textContent = '联机大厅';
        showScreen('home');
      }
      host.returnToHome = returnToHome;

      // 对局中断线：socket 已交给页面，页面（mobile.js）检测到断开后调用它重连。
      // 复位 handedOver/started，重连成功后 handle() 会再次 handOver 并回调 onGameStart。
      host.reconnect = function () {
        Net.handedOver = false;
        started = false;
        Net.connect(() => Net.send({ t: 'listRooms' }));
      };

      /* ============================== 事件绑定 ============================== */
      function openExtra(kind) {
        /* PC 专属入口（规则速查 / 服务器控制台 / 启动信息）交由宿主页面处理：
           composed 事件可穿越 Shadow 边界，页面监听 citadels-extra 打开自己的弹层。 */
        host.dispatchEvent(new CustomEvent('citadels-extra', {
          detail: { kind: kind }, bubbles: true, composed: true
        }));
      }

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
          Net.roomId = null;
          clearNetSession();
        }
        App.leavingNetGame = false;
        showScreen(target);
      });

      $('#btn-single').onclick = () => showScreen('setup');
      $('#btn-online').onclick = () => {
        App.leavingNetGame = false;
        showScreen('lobby');
        Net.name = $('#net-name').value || '玩家';
        Net.connect(() => { Net.send({ t: 'listRooms' }); });
      };
      $('#btn-rules').onclick = () => openExtra('rules');
      if ($('#btn-server-console')) $('#btn-server-console').onclick = () => openExtra('console');
      if ($('#btn-server-startup')) $('#btn-server-startup').onclick = () => openExtra('startup');

      // 电脑节奏：设置页下拉
      loadSpeed();
      if ($('#cfg-speed')) {
        $('#cfg-speed').value = App.speed;
        $('#cfg-speed').onchange = () => {
          App.speed = PACE[$('#cfg-speed').value] ? $('#cfg-speed').value : 'normal';
          saveSpeed();
        };
      }

      // MCTS 参数只在电脑类型选「策略神经网络」时才露出来
      const botTypeSel = $('#cfg-bot-type');
      if (botTypeSel) botTypeSel.onchange = syncNeuralOnlyFields;
      syncNeuralOnlyFields();

      $('#btn-start-single').onclick = () => {
        const botSelection = normalizeBotSelection($('#cfg-bot-type').value, $('#cfg-level').value);
        const cfg = {
          players: Number($('#cfg-players').value),
          level: botSelection.botLevel,
          botType: botSelection.botType,
          end: Number($('#cfg-end').value),
          chars: $('#cfg-chars').value,
          name: ($('#cfg-name').value || '我').trim()
        };
        if ($('#cfg-speed') && PACE[$('#cfg-speed').value]) {
          App.speed = $('#cfg-speed').value; saveSpeed();
        }
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
              endDistricts: Number($('#net-end').value),
              charSetMode: $('#net-chars').value,
              botPace: pace().act,
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
        Net.connect(() => Net.send({ t: 'joinRoom', roomId: code, name: Net.name }));
        App.mode = 'net';
      };
      $('#btn-refresh').onclick = () => Net.send({ t: 'listRooms' });
      $('#btn-leave').onclick = () => {
        App.lobbyState = null;
        Net.send({ t: 'leaveRoom' });
        clearNetSession();
        $('#lobby-pre').hidden = false; $('#lobby-room').hidden = true;
        $('#lobby-title').textContent = '联机大厅';
        Net.send({ t: 'listRooms' });
      };
      $('#btn-net-start').onclick = () => Net.send({ t: 'startGame' });
      $('#btn-net-shuffle').onclick = () => Net.send({ t: 'shuffleSeats' });
      ['r-players', 'r-end', 'r-chars', 'r-voice'].forEach(id => {
        const node = $('#' + id);
        if (!node) return;
        node.onchange = () => {
          Net.send({
            t: 'config', config: {
              playerCount: Number($('#r-players').value),
              endDistricts: Number($('#r-end').value),
              charSetMode: $('#r-chars').value,
              voice: $('#r-voice').value === 'on'
            }
          });
        };
      });

      /* ----- 初始状态：镜像主题、显示首页、尝试用本地会话恢复 ----- */
      syncHostTheme();
      syncThemeOptions();
      showScreen('home');

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
