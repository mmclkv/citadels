/* =========================================================================
 * 富饶之城 — 客户端
 * 支持：本地单人（与电脑对战，引擎跑在浏览器里） / 联机（引擎跑在服务器）
 * ========================================================================= */
(function () {
  'use strict';
  const Cards = window.CitCards, Engine = window.CitEngine, AI = window.CitAI;

  /* ============================== 全局状态 ============================== */
  const App = {
    mode: null,            // 'local' | 'net'
    state: null,
    myId: null,
    name: '我',
    sel: null,             // 选择模式
    logOpen: true,
    lastCfg: null,
    speed: 'normal',       // 电脑行动节奏：slow | normal | fast
    paused: false,         // 事件弹层展示期间暂停电脑行动
    noticeSeen: null,      // 已展示到第几条关键事件（seq）
    _reveal: {},           // 每位玩家上一帧的角色卡状态，用于检测「盖牌→翻面」触发动画
    myIdx: null
  };

  /* --------------------------- 电脑行动节奏 ---------------------------
   * 原先固定 330ms，真人根本来不及看清电脑做了什么。
   * 现在按「这一步有多值得看」分级停顿：
   *   draft  选角（信息量大，要看清谁拿了什么）
   *   big    宣告刺杀/施咒、建造、摧毁抢夺（关键局势变化）
   *   act    领资源、用能力、结束回合
   *   min    其它内部推进步骤
   * ------------------------------------------------------------------ */
  const PACE = {
    slow:   { draft: 1700, big: 2100, act: 1300, min: 700, label: '🐢 慢速' },
    normal: { draft: 1050, big: 1300, act: 820,  min: 430, label: '⏱ 标准' },
    fast:   { draft: 420,  big: 480,  act: 330,  min: 190, label: '⚡ 快速' }
  };
  const SPEED_ORDER = ['slow', 'normal', 'fast'];

  function loadSpeed() {
    let v = null;
    try { v = window.localStorage.getItem('citadels.speed'); } catch (e) { /* 隐私模式 */ }
    App.speed = PACE[v] ? v : 'normal';
  }
  function saveSpeed() {
    try { window.localStorage.setItem('citadels.speed', App.speed); } catch (e) { /* 忽略 */ }
  }
  function pace() { return PACE[App.speed] || PACE.normal; }

  /** 电脑刚做完某个动作后应该停多久 */
  function botDelay(action) {
    const p = pace();
    if (!action) return p.min;
    switch (action.type) {
      case 'draft_pick': case 'draft_discard':
        return p.draft;
      case 'choose_char':                       // 宣告刺杀 / 偷窃 / 施咒
      case 'build':
      case 'warlord_destroy': case 'marshal_seize':
        return p.big;
      case 'choose_district': case 'choose_player': case 'choose_cards':
        return p.big;
      case 'income': case 'take_gold': case 'take_cards':
      case 'ability': case 'end_turn': case 'ability_skip':
        return p.act;
      default:
        return p.min;
    }
  }

  function syncSpeedBtn() {
    const b = $('#btn-speed');
    if (!b) return;
    b.textContent = pace().label;
    b.title = App.mode === 'net'
      ? '点击切换服务器上电脑的行动速度'
      : '点击切换电脑行动速度';
  }
  function cycleSpeed() {
    const i = SPEED_ORDER.indexOf(App.speed);
    App.speed = SPEED_ORDER[(i + 1) % SPEED_ORDER.length];
    saveSpeed(); syncSpeedBtn();
    toast('电脑节奏：' + pace().label.replace(/^\S+\s*/, ''));
    if (App.mode === 'local') Local.reschedule();
    else if (App.mode === 'net') Net.send({ t: 'setPace', pace: pace().act });
  }

  /* ============================== 工具 ============================== */
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ---------------------- 移动端（触屏）适配 ---------------------- */
  /** 触屏设备：没有真正的 hover。浏览器会把 tap 合成为 mouseover/mousemove，
   *  导致"悬浮放大浮窗"在手机上乱弹并干扰点击，这类设备要禁用悬浮相关的交互。 */
  function isTouchDevice() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
      return window.matchMedia('(hover: none)').matches ||
             window.matchMedia('(pointer: coarse)').matches;
    } catch (e) { return false; }
  }

  /** 统一的点击绑定：桌面仍用 click；触屏改用 touchend 立即响应，
   *  并阻止后续合成的 mouse 事件（避免弹出 hover 浮窗）与 300ms 点击延迟。 */
  function onTap(node, fn) {
    if (!node) return;
    if (typeof window === 'undefined' || !isTouchDevice()) { node.onclick = fn; return; }
    let sx = 0, sy = 0, moved = false;
    node.addEventListener('touchstart', e => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      sx = t.clientX; sy = t.clientY; moved = false;
    }, { passive: true });
    node.addEventListener('touchmove', e => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) moved = true;
    }, { passive: true });
    node.addEventListener('touchend', e => {
      if (moved) return;                      // 判定为滑动（滚动页面），不当作点击
      if (e.cancelable) e.preventDefault();    // 阻止合成的 mouseover/click
      fn();
    }, { passive: false });
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#' + id).classList.add('active');
  }

  /* ======================= 关键事件提示（居中弹层） =======================
   * 「别人对我做了什么」这类事件（被刺杀 / 被施咒 / 被偷 / 建筑被摧毁抢走）
   * 原先只写进战报，真人经常整轮被跳过却毫不知情。
   * 现在的规则：涉及自己 → 居中弹层 + 暂停电脑行动；涉及别人 → 轻量 toast。
   * ==================================================================== */
  let evQueue = [];
  let evTimer = null, evBarTimer = null;

  function queueEvent(opt) {
    evQueue.push(opt);
    const ov = $('#event-overlay');
    if (!ov || ov.hidden) nextEvent();
  }

  function nextEvent() {
    const opt = evQueue.shift();
    if (!opt) { hideEvent(); return; }
    const ov = $('#event-overlay');
    $('#event-box').className = 'event-box tone-' + (opt.tone || 'info');
    $('#event-icon').textContent = opt.icon || 'ℹ️';
    $('#event-title').textContent = opt.title || '';
    $('#event-text').innerHTML = opt.text || '';
    $('#event-ok').textContent = evQueue.length ? '下一条（还有 ' + evQueue.length + '）' : '知道了，继续';
    ov.hidden = false;
    App.paused = true;                       // 读提示的时候电脑先别动

    const hold = opt.hold || 4200;
    const fill = $('#event-bar-fill');
    if (fill && fill.style) {
      fill.style.transition = 'none';
      fill.style.width = '100%';
      clearTimeout(evBarTimer);
      evBarTimer = setTimeout(() => {
        fill.style.transition = 'width ' + hold + 'ms linear';
        fill.style.width = '0%';
      }, 40);
    }
    clearTimeout(evTimer);
    evTimer = setTimeout(dismissEvent, hold);
  }

  function dismissEvent() {
    clearTimeout(evTimer); evTimer = null;
    if (evQueue.length) { nextEvent(); return; }
    hideEvent();
  }

  /** silent=true 时只关闭，不唤醒电脑循环（开局重置用） */
  function hideEvent(silent) {
    clearTimeout(evTimer); evTimer = null;
    clearTimeout(evBarTimer); evBarTimer = null;
    evQueue = [];
    const ov = $('#event-overlay');
    if (ov) ov.hidden = true;
    App.paused = false;
    if (!silent && App.mode === 'local') Local.resume();
  }

  /* -------------------- 读取引擎下发的关键事件并分发 -------------------- */
  function processNotices(s) {
    const list = s.notices || [];
    if (!list.length) return;
    const lastSeq = list[list.length - 1].seq;
    // noticeSeen 为 null 表示中途加入对局：只对齐进度，不回放历史事件
    if (App.noticeSeen == null) { App.noticeSeen = lastSeq; return; }
    const fresh = list.filter(n => n.seq > App.noticeSeen);
    App.noticeSeen = lastSeq;
    fresh.forEach(n => { try { handleNotice(n, s); } catch (e) { console.error(e); } });
  }

  function myChars(s) {
    const me = s.players.find(p => p.id === App.myId);
    return (me && me.chars) ? me.chars : [];
  }
  function myCharName(s, num) {
    const c = myChars(s).find(x => x.num === num);
    return c ? c.name : ('' + num + ' 号');
  }

  function handleNotice(n, s) {
    const holdsIt = myChars(s).some(c => c.num === n.num);
    const isMe = !!(n.playerId && n.playerId === App.myId);
    const byMe = !!(n.byId && n.byId === App.myId);

    switch (n.kind) {
      case 'assassin_declare':
        if (byMe) return;
        if (holdsIt) {
          App.deathWarned = n.round;
          queueEvent({
            tone: 'danger', icon: '🗡', title: '你被刺杀了！', hold: 6000,
            text: escapeHtml(n.byName) + ' 的【刺客】宣布刺杀 <b>' + n.num + ' 号角色</b>，' +
                  '正是你的『<b>' + escapeHtml(myCharName(s, n.num)) + '</b>』。<br>' +
                  '本轮叫到它时会<b>直接跳过</b>——不能领资源、不能建造、不能用能力。'
          });
        } else toast('🗡 ' + n.byName + ' 宣布刺杀 ' + n.num + ' 号角色');
        return;

      case 'witch_declare':
        if (byMe) return;
        if (holdsIt) {
          App.deathWarned = n.round;
          queueEvent({
            tone: 'magic', icon: '🔮', title: '你被施咒了！', hold: 6000,
            text: escapeHtml(n.byName) + ' 的【女巫】对 <b>' + n.num + ' 号角色</b>施咒，' +
                  '正是你的『<b>' + escapeHtml(myCharName(s, n.num)) + '</b>』。<br>' +
                  '你这回合<b>只能领取资源</b>，随后由女巫接管该角色的剩余行动。'
          });
        } else toast('🔮 ' + n.byName + ' 对 ' + n.num + ' 号角色施咒');
        return;

      case 'thief_declare':
        if (byMe) return;
        if (holdsIt) {
          queueEvent({
            tone: 'warn', icon: '💰', title: '盗贼盯上了你', hold: 5000,
            text: escapeHtml(n.byName) + ' 的【盗贼】宣布偷窃 <b>' + n.num + ' 号角色</b>（你的『' +
                  escapeHtml(myCharName(s, n.num)) + '』）。<br>' +
                  '轮到你时手上的金币会被<b>全部拿走</b>，建议先想好怎么花。'
          });
        } else toast('💰 ' + n.byName + ' 宣布偷窃 ' + n.num + ' 号角色');
        return;

      case 'assassinated':
        if (isMe) {
          // 极少数情况（中途接管 / 漏掉了宣告）没提前警告过，这里补一次弹层
          if (App.deathWarned !== n.round) {
            queueEvent({
              tone: 'danger', icon: '🗡', title: '本回合被跳过', hold: 5000,
              text: '你的『<b>' + escapeHtml(n.charName) + '</b>』（' + n.num + ' 号）已被刺杀，' +
                    '本回合直接跳过，无法行动。'
            });
          } else toast('🗡 你的『' + n.charName + '』被刺杀，本回合已跳过');
        } else toast('🗡 ' + n.playerName + ' 的『' + n.charName + '』被刺杀，跳过回合');
        return;

      case 'bewitched':
        if (isMe) toast('🔮 你的『' + n.charName + '』被施咒，本回合只能领资源');
        else toast('🔮 ' + n.playerName + ' 的『' + n.charName + '』被施咒');
        return;

      case 'thief_steal':
        flyCoins(n.playerIdx, n.byIdx, n.amount);
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '💰', title: '金币被偷走了', hold: 4200,
            text: '【盗贼】' + escapeHtml(n.byName) + ' 从你这里拿走了 <b>' + n.amount + ' 枚金币</b>。'
          });
        } else toast('💰 ' + n.byName + ' 偷走了 ' + n.playerName + ' 的 ' + n.amount + ' 金');
        return;

      case 'destroyed':
        destroyAnim(n.playerIdx, n.uid, n.cardName);
        if (isMe) {
          queueEvent({
            tone: 'danger', icon: '🔥', title: '你的建筑被摧毁', hold: 4800,
            text: escapeHtml(n.byName) + ' 用【领主】支付 ' + n.cost + ' 金，' +
                  '摧毁了你的『<b>' + escapeHtml(n.cardName) + '</b>』。'
          });
        } else toast('🔥 ' + n.byName + ' 摧毁了 ' + n.playerName + ' 的『' + n.cardName + '』');
        return;

      case 'seized':
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '⚔️', title: '你的建筑被抢走', hold: 4800,
            text: escapeHtml(n.byName) + ' 用【元帅】支付 ' + n.cost + ' 金，' +
                  '抢走了你的『<b>' + escapeHtml(n.cardName) + '</b>』（金币已补偿给你）。'
          });
        } else toast('⚔️ ' + n.byName + ' 抢走了 ' + n.playerName + ' 的『' + n.cardName + '』');
        return;

      case 'got_gold':
        flyGoldIn(n.playerIdx, n.amount);
        return;

      case 'round_end':
        return;

      case 'swapped':
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '🤝', title: '建筑被外交官换走', hold: 4800,
            text: escapeHtml(n.byName) + ' 用『' + escapeHtml(n.gotName) + '』' +
                  '换走了你的『<b>' + escapeHtml(n.cardName) + '</b>』。'
          });
        } else toast('🤝 ' + n.byName + ' 与 ' + n.playerName + ' 交换了建筑');
        return;
    }
  }
  function curPlayer() {
    if (!App.state) return null;
    return App.state.players.find(p => p.id === App.state.you) || null;
  }
  function isMyTurn() {
    const s = App.state; if (!s) return false;
    const av = s.available;
    if (!av) return false;
    if (s.reaction) return s.reaction.playerId === App.myId;
    return !!(av.actions && av.actions.length);
  }

  /* ============================== 本地驱动 ============================== */
  function localActor(st) {
    if (st.phase === 'draft' && st.draft) {
      const step = st.draft.steps[st.draft.stepIdx];
      if (step) return st.players[step.player];
      return null;
    }
    if (st.reaction) return st.players[st.reaction.playerIdx];
    // 轮末确认：找第一个还没确认的玩家
    if (st.roundConfirm) {
      const i = (st.roundConfirm.confirmed || []).findIndex(c => !c);
      return i >= 0 ? st.players[i] : null;
    }
    if (st.turn) return st.players[st.turn.playerIdx];
    return null;
  }

  const Local = {
    state: null, myId: null, timer: null, pendingMs: null,
    start(cfg) {
      const seats = [{ id: 'me', name: cfg.name, isBot: false }];
      for (let i = 1; i < cfg.players; i++) {
        seats.push({ id: 'bot' + i, name: '电脑 ' + i, isBot: true, botLevel: cfg.level });
      }
      this.myId = 'me';
      App.myId = 'me';
      App.noticeSeen = 0;            // 新开局：从第一条事件起都要提示
      App.paused = false;
      hideEvent(true);
      this.state = Engine.createGame({
        roomId: 'local', endDistricts: cfg.end, charSetMode: cfg.chars, seats: seats
      });
      Engine.startGame(this.state);
      this.emit();
      // 关键修复：开局后立即启动机器人驱动循环。
      // 否则当第一个选角者/行动者是电脑时，循环不会被触发，
      // 界面会卡在“等待其他玩家选角…”（或对手行动中）且永远不动。
      this.schedule(pace().min);
    },
    emit() {
      App.state = Engine.sanitize(this.state, this.myId);
      App.state.available = Engine.getAvailableActions(this.state, this.myId);
      App.state.isLocal = true;
      render();
      if (App.state.phase === 'gameover') showOver(App.state);
    },
    send(action) {
      const res = Engine.applyAction(this.state, this.myId, action);
      if (!res.ok) { toast('✗ ' + res.error); return; }
      App.sel = null;
      this.emit();
      // 真人操作后给一点“电脑开始思考”的缓冲，别瞬间接上
      this.schedule(pace().act);
    },
    schedule(ms) {
      clearTimeout(this.timer);
      this.pendingMs = ms;
      if (App.paused) return;        // 事件弹层期间挂起，关闭后由 resume() 续上
      this.timer = setTimeout(() => this.step(), ms);
    },
    /** 弹层关闭后继续推进 */
    resume() {
      if (!this.state || this.state.phase === 'gameover') return;
      this.schedule(this.pendingMs == null ? pace().min : Math.min(this.pendingMs, pace().act));
    },
    /** 切换速度后让当前等待立即改用新节奏 */
    reschedule() {
      if (!this.timer || App.paused) return;
      this.schedule(pace().min);
    },
    step() {
      const st = this.state;
      if (!st || st.phase === 'gameover') { this.emit(); return; }
      const actor = localActor(st);
      if (actor && actor.isBot) {
        let action = null;
        try { action = AI.decide(st, actor.id); } catch (e) { console.error(e); }
        if (action) {
          let res = Engine.applyAction(st, actor.id, action);
          if (!res.ok) {
            console.warn('电脑行动失败：' + res.error);
            if (st.phase === 'draft') {
              // 选角失败时从合法行动中挑第一个再试一次，避免空转卡死
              const opts = Engine.getAvailableActions(st, actor.id);
              if (opts && opts.length) {
                res = Engine.applyAction(st, actor.id, opts[0]);
              }
            }
            if (!res.ok) {
              if (st.turn && st.turn.pending) Engine.applyAction(st, actor.id, { type: 'ability_skip' });
              else if (st.turn) Engine.applyAction(st, actor.id, { type: 'end_turn' });
            }
          }
        }
        this.emit();
        this.schedule(botDelay(action));
        return;
      }
      this.emit();
    }
  };

  /* ============================== 联机驱动 ============================== */
  const Net = {
    ws: null, myId: null, roomId: null, name: '', onState: null,
    connect(cb) {
      if (this.ws && this.ws.readyState === 1) return cb && cb();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(proto + '://' + location.host);
      this.ws.onopen = () => {
        this.send({ t: 'hello', name: this.name });
        cb && cb();
      };
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.handle(m);
      };
      this.ws.onclose = () => {
        toast('与服务器的连接已断开');
        $$('#screen-lobby .dim').forEach(() => {});
      };
      this.ws.onerror = () => toast('无法连接服务器');
    },
    send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
    handle(m) {
      switch (m.t) {
        case 'hello': this.myId = m.youId; break;
        case 'rooms': renderRoomList(m.rooms); break;
        case 'joined':
          this.myId = m.youId; this.roomId = m.roomId;
          App.myId = m.youId;
          // 大厅里加入 → 从 0 开始（后续事件全部提示）；中途加入 → 对齐进度，不回放历史
          App.noticeSeen = (m.state.notices && m.state.notices.length)
            ? m.state.notices[m.state.notices.length - 1].seq : 0;
          App.paused = false; hideEvent(true);
          if (m.state.phase === 'lobby') { renderLobbyRoom(m.state); showScreen('screen-lobby'); }
          else { App.state = m.state; showScreen('screen-game'); render(); }
          break;
        case 'state':
          App.state = m.state;
          if (m.state.you) App.myId = m.state.you;
          if (m.state.phase === 'lobby') { renderLobbyRoom(m.state); showScreen('screen-lobby'); }
          else {
            showScreen('screen-game'); render();
            if (m.state.phase === 'gameover') showOver(m.state);
          }
          break;
        case 'error': toast('✗ ' + m.error); break;
        case 'chat': toast(m.from + '：' + m.text); break;
      }
    },
    action(a) { this.send({ t: 'action', action: a }); }
  };

  function send(action) {
    if (App.mode === 'local') Local.send(action);
    else Net.action(action);
  }

  /* ============================== 卡牌渲染 ============================== */
  function cardNode(c, opts) {
    opts = opts || {};
    const d = el('div', 'card c-' + c.color + (opts.mini ? ' mini' : '') +
      (opts.clickable ? ' clickable' : '') + (opts.disabled ? ' disabled' : '') +
      (opts.selected ? ' selected' : '') + (opts.pickable ? ' pickable' : ''));
    d.dataset.uid = c.uid;
    d.title = (c.desc ? c.desc + '\n' : '') + c.name + ' · ' + Cards.COLORS[c.color].name +
      ' · 花费 ' + c.cost + (c.scoreValue && c.scoreValue !== c.cost ? ' · 计分 ' + c.scoreValue : '');
    d.appendChild(el('div', 'c-top'));
    d.appendChild(el('div', 'c-cost', String(c.cost)));
    d.appendChild(el('div', 'c-name', c.name));
    d.appendChild(el('div', 'c-en', c.en || ''));
    if (c.beautified) d.appendChild(el('div', 'c-badges', '💎'));
    else if (c.museumCount) d.appendChild(el('div', 'c-badges', '🖼' + c.museumCount));
    return d;
  }

  /* 角色卡牌插画（images/roles/ 下，按编号对应基础角色）。
   * 9 号（皇后/艺术家）暂缺图，回退到 emoji。 */
  const ROLE_IMG = { 1: '刺客', 2: '小偷', 3: '魔术师', 4: '国王', 5: '住持', 6: '商人', 7: '建筑师', 8: '领主' };
  const CHAR_EMOJI = { 1: '🗡', 2: '🥷', 3: '🎩', 4: '👑', 5: '⛪', 6: '💰', 7: '🔨', 8: '⚔️', 9: '🃏' };
  function roleImage(c) {
    if (!c || !ROLE_IMG[c.num]) return null;
    return 'images/roles/' + ROLE_IMG[c.num] + '.jpg';
  }

  function charNode(c, opts) {
    opts = opts || {};
    const d = el('div', 'char-card' + (opts.dim ? ' faceup-char' : '') + (opts.clickable ? ' clickable' : '') + (opts.mini ? ' mini' : ''));
    const img = roleImage(c);
    let art = '<div class="cc-art">';
    if (img) art += '<img src="' + img + '" alt="' + escapeHtml(c.name) + '">';
    else art += '<div class="cc-art-emoji">' + (CHAR_EMOJI[c.num] || '🃏') + '</div>';
    art += '</div>';
    // 角色卡图本身已印有编号/名称/效果文字，故只保留整图与极简编号，删去冗余说明
    d.innerHTML = art +
      '<div class="cc-num">' + c.num + '</div>' +
      '<div class="cc-name">' + c.name + '</div>';
    if (img && d.dataset) d.dataset.zoomSrc = img; // 悬浮放大浮窗：整张角色卡图（dataset 在浏览器/测试桩均可用）
    return d;
  }

  /* 角色卡悬浮放大：鼠标停在带 data-zoom-src / data-zoom-back 的元素上时用更大的浮窗展示整张卡图
   * 适用于：选角池角色牌、出局角色条（明置/暗置）、每个玩家小框框里的角色状态卡。 */
  function initCharZoom() {
    const zoom = $('#char-zoom');
    if (!zoom) return;
    const zimg = $('#char-zoom-img', zoom);
    const zback = $('#char-zoom-back', zoom);
    const zbg = $('#char-zoom-bg');
    const zact = $('#cz-actions');
    const zok = $('#cz-ok');
    const zcancel = $('#cz-cancel');
    const W = 300; // 放大浮窗宽度
    const SEL = '[data-zoom-src],[data-zoom-back]';
    let active = null;
    let pending = null;   // 触屏下待确认的选角行动

    function place(r) {
      // 优先放在卡片右侧，空间不足则放左侧
      let left = r.right + 16;
      if (left + W > window.innerWidth - 12) left = r.left - W - 16;
      if (left < 12) left = 12;
      zoom.style.left = left + 'px';
      // 顶边与卡片对齐，并夹在视口内
      let top = r.top;
      const h = zoom.offsetHeight || 440;
      if (top + h > window.innerHeight - 12) top = Math.max(12, window.innerHeight - h - 12);
      if (top < 12) top = 12;
      zoom.style.top = top + 'px';
    }

    function paint(trigger) {
      const src = trigger.getAttribute('data-zoom-src');
      if (src) {
        if (zimg && zimg.getAttribute('src') !== src) zimg.src = src;
        if (zimg) zimg.style.display = '';
        if (zback) zback.style.display = 'none';
      } else {
        // 盖牌 / 暗置移除：展示放大牌背
        if (zimg) zimg.style.display = 'none';
        if (zback) zback.style.display = '';
      }
    }

    function hide() {
      zoom.hidden = true; active = null; pending = null;
      if (zbg) zbg.hidden = true;
      if (zact) zact.hidden = true;
      if (zoom.classList) zoom.classList.remove('touch');
    }

    function show(trigger) {
      paint(trigger);
      active = trigger;
      zoom.hidden = false;
      if (touchMode) {
        zoom.classList.add('touch');
        if (zbg) zbg.hidden = false;
        // 选角牌带 data-pick-*，放大后在卡片下方给出「确认 / 取消」
        pending = (trigger.dataset && trigger.dataset.pickChar)
          ? { type: trigger.dataset.pickType, charId: trigger.dataset.pickChar }
          : null;
        if (zact) zact.hidden = !pending;
        return;   // 触屏用 .touch 的居中定位（CSS），不再按卡片坐标摆放
      }
      if (zact) zact.hidden = true;
      place(trigger.getBoundingClientRect());
    }

    const touchMode = isTouchDevice();

    /* ---------------- 触屏：点一下放大，确认 / 取消 ---------------- */
    if (touchMode) {
      let sx = 0, sy = 0;
      document.addEventListener('touchstart', e => {
        const t = e.touches && e.touches[0];
        if (t) { sx = t.clientX; sy = t.clientY; }
      }, { passive: true });
      document.addEventListener('touchend', e => {
        const t0 = e.changedTouches && e.changedTouches[0];
        if (!t0) return;
        // 位移超过阈值视为滑动（滚动页面），不当作点击
        if (Math.abs(t0.clientX - sx) > 12 || Math.abs(t0.clientY - sy) > 12) return;
        const hit = e.target && e.target.closest && e.target.closest(SEL);
        if (hit) {
          if (e.cancelable) e.preventDefault();  // 阻止合成的 mouseover/click
          show(hit);
          return;
        }
        // 点空白处收起
        if (!zoom.hidden) { if (e.cancelable) e.preventDefault(); hide(); }
      }, { passive: false });
      // 确认：执行选角
      if (zok) zok.addEventListener('touchend', e => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        const p = pending; hide();
        if (p) send(p);
      }, { passive: false });
      // 取消：收起放大，回到无放大状态
      if (zcancel) zcancel.addEventListener('touchend', e => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        hide();
      }, { passive: false });
      // 点背景遮罩同样收起
      if (zbg) zbg.addEventListener('touchend', e => {
        if (e.cancelable) e.preventDefault();
        hide();
      }, { passive: false });
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', hide);
      }
      return;   // 触屏不绑任何 mouse 事件，避免合成事件干扰
    }

    /* ---------------- 桌面：悬浮放大 ---------------- */
    document.addEventListener('mouseover', e => {
      const t = e.target.closest && e.target.closest(SEL);
      if (t && t !== active) show(t);
    });
    document.addEventListener('mousemove', e => {
      if (zoom.hidden || !active) return;
      // 卡片若已被移出 DOM（如选角后重渲染），立即收起
      if (!active.isConnected) { hide(); return; }
      const t = e.target.closest && e.target.closest(SEL);
      // 仍在原卡片上：稳定跟随卡片位置（不追光标，避免抖动）
      if (t === active) place(active.getBoundingClientRect());
    });
    document.addEventListener('mouseout', e => {
      if (!active) return;
      const t = e.target.closest && e.target.closest(SEL);
      const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(SEL);
      if (t === active && !to) hide();
    });
    // 点击角色卡（选角）后立即收起放大浮窗
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest(SEL)) hide();
    });
    // 滚动时位置会失真，直接隐藏
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', hide, true);
      window.addEventListener('resize', hide);
    }
  }

  /* 玩家小框框里的角色卡状态：未选 / 盖牌 / 翻面；翻面后立即在右侧显示角色名 */
  function charStatusHTML(p) {
    let st = 'none';
    if (p.hasChosen) st = (p.revealedCharNum != null) ? 'up' : 'down';
    // 检测本帧是否从「盖牌」变为「翻面」，是则播放翻牌动画
    const prev = App._reveal[p.seat];
    let flip = '';
    if (prev === 'down' && st === 'up') flip = ' flip-in';
    App._reveal[p.seat] = st;
    let front = '', nameSpan = '';
    if (st === 'up') {
      const img = roleImage({ num: p.revealedCharNum });
      front = img
        ? '<img src="' + img + '" alt="' + escapeHtml(String(p.revealedCharNum)) + '">'
        : '<div class="cs-emoji">' + (CHAR_EMOJI[p.revealedCharNum] || '🃏') + '</div>';
      const ch = (Engine && Engine.CHAR_MAP)
        ? Object.values(Engine.CHAR_MAP).find(c => c.num === p.revealedCharNum) : null;
      const nm = ch ? ch.name : (ROLE_IMG[p.revealedCharNum] || ('' + p.revealedCharNum));
      nameSpan = '<span class="cs-name">' + escapeHtml(nm) + '</span>';
      var zoomAttr = img ? ' data-zoom-src="' + img + '"' : ' data-zoom-back="1"';
    } else if (st === 'down') {
      nameSpan = '<span class="cs-label">已选 · 盖牌</span>';
      var zoomAttr = ' data-zoom-back="1"';
    } else {
      var zoomAttr = '';
    }
    return '<div class="cs-card ' + st + flip + '"' + zoomAttr + '>' +
      '<div class="cs-inner">' +
        '<div class="cs-face cs-back">🂠</div>' +
        '<div class="cs-face cs-front">' + front + '</div>' +
      '</div></div>' + nameSpan;
  }

  /* 通用金币飞行动画：从 a 矩形飞向 b 矩形，错峰起飞、弧线、淡出 */
  function coinFlight(a, b, amount) {
    if (!a || !b) return;
    if (typeof document === 'undefined' || !document.body) return;
    const n = Math.min(9, Math.max(3, Math.round((amount || 1) / 2)));
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => fn();
    for (let k = 0; k < n; k++) {
      const c = document.createElement('div');
      c.className = 'fly-coin';
      c.textContent = '🪙';
      document.body.appendChild(c);
      const sx = a.left + a.width / 2 + (Math.random() * 40 - 20);
      const sy = a.top + a.height / 2 + (Math.random() * 30 - 15);
      const ex = b.left + b.width / 2 + (Math.random() * 40 - 20);
      const ey = b.top + b.height / 2 + (Math.random() * 30 - 15);
      c.style.left = sx + 'px';
      c.style.top = sy + 'px';
      const dx = ex - sx, dy = ey - sy;
      // 错峰起飞
      c.style.transitionDelay = (k * 70) + 'ms';
      raf(() => {
        c.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(.55)';
        c.style.opacity = '0.15';
      });
      setTimeout(() => { if (c.parentNode) c.parentNode.removeChild(c); }, 1100 + k * 70);
    }
  }

  function rectOf(el) {
    return (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : null;
  }
  /** 玩家小框框元素（我的框用 #me-area，对手框用 data-seat） */
  function playerBox(s) {
    if (typeof document === 'undefined' || !document.querySelector) return null;
    if (s != null && s === App.myIdx) return $('#me-area') ||
      document.querySelector('[data-seat="' + s + '"]');
    return document.querySelector('[data-seat="' + s + '"]');
  }

  /* 金币从被偷者飞向盗贼的动画 */
  function flyCoins(fromSeat, toSeat, amount) {
    if (fromSeat == null || toSeat == null || fromSeat === toSeat) return;
    coinFlight(rectOf(playerBox(fromSeat)), rectOf(playerBox(toSeat)), amount);
  }

  /* 领取金币：金币从顶部"金库"（回合横幅/顶栏）飞进该玩家的小框框 */
  function flyGoldIn(seat, amount) {
    if (seat == null || !(amount > 0)) return;
    if (typeof document === 'undefined' || !document.body) return;
    const to = rectOf(playerBox(seat));
    if (!to) return;
    // 起点优先用回合横幅（代表金库/牌堆），退化到视口顶部居中
    const bankEl = $('#turn-banner') || $('#topbar') || $('#tb-round');
    let from = rectOf(bankEl);
    if (!from) {
      const w = 120, h = 40;
      from = { left: (window.innerWidth - w) / 2, top: 8, width: w, height: h };
    }
    coinFlight(from, to, amount);
  }

  /* 防抖动：每次 render() 都会重建棋盘 DOM，滚动容器（手机上是 .board-main，
   * 还有横向滚动的城区/手牌/牌池）的滚动位置会被清零，表现为"每行动一次页面就跳一下"。
   * 渲染前记录、渲染后恢复即可消除。 */
  // 注意：不含 #log —— 日志要一直贴着底部刷新（renderLog 已设 scrollTop=scrollHeight），
  // 若在这里恢复旧位置就会抵消它的自动滚动。
  const SCROLL_KEEP = ['#board-main', '#opponents', '#my-city', '#my-hand', '#draft-pool'];
  function snapshotScroll() {
    const out = [];
    if (typeof document === 'undefined' || !document.querySelector) return out;
    SCROLL_KEEP.forEach(sel => {
      const e = $(sel);
      if (e) out.push([e, e.scrollTop || 0, e.scrollLeft || 0]);
    });
    return out;
  }
  function restoreScroll(snap) {
    snap.forEach(([e, top, left]) => {
      if (!e) return;
      if (e.scrollTop !== top) e.scrollTop = top;
      if (e.scrollLeft !== left) e.scrollLeft = left;
    });
  }

  /* 领主摧毁建筑：克隆被毁建筑卡到 body 上播放摧毁动画（不受后续整局重渲染影响），并撒出碎片粒子 */
  function destroyAnim(seat, uid, name) {
    if (typeof document === 'undefined' || !document.querySelector) return;
    if (typeof window === 'undefined' || !window.getComputedStyle) return;
    let cityEl = null;
    if (seat === App.myIdx) cityEl = $('#my-city');
    else cityEl = document.querySelector('[data-seat="' + seat + '"] .opp-city');
    if (!cityEl) return;
    const card = cityEl.querySelector('.card[data-uid="' + uid + '"]');
    if (!card || !card.getBoundingClientRect) return;
    const r = card.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    // 把克隆节点钉在 body 上，原卡将在下一次重渲染时被移除，克隆独立播放动画
    const clone = card.cloneNode(true);
    clone.classList.add('destroying');
    clone.style.position = 'fixed';
    clone.style.left = r.left + 'px';
    clone.style.top = r.top + 'px';
    clone.style.width = r.width + 'px';
    clone.style.height = r.height + 'px';
    clone.style.margin = '0';
    document.body.appendChild(clone);
    // 碎片 / 火花向四周飞散
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const bits = ['💥', '🧱', '🔥', '💢'];
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => fn();
    for (let i = 0; i < 7; i++) {
      const b = document.createElement('div');
      b.className = 'debris';
      b.textContent = bits[i % bits.length];
      b.style.left = cx + 'px';
      b.style.top = cy + 'px';
      document.body.appendChild(b);
      const ang = (Math.PI * 2 * i) / 7 + (Math.random() - 0.5);
      const dist = 60 + Math.random() * 70;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 24;
      raf(() => {
        b.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (Math.random() * 360 - 180) + 'deg) scale(.5)';
        b.style.opacity = '0';
      });
      setTimeout(() => { if (b.parentNode) b.parentNode.removeChild(b); }, 720);
    }
    setTimeout(() => { if (clone.parentNode) clone.parentNode.removeChild(clone); }, 760);
  }

  /* ============================== 渲染主函数 ============================== */
  function render() {
    const s = App.state;
    if (!s) return;
    if (s.phase === 'lobby') return;
    // 记录滚动位置，渲染完恢复（避免每次行动后画面跳动）
    const _scrollSnap = snapshotScroll();

    $('#tb-round').textContent = s.round;
    $('#tb-target').textContent = s.endDistricts;
    $('#tb-deck').textContent = s.deckCount;
    const crownP = s.players.find(p => p.hasCrown);
    $('#tb-crown').innerHTML = '👑 ' + (crownP ? escapeHtml(crownP.name) : '—');
    $('#tb-room').textContent = s.roomName || (App.mode === 'local' ? '单人模式' : '联机房间 ' + (s.roomId || ''));
    syncSpeedBtn();

    // 本轮生效的负面效果常驻显示，别让玩家忘了自己被刺杀/被盯上
    const fx = $('#tb-effects');
    if (fx) {
      const parts = [];
      const e = s.effects || {};
      if (e.assassinated != null) parts.push('🗡 ' + e.assassinated + ' 号被刺杀');
      if (e.bewitched != null) parts.push('🔮 ' + e.bewitched + ' 号被施咒');
      if (e.thief != null) parts.push('💰 ' + e.thief + ' 号被盯上');
      fx.textContent = parts.join(' · ');
      fx.hidden = parts.length === 0;
    }

    // 关键事件提示（被刺杀等）。用 seq 去重，重复渲染不会重复弹窗。
    processNotices(s);

    const isDraft = s.phase === 'draft';
    $('#draft-area').hidden = !isDraft;
    $('#play-area').hidden = false;
    renderRemoved(s);
    if (isDraft) {
      renderDraft(s);
      // 选角阶段也展示全场局势（对手城市 / 我的城市与手牌），方便决策
      $('#turn-banner').innerHTML =
        '<div class="tb-who">🃏 选角阶段</div>' +
        '<div class="tb-sub">上方为当前选角者与牌池，下方为场上局势</div>';
      renderOpponents(s);
      renderMe(s);
      renderLog(s);
      restoreScroll(_scrollSnap);
      return;
    }

    renderTurnBanner(s);
    renderOpponents(s);
    renderMe(s);
    renderLog(s);
    renderActions(s);
    autoOpenPick(s);
    restoreScroll(_scrollSnap);
  }

  /** 抽牌保留 / 学者选牌 / 预言家归还：自动弹出卡牌选择窗 */
  function autoOpenPick(s) {
    const t = s.turn;
    if (!t || !t.pending || t.playerId !== App.myId) { App.pickKey = null; return; }
    const k = t.pending.kind;
    if (k !== 'draw_keep' && k !== 'scholar_pick' && k !== 'prophet_give') { App.pickKey = null; return; }
    const key = s.round + '|' + k + '|' +
      (t.pending.cards ? t.pending.cards.map(c => c.uid).join(',') : String(t.pending.targetIdx));
    if (App.pickKey === key) return;
    App.pickKey = key;
    openPickModal();
  }

  function escapeHtml(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /** 「思考中」的三点跳动动画，让等待电脑时界面不显得像卡死 */
  function thinkingDots() {
    return '<span class="dots"><i></i><i></i><i></i></span>';
  }

  /* 轮末战果确认：本轮结束后暂停，所有玩家都点过「确认本轮战果」才进入下一轮选角 */
  function renderRoundConfirm(box, s) {
    box.classList.add('rc');
    const rc = s.roundConfirm;
    const myIdx = s.players.findIndex(p => p.id === App.myId);
    const done = rc.confirmed.filter(Boolean).length;
    const total = s.players.length;

    const left = el('div');
    const rows = s.players.map((p, i) => {
      const okd = !!rc.confirmed[i];
      return '<span class="rc-who' + (okd ? ' ok' : '') + '">' +
        escapeHtml(p.name) + (okd ? ' ✓' : ' ⏳') + '</span>';
    }).join('');
    left.innerHTML =
      '<div class="tb-who">🏁 第 ' + rc.round + ' 轮结束 — 请确认本轮战果</div>' +
      '<div class="rc-list">' + rows + '</div>';
    box.appendChild(left);

    const btn = el('button', 'btn rc-btn');
    if (myIdx >= 0 && rc.confirmed[myIdx]) {
      btn.textContent = '已确认，等待其他玩家（' + done + '/' + total + '）';
      btn.className = 'btn ghost rc-btn';
      btn.disabled = true;
    } else {
      btn.textContent = '✅ 确认本轮战果（' + done + '/' + total + '）';
      btn.className = 'btn rc-btn';
      onTap(btn, () => send({ type: 'confirm_round' }));
    }
    box.appendChild(btn);
  }

  function renderTurnBanner(s) {
    const box = $('#turn-banner');
    box.innerHTML = '';
    box.classList.remove('rc');
    const t = s.turn;
    if (!t) {
      if (s.roundConfirm) { renderRoundConfirm(box, s); return; }
      box.innerHTML = '<div class="tb-who">等待中…</div><div class="tb-sub">准备下一轮</div>';
      return;
    }
    const who = s.players[t.playerIdx];
    const left = el('div');
    let mark = '';
    if (s.effects.assassinated === t.charNum) mark = ' <span class="tag dead">被刺杀</span>';
    if (s.effects.bewitched === t.charNum) mark += ' <span class="tag magic">被施咒</span>';
    let phaseTip = '';
    if (t.phase === 'witch_resume') phaseTip = '<span class="tag magic">女巫接管</span>';
    if (t.phase === 'bewitched') phaseTip = '<span class="tag magic">仅可领资源</span>';
    left.innerHTML = '<div class="tb-who">' + (who.id === App.myId ? '👉 你' : escapeHtml(who.name)) +
      ' — ' + t.charNum + ' · ' + escapeHtml(t.charName) + mark + ' ' + phaseTip + '</div>' +
      '<div class="tb-sub">已建造 ' + t.builds + ' / ' + t.buildLimit + ' 栋' +
      (t.takenResources ? ' · 已领资源' : '') + '</div>';
    box.appendChild(left);

    const stats = el('div', 'tb-stats');
    stats.innerHTML =
      '<span>🃏 牌堆 <b>' + s.deckCount + '</b></span>' +
      '<span>🗑 弃牌 <b>' + s.discardCount + '</b></span>' +
      (s.effects.thief != null ? '<span>🗡 盗贼锁定 <b>' + s.effects.thief + ' 号</b></span>' : '') +
      (s.firstToFinish >= 0 ? '<span>★ <b>' + escapeHtml(s.players[s.firstToFinish].name) + '</b> 已达标</span>' : '');
    box.appendChild(stats);
  }

  function renderOpponents(s) {
    const wrap = $('#opponents');
    wrap.innerHTML = '';
    const picking = districtSelectMode();
    s.players.forEach((p, i) => {
      if (p.id === App.myId) return;
      const d = el('div', 'opp' + (s.turn && s.turn.playerIdx === p.seat ? ' active' : ''));
      d.dataset.seat = p.seat;
      const cs = el('div', 'opp-char');
      cs.innerHTML = charStatusHTML(p);
      d.appendChild(cs);
      const head = el('div', 'opp-head');
      let tags = '';
      if (p.isBot) tags += '<span class="tag bot">电脑</span>';
      if (p.hasCrown) tags += '<span class="tag crown">👑 皇冠</span>';
      head.innerHTML = '<span class="opp-name">' + escapeHtml(p.name) + '</span>' + tags +
        '<span class="opp-gold">🪙 ' + p.gold + '</span>';
      const sb = el('button', 'score-btn');
      sb.title = '显示 ' + p.name + ' 的得分与计算过程';
      sb.textContent = '📊';
      onTap(sb, () => openScore(i));
      head.appendChild(sb);
      d.appendChild(head);

      const body = el('div', 'opp-body');
      const city = el('div', 'opp-city');
      if (!p.city.length) city.appendChild(el('div', 'empty-hint', '（尚无建筑）'));
      p.city.forEach(c => {
        const sel = isSelectableDistrict(p, c);
        // 选择目标时放大对手的建筑牌，方便触屏点击
        const n = cardNode(c, { mini: !picking, clickable: sel, pickable: sel });
        if (sel) onTap(n, () => pickDistrict(p.id, c.uid));
        city.appendChild(n);
      });
      body.appendChild(city);
      const meta = el('div', 'opp-meta');
      meta.innerHTML = '城区 <b>' + p.cityCount + '</b>/' + s.endDistricts + '<br>手牌 ' + p.handCount + ' 张' +
        (p.played && p.played.length ? '<br>已用：' + p.played.map(c => escapeHtml(Engine.charOf(c).name)).join('、') : '');
      body.appendChild(meta);
      d.appendChild(body);
      wrap.appendChild(d);
    });
  }

  /* 得分明细浮动窗口 */
  function openScore(idx) {
    const s = App.state;
    if (!s || !s.scores) return;
    if (idx == null) idx = (App.myIdx != null ? App.myIdx
      : s.players.findIndex(p => p.id === App.myId));
    if (idx < 0) return;
    const row = s.scores[idx];
    if (!row) return;
    const p = s.players[idx];
    if (!p) return;
    $('#score-name').textContent = p.name;
    $('#score-total').textContent = row.total;
    $('#score-sub').textContent = '城区 ' + (row.cityCount != null ? row.cityCount : p.cityCount) +
      ' / ' + s.endDistricts + ' 栋　建筑 ' + row.base + ' ＋ 奖励 ' + row.bonus;
    const ul = $('#score-detail'); ul.innerHTML = '';
    (row.detail || []).forEach(d => {
      const li = el('li', 'sd-row');
      li.innerHTML = '<span class="sd-label">' + escapeHtml(d.label) + '</span>' +
        '<span class="sd-val">' + (d.value >= 0 ? '+' : '') + d.value + '</span>';
      ul.appendChild(li);
    });
    const li = el('li', 'sd-row total');
    li.innerHTML = '<span class="sd-label">合计</span><span class="sd-val">' + row.total + '</span>';
    ul.appendChild(li);
    $('#score-foot').textContent = s.phase === 'gameover'
      ? (s.winner === idx ? '🏆 本局胜利者' : '游戏已结束') + '（最终得分）'
      : '（当前实时计分，最终以结算为准）';
    const pop = $('#score-popup');
    pop.hidden = false;
  }
  function closeScore() { $('#score-popup').hidden = true; }

  function renderMe(s) {
    const me = s.players.find(p => p.id === App.myId);
    if (!me) return;
    App.myIdx = s.players.findIndex(p => p.id === App.myId);
    const meArea = $('#me-area');
    if (meArea) meArea.dataset.seat = App.myIdx;
    const ms = $('#my-char-status');
    if (ms) ms.innerHTML = charStatusHTML(me);
    $('#my-gold').textContent = '🪙 ' + me.gold;
    $('#my-city-count').textContent = me.cityCount + ' / ' + s.endDistricts + ' 栋';
    $('#my-hand-count').textContent = me.hand.length + ' 张';
    const fx = s.effects || {};
    $('#my-chars-tip').innerHTML = me.chars.map(c => {
      let extra = '', cls = c.played ? '' : ' crown';
      if (fx.assassinated === c.num) { extra = ' 🗡被刺杀'; cls = ' dead'; }
      else if (fx.bewitched === c.num) { extra = ' 🔮被施咒'; cls = ' magic'; }
      else if (fx.thief === c.num) { extra = ' 💰被盯上'; cls = ' magic'; }
      return '<span class="tag' + cls + '">' + c.num + '·' + escapeHtml(c.name) +
        (c.played ? '（已用）' : '') + extra + '</span>';
    }).join(' ');

    const city = $('#my-city'); city.innerHTML = '';
    if (!me.city.length) city.appendChild(el('div', 'empty-hint', '（尚无建筑，快去建造吧）'));
    me.city.forEach(c => {
      const sel = isSelectableDistrict(me, c);
      const n = cardNode(c, { clickable: sel, pickable: sel,
        selected: App.sel && App.sel.items.indexOf(c.uid) >= 0 });
      n.title = (c.desc ? c.desc + '\n' : '') + c.name + ' · ' + Cards.COLORS[c.color].name;
      if (sel) onTap(n, () => pickDistrict(me.id, c.uid));
      city.appendChild(n);
    });

    const hand = $('#my-hand'); hand.innerHTML = '';
    if (!me.hand.length) hand.appendChild(el('div', 'empty-hint', '（手牌为空）'));
    me.hand.forEach(c => {
      const inSel = App.sel && App.sel.items.indexOf(c.uid) >= 0;
      let clickable = false, disabled = false, pickable = false;
      if (App.sel && App.sel.kind === 'handpick') { clickable = true; pickable = true; }
      else if (App.sel && App.sel.kind === 'multi') { clickable = true; }
      else if (s.turn && s.turn.playerId === App.myId && !s.turn.pending) { clickable = c.canBuild; disabled = !c.canBuild; }
      const n = cardNode(c, { clickable: clickable, disabled: disabled, selected: inSel, pickable: pickable });
      n.title = (c.desc ? c.desc + '\n' : '') + c.name + ' · ' + Cards.COLORS[c.color].name + ' · 花费 ' + c.cost;
      if (clickable) onTap(n, () => onHandClick(c));
      hand.appendChild(n);
    });
  }

  function renderLog(s) {
    const box = $('#log');
    box.innerHTML = '';
    s.log.forEach(l => {
      box.appendChild(el('div', l.type || 'info', escapeHtml(l.text)));
    });
    box.scrollTop = box.scrollHeight;
  }

  /* ============================== 选角阶段 ============================== */
  function renderDraft(s) {
    const d = s.draft; if (!d) return;
    const me = s.players.find(p => p.id === App.myId);
    const isPicker = d.currentPlayer === App.myId;
    $('#draft-title').textContent = isPicker ? (d.sub === 'discard' ? '暗置弃掉一张角色牌' : '选择你的角色')
      : '等待其他玩家选角…';
    const cur = s.players.find(p => p.id === d.currentPlayer);
    const allChosen = s.players.every(p => p.hasChosen);
    // 2~3 人局每人要选 2 张，hasChosen 为真时仍可能再次轮到，不算卡住；4 人及以上每人只选 1 张
    const multiPickMode = s.players.length <= 3;
    const stuckDraft = !multiPickMode && ((cur && cur.hasChosen) || (allChosen && s.phase === 'draft'));
    if (stuckDraft && App.mode === 'local') {
      console.warn('[draft stuck] cur=', cur && cur.name, 'hasChosen=', cur && cur.hasChosen, 'allChosen=', allChosen, 'step=', d.stepIdx, '/', d.totalSteps);
      // 本地模式：尝试推一把电脑循环，让引擎重新评估当前行动者
      Local.schedule(pace().min);
    }
    $('#draft-sub').innerHTML = '进度 ' + Math.min(d.stepIdx + 1, d.totalSteps) + ' / ' + d.totalSteps +
      ' · 当前：' + (cur ? escapeHtml(cur.name) : '-') +
      ' · 明置移除 ' + d.faceUp.length + ' 张 · 暗置移除 ' + d.faceDownCount + ' 张 · 牌池 ' + d.poolCount + ' 张' +
      (stuckDraft ? ' · <b style="color:#c0392b">选角进度异常，正在尝试恢复…</b>' : '');

    const pool = $('#draft-pool'); pool.innerHTML = '';
    if (!isPicker) {
      pool.appendChild(el('div', 'empty-hint', '只有当前选角的玩家可以看到牌池内容'));
    } else {
      d.pool.forEach(c => {
        const n = charNode(c, { clickable: true });
        if (isTouchDevice()) {
          // 触屏：点一下先放大，再由浮窗下方的「确认 / 取消」决定是否选它
          if (n.dataset) {
            n.dataset.pickChar = c.id;
            n.dataset.pickType = d.sub === 'discard' ? 'draft_discard' : 'draft_pick';
          }
        } else {
          n.onclick = () => send({ type: d.sub === 'discard' ? 'draft_discard' : 'draft_pick', charId: c.id });
        }
        pool.appendChild(n);
      });
    }

    if (isPicker) {
      $('#prompt').textContent = $('#draft-title').textContent;
    } else {
      $('#prompt').innerHTML = (cur && cur.isBot ? '🤖 ' : '⏳ ') +
        escapeHtml(cur ? cur.name : '') + ' 正在选角' + thinkingDots();
    }
    $('#actions').innerHTML = '';
  }

  /* ============================== 本轮出局角色 ============================== */
  /* 明置移除：画出整张角色卡（身份公开）；暗置移除：画出盖着的牌背（身份保密，仅显示数量） */
  function renderRemoved(s) {
    const strip = $('#removed-strip');
    if (!strip) return;
    const rem = (s && s.removed) || { faceUp: [], faceDownCount: 0 };
    const fu = $('#rs-faceup', strip);
    const fd = $('#rs-facedown', strip);
    if (fu) { fu.innerHTML = ''; (rem.faceUp || []).forEach(c => fu.appendChild(charNode(c, { dim: true, mini: true }))); }
    if (fd) {
      fd.innerHTML = '';
      const n = rem.faceDownCount || 0;
      for (let i = 0; i < n; i++) fd.appendChild(el('div', 'facedown sm', '？'));
    }
    const empty = (!rem.faceUp || !rem.faceUp.length) && !(rem.faceDownCount > 0);
    strip.hidden = empty;
  }

  /* ============================== 行动栏 ============================== */
  function renderActions(s) {
    const av = s.available;
    const promptEl = $('#prompt');
    const actionsEl = $('#actions');
    actionsEl.innerHTML = '';
    if (!av) { promptEl.textContent = ''; return; }

    // 墓地响应
    if (s.reaction) {
      if (s.reaction.playerId === App.myId) {
        promptEl.innerHTML = '⚰️ ' + escapeHtml(s.reaction.prompt);
        (av.actions || []).forEach(a => actionsEl.appendChild(actionBtn(a, a.use ? 'main' : '')));
      } else {
        const who = s.players.find(p => p.id === s.reaction.playerId);
        promptEl.innerHTML = '等待 ' + escapeHtml(who ? who.name : '') + ' 决定是否使用【墓地】…';
      }
      return;
    }

    if (!av.actions || !av.actions.length) {
      const t = s.turn;
      if (t && t.playerId !== App.myId) {
        const who = s.players[t.playerIdx];
        promptEl.innerHTML = (who.isBot ? '🤖 ' : '⏳ ') + escapeHtml(who.name) +
          '（' + t.charNum + '·' + escapeHtml(t.charName) + '）正在行动' + thinkingDots();
      } else promptEl.textContent = '';
      return;
    }

    promptEl.innerHTML = '👉 ' + escapeHtml(av.prompt || '请选择行动');
    if (districtSelectMode()) promptEl.innerHTML += ' <b class="pick-tip">← 点击高亮的建筑 ▼</b>';
    if (App.sel && App.sel.kind === 'multi') promptEl.innerHTML += '（已选 ' + App.sel.items.length + '）';
    av.actions.forEach(a => {
      let cls = '';
      if (a.type === 'end_turn') cls = 'main';
      if (a.type === 'build') cls = 'main';
      if (a.type === 'take_gold' || a.type === 'take_cards' || a.type === 'income') cls = 'main';
      if (a.type === 'choose_district' || a.type === 'warlord_destroy') cls = 'danger';
      actionsEl.appendChild(actionBtn(a, cls));
    });

    // 多选确认按钮（魔术师弃牌 / 艺术家美化）
    if (App.sel && App.sel.kind === 'multi') {
      const b = el('button', 'act main', '✓ 确定（' + App.sel.items.length + '）');
      onTap(b, () => { App.sel.commit(App.sel.items.slice()); App.sel = null; });
      actionsEl.appendChild(b);
      const c = el('button', 'act', '取消选择');
      onTap(c, () => { App.sel = null; render(); });
      actionsEl.appendChild(c);
    }
    // 从手牌选一张（实验室 / 博物馆）
    if (App.sel && App.sel.kind === 'handpick') {
      promptEl.innerHTML = '👉 ' + escapeHtml(App.sel.label);
      const c = el('button', 'act', '取消');
      onTap(c, () => { App.sel = null; render(); });
      actionsEl.appendChild(c);
    }
    // pending 卡牌选择弹窗（抽牌保留 / 学者 / 预言家归还）
    const tk = s.turn && s.turn.pending ? s.turn.pending.kind : null;
    if (tk === 'draw_keep' || tk === 'scholar_pick' || tk === 'prophet_give') {
      const b = el('button', 'act main', '📜 打开卡牌选择');
      onTap(b, openPickModal);
      actionsEl.appendChild(b);
    }
  }

  function actionBtn(a, cls) {
    const b = el('button', 'act ' + (cls || ''));
    b.innerHTML = escapeHtml(a.label || a.type);
    onTap(b, () => runAction(a));
    return b;
  }

  /* ============================== 行动分发 ============================== */
  function runAction(a) {
    switch (a.type) {
      case 'lab':
        App.sel = { kind: 'handpick', items: [], label: '【实验室】点击一张手牌弃掉，换取 1 金',
          commit(uids) { App.sel = null; send({ type: 'lab', uid: a.uid, discardUid: uids[0] }); } };
        render(); return;
      case 'museum':
        App.sel = { kind: 'handpick', items: [], label: '【博物馆】点击一张手牌放入，计分 +1',
          commit(uids) { App.sel = null; send({ type: 'museum', uid: a.uid, cardUid: uids[0] }); } };
        render(); return;
      case 'choose_cards':
        App.sel = { kind: 'multi', items: [],
          commit(uids) { App.sel = null; send({ type: 'choose_cards', uids: uids }); } };
        render(); return;
      case 'choose_district':
        send(a); return;
      default:
        send(a);
    }
  }

  function onHandClick(c) {
    const s = App.state;
    if (App.sel && (App.sel.kind === 'handpick' || App.sel.kind === 'multi')) {
      if (App.sel.kind === 'handpick') { App.sel.commit([c.uid]); return; }
      const i = App.sel.items.indexOf(c.uid);
      if (i >= 0) App.sel.items.splice(i, 1); else App.sel.items.push(c.uid);
      render(); return;
    }
    // 默认：建造
    if (s.turn && s.turn.playerId === App.myId && c.canBuild && !s.turn.pending) {
      send({ type: 'build', uid: c.uid });
    } else if (s.turn && s.turn.playerId === App.myId && !s.turn.pending) {
      toast('无法建造『' + c.name + '』：金币不足 / 超出本回合建造数 / 已有同名建筑');
    }
  }

  /** 当前是否处于「选择建筑」模式 */
  function districtSelectMode() {
    const s = App.state;
    if (!s || !s.turn || !s.turn.pending) return false;
    return s.turn.playerId === App.myId &&
      ['warlord_destroy', 'marshal_seize', 'diplomat_mine', 'diplomat_theirs', 'artist'].indexOf(s.turn.pending.kind) >= 0;
  }
  function isSelectableDistrict(player, card) {
    if (!districtSelectMode()) return false;
    const av = App.state.available;
    if (!av || !av.actions) return false;
    return av.actions.some(a => a.type === 'choose_district' && a.target === player.id && a.uid === card.uid);
  }
  function pickDistrict(playerId, uid) {
    const av = App.state.available;
    const a = (av.actions || []).find(x => x.type === 'choose_district' && x.target === playerId && x.uid === uid);
    if (a) send(a);
  }

  /* ============================== 卡牌选择弹窗 ============================== */
  function openPickModal() {
    const s = App.state;
    const pd = s.turn.pending;
    if (!pd) return;
    const cards = pd.cards || [];
    const kind = pd.kind;
    const title = kind === 'scholar_pick' ? '学者：从 7 张中选 1 张'
      : kind === 'draw_keep' ? '选择要保留的建筑牌' : '选择一张卡牌';
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.innerHTML = '';
    const grid = el('div', 'pick-grid');
    if (kind === 'prophet_give') {
      const me = s.players.find(p => p.id === App.myId);
      me.hand.forEach(c => {
        const n = cardNode(c, { clickable: true });
        onTap(n, () => { closeModal(); send({ type: 'prophet_give', uid: c.uid }); });
        grid.appendChild(n);
      });
    } else {
      cards.forEach(c => {
        const n = cardNode(c, { clickable: true });
        onTap(n, () => {
          closeModal();
          if (kind === 'scholar_pick') send({ type: 'scholar_pick', uid: c.uid });
          else send({ type: 'draw_keep', uid: c.uid });
        });
        grid.appendChild(n);
      });
    }
    body.appendChild(grid);
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }

  /* ============================== 结算 ============================== */
  function showOver(s) {
    const rows = s.scores || [];
    let best = -1;
    rows.forEach(r => { if (r.total > best) best = r.total; });
    $('#over-title').innerHTML = s.winner != null
      ? '🏆 ' + escapeHtml(s.players[s.winner].name) + ' 获胜！'
      : '游戏结束（平局）';
    const tb = $('#score-table');
    tb.innerHTML = '<tr><th>玩家</th><th>城区</th><th>建筑分</th><th>奖励</th><th>总分</th><th class="score-detail">明细</th></tr>';
    rows.slice().sort((a, b) => b.total - a.total).forEach(r => {
      const tr = el('tr', (s.winner === r.playerIdx ? 'win' : ''));
      tr.innerHTML = '<td>' + escapeHtml(r.name) + '</td>' +
        '<td>' + r.cityCount + '</td>' +
        '<td>' + r.base + '</td>' +
        '<td>+' + r.bonus + '</td>' +
        '<td class="total">' + r.total + '</td>' +
        '<td class="score-detail">' + r.detail.map(d => escapeHtml(d.label) + ' +' + d.value).join('，') + '</td>';
      tb.appendChild(tr);
    });
    showScreen('screen-over');
  }

  /* ============================== 参考弹层 ============================== */
  function openCharacters() {
    $('#modal-title').textContent = '角色一览';
    const body = $('#modal-body');
    body.innerHTML = '';
    const s = App.state;
    const used = (s && s.charDeck && s.charDeck.length)
      ? s.charDeck.slice()
      : Cards.CHARACTERS.map(c => ({ id: c.id, num: c.num, name: c.name, en: c.en, desc: c.desc }));

    body.appendChild(el('div', 'section-title', '本局角色（按编号）'));
    const cg = el('div', 'char-grid');
    used.slice().sort((a, b) => a.num - b.num).forEach(c => {
      const d = el('div', 'ref-card');
      const img = roleImage(c);
      const art = img ? '<img class="rc-art" src="' + img + '" alt="' + escapeHtml(c.name) + '">' : '';
      // 角色卡图已含效果文字，顶部仅保留名称，不再重复说明
      d.innerHTML = art + '<h4><span class="rc-num">' + c.num + '</span>' + c.name +
        '<span class="rc-en">' + c.en + '</span></h4>';
      cg.appendChild(d);
    });
    body.appendChild(cg);
    $('#modal').hidden = false;
  }

  function openBuildings() {
    $('#modal-title').textContent = '建筑一览';
    const body = $('#modal-body');
    body.innerHTML = '';
    const s = App.state;

    body.appendChild(el('div', 'section-title', '建筑颜色与收入角色'));
    const lg = el('div', 'color-legend');
    ['yellow', 'blue', 'green', 'red', 'purple'].forEach(k => {
      const col = Cards.COLORS[k];
      lg.appendChild(el('span', '',
        '<i class="dot" style="background:' + col.hex + '"></i>' + col.name + '（' + col.en + '）' +
        (col.incomeChar ? ' — 提供 ' + col.incomeChar + ' 号角色收入' : ' — 独特建筑')));
    });
    body.appendChild(lg);

    body.appendChild(el('div', 'section-title', '全部建筑（按颜色，含特殊效果）'));
    ['yellow', 'blue', 'green', 'red', 'purple'].forEach(k => {
      const col = Cards.COLORS[k];
      body.appendChild(el('div', 'color-sub', col.name + '（' + col.en + '）'));
      const grp = el('div', 'char-grid');
      Cards.DISTRICTS.filter(d => d.color === k).sort((a, b) => a.cost - b.cost).forEach(d => {
        const e = el('div', 'ref-card');
        e.innerHTML = '<h4>' + d.name + '<span class="rc-en">' + d.en + ' · ' + d.cost + ' 金</span></h4>' +
          (d.desc ? '<p>' + d.desc + '</p>' : '<p class="dim">— 无特殊效果，仅计入建筑分</p>');
        grp.appendChild(e);
      });
      body.appendChild(grp);
    });

    body.appendChild(el('div', 'section-title', '计分方式'));
    body.appendChild(el('p', 'small',
      '建筑总分（建造费用之和，巨龙门/大学按 8 分计）＋ 五色齐全 +3 ＋ 率先建成 ' +
      (s ? s.endDistricts : 8) + ' 栋 +4（其余达标者 +2）＋ 博物馆/美化等特殊加分。'));
    $('#modal').hidden = false;
  }

  function openRules() {
    $('#modal-title').textContent = '游戏规则';
    const body = $('#modal-body');
    body.innerHTML =
      '<div class="section-title">一局总体流程</div>' +
      '<p class="small">① 按人数随机移除若干角色牌（部分明置、部分暗置，4 号角色不会被明置移除）→ ' +
      '② 由皇冠持有者开始依次秘密选角，每号角色只能有一张 → ' +
      '③ 皇冠持有者按编号叫号，被叫到的玩家公开角色并执行回合 → ' +
      '④ 全部角色行动完毕后结束一轮，角色牌重洗进入下一轮。</p>' +
      '<div class="section-title">每个回合的具体操作</div>' +
      '<p class="small"><b>第 1 步 · 领取资源（二选一）</b>：拿 2 枚金币，或抽 2 张建筑牌保留 1 张（另一张放回牌堆底）。<br><br>' +
      '<b>第 2 步 · 建造</b>：支付费用打出 1 栋建筑（通常每回合限 1 栋，建筑师 3 栋、学者/预言家 2 栋）。城市中不可有同名建筑。<br><br>' +
      '<b>第 3 步 · 使用角色能力</b>：回合内任意时机可使用一次，也可不使用（如刺客刺杀、小偷偷金、建筑师多建、商人加金、魔法师换牌、女巫夺取他人回合等）。<br><br>' +
      '<b>第 4 步 · 结束回合</b>：轮到下一编号角色行动，直至全部角色行动完毕。</p>' +
      '<div class="section-title">结束与计分</div>' +
      '<p class="small">有玩家建成第 8 栋建筑时，本轮结束后游戏结束。分数＝建筑费用总和' +
      '＋五色齐全 3 分＋率先达标 4 分（其他达标者 2 分）＋特殊建筑加分，最高者获胜。</p>' +
      '<div class="section-title">皇冠</div>' +
      '<p class="small">拥有皇冠者本轮优先选角。若有人使用 4 号角色，皇冠立即转移给该玩家；' +
      '被刺杀的国王仍会在轮末获得皇冠。</p>';
    $('#modal').hidden = false;
  }

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
    $('#lobby-pre').hidden = true;
    $('#lobby-room').hidden = false;
    $('#r-code').textContent = st.roomId;
    $('#lobby-title').textContent = '房间 ' + st.roomId;
    if (st.config) {
      $('#r-players').value = String(st.config.playerCount || 4);
      $('#r-end').value = String(st.config.endDistricts || 8);
      $('#r-chars').value = st.config.charSetMode || 'base';
    }
    const grid = $('#seat-grid');
    grid.innerHTML = '';
    const seats = st.seats || [];
    const amHost = seats.length && seats[0].id === App.myId;
    seats.forEach((s, i) => {
      const d = el('div', 'seat' + (s.taken ? ' taken' : '') + (s.id === App.myId ? ' me' : ''));
      d.innerHTML = '<div class="seat-no">座位 ' + (i + 1) + (i === 0 ? ' · 房主' : '') + '</div>' +
        '<div class="seat-name">' + (s.taken ? escapeHtml(s.name) : '空缺') + '</div>' +
        '<div class="seat-tag">' + (s.isBot ? '电脑' : (s.taken ? '真人玩家' : '可加入')) + '</div>';
      if (amHost && i > 0) {
        const ops = el('div', 'seat-ops');
        const b1 = el('button', 'btn tiny', s.isBot ? '换人' : '设为电脑');
        b1.onclick = () => Net.send({ t: 'setSeat', index: i, kind: s.isBot ? 'open' : 'bot' });
        ops.appendChild(b1);
        d.appendChild(ops);
      }
      grid.appendChild(d);
    });
    $('#btn-net-start').style.display = amHost ? '' : 'none';
  }

  /* ============================== 事件绑定 ============================== */
  function bind() {
    $$('[data-goto]').forEach(b => b.onclick = () => showScreen('screen-' + b.dataset.goto));

    $('#btn-single').onclick = () => showScreen('screen-setup');
    $('#btn-online').onclick = () => {
      showScreen('screen-lobby');
      Net.name = $('#net-name').value || '玩家';
      Net.connect(() => { Net.send({ t: 'listRooms' }); });
    };
    $('#btn-rules').onclick = openRules;
    $('#modal-close').onclick = closeModal;
    $('#modal').onclick = e => { if (e.target === $('#modal')) closeModal(); };

    // 关键事件弹层
    $('#event-ok').onclick = dismissEvent;
    $('#event-overlay').onclick = e => { if (e.target === $('#event-overlay')) dismissEvent(); };

    // 得分明细浮动窗口
    $('#btn-my-score').onclick = () => openScore(App.myIdx);
    $('#score-close').onclick = closeScore;
    $('#score-popup').onclick = e => { if (e.target === $('#score-popup')) closeScore(); };

    // 选角卡图悬浮放大
    initCharZoom();

    // 电脑节奏：设置页下拉 + 对局内一键切换
    loadSpeed();
    if ($('#cfg-speed')) {
      $('#cfg-speed').value = App.speed;
      $('#cfg-speed').onchange = () => {
        App.speed = PACE[$('#cfg-speed').value] ? $('#cfg-speed').value : 'normal';
        saveSpeed(); syncSpeedBtn();
      };
    }
    $('#btn-speed').onclick = cycleSpeed;
    syncSpeedBtn();

    $('#btn-start-single').onclick = () => {
      const cfg = {
        players: Number($('#cfg-players').value),
        level: $('#cfg-level').value,
        end: Number($('#cfg-end').value),
        chars: $('#cfg-chars').value,
        name: ($('#cfg-name').value || '我').trim()
      };
      if ($('#cfg-speed') && PACE[$('#cfg-speed').value]) {
        App.speed = $('#cfg-speed').value; saveSpeed();
      }
      App.lastCfg = cfg; App.mode = 'local'; App.name = cfg.name;
      Local.start(cfg);
      showScreen('screen-game');
    };

    // 联机
    $('#btn-create').onclick = () => {
      Net.name = ($('#net-name').value || '玩家').trim();
      Net.connect(() => {
        Net.send({
          t: 'createRoom', name: Net.name, config: {
            playerCount: Number($('#net-players').value),
            bots: Number($('#net-bots').value),
            endDistricts: Number($('#net-end').value),
            charSetMode: $('#net-chars').value,
            botLevel: 'normal',
            // 房主的节奏偏好决定服务器上机器人的行动间隔
            botPace: pace().act
          }
        });
      });
      App.mode = 'net';
    };
    $('#btn-join').onclick = () => {
      const code = ($('#net-code').value || '').trim().toUpperCase();
      if (code.length !== 4) { toast('请输入 4 位房间号'); return; }
      Net.name = ($('#net-name').value || '玩家').trim();
      Net.connect(() => Net.send({ t: 'joinRoom', roomId: code, name: Net.name }));
      App.mode = 'net';
    };
    $('#btn-refresh').onclick = () => Net.send({ t: 'listRooms' });
    $('#btn-leave').onclick = () => {
      Net.send({ t: 'leaveRoom' });
      $('#lobby-pre').hidden = false; $('#lobby-room').hidden = true;
      $('#lobby-title').textContent = '联机大厅';
      Net.send({ t: 'listRooms' });
    };
    $('#btn-net-start').onclick = () => Net.send({ t: 'startGame' });
    ['r-players', 'r-end', 'r-chars'].forEach(id => {
      $('#' + id).onchange = () => {
        Net.send({
          t: 'config', config: {
            playerCount: Number($('#r-players').value),
            endDistricts: Number($('#r-end').value),
            charSetMode: $('#r-chars').value
          }
        });
      };
    });

    // 对局内
    $('#btn-back-home').onclick = () => {
      if (App.state && App.state.phase !== 'gameover' && !confirm('确定离开当前对局吗？')) return;
      showScreen('screen-home');
    };
    $('#btn-chars').onclick = openCharacters;
    $('#btn-buildings').onclick = openBuildings;
    $('#btn-rules-top').onclick = openRules;
    $('#btn-log-toggle').onclick = () => {
      const sp = $('#side-panel');
      const willShow = !sp.classList.contains('show');
      // 竖屏下拉需从顶栏下沿开始：同步顶栏实际高度，避免盖住按钮也无法返回
      const tb = document.querySelector('.topbar');
      if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
      sp.classList.toggle('show');
      if (willShow && App.state) renderLog(App.state);
    };
    $('#btn-again').onclick = () => {
      if (App.mode === 'local' && App.lastCfg) {
        Local.start(App.lastCfg); showScreen('screen-game');
      } else if (App.mode === 'net') {
        Net.send({ t: 'restart' });
        $('#lobby-pre').hidden = true; $('#lobby-room').hidden = false;
        showScreen('screen-lobby');
      }
    };
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  bind();
  // 供自动化测试驱动使用
  App.__local = Local;
  App.__net = Net;
  window.__CitadelsApp = App;
})();
