/* =========================================================================
 * 富饶之城 — 客户端
 * 支持：本地单人（与电脑对战，引擎跑在浏览器里） / 联机（引擎跑在服务器）
 * ========================================================================= */
(function () {
  'use strict';
  const Cards = window.CitCards, Engine = window.CitEngine, AI = window.CitAI;
  const Theme = window.CitadelThemeManager || {
    current: 'classic',
    is(id) { return id === 'classic'; },
    label() { return '经典羊皮纸'; },
    apply() {},
    toggle() {},
    updateControls() {},
    roleAsset() { return null; },
    districtAsset() { return null; },
    onChange() { return function () {}; }
  };

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
    buildingAnimPaused: false,
    noticeSeen: null,      // 已展示到第几条关键事件（seq）
    _reveal: {},           // 每位玩家上一帧的角色卡状态，用于检测「盖牌→翻面」触发动画
    myIdx: null,
    leavingNetGame: false
  };

  const NET_SESSION_KEY = 'citadels.net.session';
  function loadNetSession() {
    try {
      const raw = window.localStorage.getItem(NET_SESSION_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && data.token && data.roomId ? data : null;
    } catch (e) { return null; }
  }
  function saveNetSession(token, roomId, name) {
    if (!token || !roomId) return;
    try {
      window.localStorage.setItem(NET_SESSION_KEY,
        JSON.stringify({ token: token, roomId: roomId, name: name || '' }));
    } catch (e) { /* 隐私模式或存储被禁用 */ }
  }
  function clearNetSession() {
    try { window.localStorage.removeItem(NET_SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /* --------------------------- 电脑行动节奏 ---------------------------
   * 原先固定 330ms，真人根本来不及看清电脑做了什么。
   * 现在按「这一步有多值得看」分级停顿：
   *   draft  选角（信息量大，要看清谁拿了什么）
   *   big    宣告刺杀/施咒、建造、摧毁抢夺（关键局势变化）
   *   act    领资源、用能力、结束回合
   *   min    其它内部推进步骤
   * ------------------------------------------------------------------ */
  const PACE = {
    slow:   { draft: 1700, big: 2100, act: 1300, min: 700, label: '慢速' },
    normal: { draft: 1050, big: 1300, act: 820,  min: 430, label: '标准' },
    fast:   { draft: 420,  big: 480,  act: 330,  min: 190, label: '快速' }
  };
  const SPEED_ORDER = ['slow', 'normal', 'fast'];
  // 主题界面使用纯文本标签，避免速度按钮被图标字体或系统表情影响布局。
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
  function syncThemeBtn() {
    const b = $('#btn-theme');
    if (!b || !Theme.label) return;
    b.textContent = '主题 · ' + Theme.label();
    b.title = '当前：' + Theme.label() + '，点击切换';
  }
  function cycleSpeed() {
    const i = SPEED_ORDER.indexOf(App.speed);
    App.speed = SPEED_ORDER[(i + 1) % SPEED_ORDER.length];
    saveSpeed(); syncSpeedBtn();
    toast('电脑节奏：' + pace().label);
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
    // 触屏设备：把动作存到 __tapFn，绑定一次监听器即可。这样卡片节点被
    // keyed reconciliation 复用时，只需更新 __tapFn 而不会重复 addEventListener。
    node.__tapFn = fn;
    if (node.__tapBound) return;
    node.__tapBound = true;
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
      const f = node.__tapFn; if (f) f();
    }, { passive: false });
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function handleRoomNotice(n) {
    if (!n) return;
    const name = n.playerName || '玩家';
    if (n.kind === 'player_disconnected') toast('⚠ ' + name + ' 已断连（超过 20 秒未响应）');
    else if (n.kind === 'player_left') toast('↩ ' + name + ' 已离开房间');
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
    $('#event-icon').textContent = opt.icon || 'i';
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
            tone: 'danger', icon: '!', title: '你被刺杀了！', hold: 6000,
            text: escapeHtml(n.byName) + ' 的【刺客】宣布刺杀 <b>' + n.num + ' 号角色</b>，' +
                  '正是你的『<b>' + escapeHtml(myCharName(s, n.num)) + '</b>』。<br>' +
                  '本轮叫到它时会<b>直接跳过</b>——不能领资源、不能建造、不能用能力。'
          });
        } else toast('! ' + n.byName + ' 宣布刺杀 ' + n.num + ' 号角色');
        return;

      case 'witch_declare':
        if (byMe) return;
        if (holdsIt) {
          App.deathWarned = n.round;
          queueEvent({
            tone: 'magic', icon: '*', title: '你被施咒了！', hold: 6000,
            text: escapeHtml(n.byName) + ' 的【女巫】对 <b>' + n.num + ' 号角色</b>施咒，' +
                  '正是你的『<b>' + escapeHtml(myCharName(s, n.num)) + '</b>』。<br>' +
                  '你这回合<b>只能领取资源</b>，随后由女巫接管该角色的剩余行动。'
          });
        } else toast('* ' + n.byName + ' 对 ' + n.num + ' 号角色施咒');
        return;

      case 'thief_declare':
        if (byMe) return;
        if (holdsIt) {
          queueEvent({
            tone: 'warn', icon: '$', title: '盗贼盯上了你', hold: 5000,
            text: escapeHtml(n.byName) + ' 的【盗贼】宣布偷窃 <b>' + n.num + ' 号角色</b>（你的『' +
                  escapeHtml(myCharName(s, n.num)) + '』）。<br>' +
                  '轮到你时手上的金币会被<b>全部拿走</b>，建议先想好怎么花。'
          });
        } else toast('$ ' + n.byName + ' 宣布偷窃 ' + n.num + ' 号角色');
        return;

      case 'assassinated':
        if (isMe) {
          // 极少数情况（中途接管 / 漏掉了宣告）没提前警告过，这里补一次弹层
          if (App.deathWarned !== n.round) {
            queueEvent({
              tone: 'danger', icon: '!', title: '本回合被跳过', hold: 5000,
              text: '你的『<b>' + escapeHtml(n.charName) + '</b>』（' + n.num + ' 号）已被刺杀，' +
                    '本回合直接跳过，无法行动。'
            });
          } else toast('! 你的『' + n.charName + '』被刺杀，本回合已跳过');
        } else toast('! ' + n.playerName + ' 的『' + n.charName + '』被刺杀，跳过回合');
        return;

      case 'bewitched':
        if (isMe) toast('* 你的『' + n.charName + '』被施咒，本回合只能领资源');
        else toast('* ' + n.playerName + ' 的『' + n.charName + '』被施咒');
        return;

      case 'thief_steal':
        flyCoins(n.playerIdx, n.byIdx, n.amount);
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '$', title: '金币被偷走了', hold: 4200,
            text: '【盗贼】' + escapeHtml(n.byName) + ' 从你这里拿走了 <b>' + n.amount + ' 枚金币</b>。'
          });
        } else toast('$ ' + n.byName + ' 偷走了 ' + n.playerName + ' 的 ' + n.amount + ' 金');
        return;

      case 'destroyed':
        destroyAnim(n.playerIdx, n.uid, n.cardName);
        if (isMe) {
          queueEvent({
            tone: 'danger', icon: '!', title: '你的建筑被摧毁', hold: 4800,
            text: escapeHtml(n.byName) + ' 用【领主】支付 ' + n.cost + ' 金，' +
                  '摧毁了你的『<b>' + escapeHtml(n.cardName) + '</b>』。'
          });
        } else toast('! ' + n.byName + ' 摧毁了 ' + n.playerName + ' 的『' + n.cardName + '』');
        return;

      case 'seized':
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '!', title: '你的建筑被抢走', hold: 4800,
            text: escapeHtml(n.byName) + ' 用【元帅】支付 ' + n.cost + ' 金，' +
                  '抢走了你的『<b>' + escapeHtml(n.cardName) + '</b>』（金币已补偿给你）。'
          });
        } else toast('! ' + n.byName + ' 抢走了 ' + n.playerName + ' 的『' + n.cardName + '』');
        return;

      case 'got_gold':
        flyGoldIn(n.playerIdx, n.amount);
        return;

      case 'monk_take':
        flyCoins(n.fromIdx, n.toIdx, n.amount || 1);
        return;

      case 'crown_transfer':
        crownTransferAnim(n.fromIdx, n.toIdx);
        return;

      case 'emperor_gold':
        // 皇帝从目标玩家处取得金币：金币从目标玩家飞向皇帝。
        flyCoins(n.fromIdx, n.toIdx, n.amount || 1);
        return;

      case 'emperor_card':
        // 皇帝从目标玩家处取得手牌：只显示一张牌背，避免泄露具体牌面。
        handTransferAnim(n.fromIdx, n.toIdx);
        return;

      case 'built':
        beginBuildingAnimation();
        buildingBuildAnim(n.playerIdx, n.card, endBuildingAnimation);
        return;

      case 'alchemist_refund':
        // 炼金术士回合结束回收建造费：沿用金币飞行动画，并补充明确提示。
        flyGoldIn(n.playerIdx, n.amount);
        if (isMe) {
          queueEvent({
            tone: 'good', icon: '⚗', title: '炼金术士回收金币', hold: 4200,
            text: '本回合建筑花费已返还：<b>' + n.amount + ' 枚金币</b>。'
          });
        } else {
          toast('⚗ ' + n.playerName + ' 回收了 ' + n.amount + ' 枚建造金币');
        }
        return;

      case 'magician_swap':
        // 所有人都看到两端之间的背面手牌交换动画，不泄露具体牌面。
        handSwapAnim(n.byIdx, n.playerIdx);
        if (isMe) {
          queueEvent({
            tone: 'magic', icon: '↔', title: '你的手牌被交换了', hold: 5000,
            text: '【魔术师】' + escapeHtml(n.byName) + ' 与你交换了<b>全部手牌</b>。'
          });
        } else if (byMe) {
          toast('↔ 你与 ' + escapeHtml(n.playerName) + ' 交换了全部手牌');
        } else {
          toast('↔ ' + escapeHtml(n.byName) + ' 与 ' + escapeHtml(n.playerName) + ' 交换了全部手牌');
        }
        return;

      case 'round_end':
        return;

      case 'swapped':
        buildingSwapAnim(n.byIdx, n.playerIdx, n.mineCard, n.theirsCard);
        if (isMe) {
          queueEvent({
            tone: 'warn', icon: '<>', title: '建筑被外交官换走', hold: 4800,
            text: escapeHtml(n.byName) + ' 用『' + escapeHtml(n.gotName) + '』' +
                  '换走了你的『<b>' + escapeHtml(n.cardName) + '</b>』。'
          });
        } else toast('<> ' + n.byName + ' 与 ' + n.playerName + ' 交换了建筑');
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
      // sanitize() 只向客户端公开 currentPlayer；本地机器人使用原始引擎状态，
      // 两种状态都要兼容。
      if (st.draft.currentPlayer != null) {
        return st.players.find(p => p.id === st.draft.currentPlayer) || null;
      }
      const step = st.draft.steps && st.draft.steps[st.draft.stepIdx];
      return step ? st.players[step.player] : null;
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
        // AI 无法给出决策时，使用引擎返回的第一个合法动作，避免电脑选角停死。
        if (!action) {
          const opts = Engine.getAvailableActions(st, actor.id);
          if (opts && opts.actions && opts.actions.length) action = opts.actions[0];
        }
        if (action) {
          let res = Engine.applyAction(st, actor.id, action);
          if (!res.ok) {
            console.warn('电脑行动失败：' + res.error);
            if (st.phase === 'draft') {
              // 选角失败时从合法行动中挑第一个再试一次，避免空转卡死
              const opts = Engine.getAvailableActions(st, actor.id);
              if (opts && opts.actions && opts.actions.length) {
                res = Engine.applyAction(st, actor.id, opts.actions[0]);
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
    ws: null, myId: null, roomId: null, name: '', onState: null, afterHello: null,
    reconnectTimer: null, reconnectDelay: 1000, heartbeatTimer: null,
    startHeartbeat() {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === 1) this.send({ t: 'heartbeat', ts: Date.now() });
      }, 5000);
    },
    stopHeartbeat() { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; },
    connect(cb) {
      if (this.ws && this.ws.readyState === 1) return cb && cb();
      this.afterHello = cb || this.afterHello || null;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(proto + '://' + location.host);
      this.ws.onopen = () => {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnectDelay = 1000;
        this.startHeartbeat();
        const saved = loadNetSession();
        this.send({ t: 'hello', name: this.name,
          resumeToken: saved && saved.token, roomId: saved && saved.roomId });
      };
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.handle(m);
      };
      this.ws.onclose = () => {
        this.stopHeartbeat();
        toast('与服务器的连接已断开');
        $$('#screen-lobby .dim').forEach(() => {});
        // 联机游戏中刷新服务或短暂断网时，自动使用本地令牌回到原房间。
        // 不清空 App.state，让画面在重连期间保留最后一个已知状态。
        if (!loadNetSession() || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(8000, Math.round(this.reconnectDelay * 1.6));
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect(() => this.send({ t: 'listRooms' }));
        }, delay);
      };
      this.ws.onerror = () => toast('无法连接服务器');
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
          // 大厅里加入 → 从 0 开始（后续事件全部提示）；中途加入 → 对齐进度，不回放历史
          App.noticeSeen = (m.state.notices && m.state.notices.length)
            ? m.state.notices[m.state.notices.length - 1].seq : 0;
          App.paused = false; hideEvent(true);
          if (m.state.phase === 'lobby') { renderLobbyRoom(m.state); showScreen('screen-lobby'); }
          else { App.state = m.state; showScreen('screen-game'); render(); }
          break;
        case 'state':
          if (App.leavingNetGame) break;
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
        case 'roomNotice': handleRoomNotice(m.notice); break;
      }
    },
    action(a) { this.send({ t: 'action', action: a }); }
  };

  function send(action) {
    if (App.buildingAnimPaused) return;
    // 选角牌的点击可能在状态广播与 DOM 重绘之间落后一个瞬间。
    // 如果选角已经结束，丢弃这次陈旧点击，避免把 draft_pick 发到行动阶段。
    if (action && (action.type === 'draft_pick' || action.type === 'draft_discard')) {
      const d = App.state && App.state.draft;
      const viewerId = App.state && (App.state.you || App.myId);
      if (!App.state || App.state.phase !== 'draft' || !d || d.currentPlayer !== viewerId) {
        App.sel = null;
        if (typeof closeCharZoomPreview === 'function') closeCharZoomPreview();
        if (App.state) render();
        toast('选角已结束或当前不是你的选角回合');
        return;
      }
    }
    if (App.mode === 'local') Local.send(action);
    else Net.action(action);
  }

  /* ============================== 卡牌渲染 ============================== */
  function cardClassOf(c, opts) {
    opts = opts || {};
    const neon = Theme.is && Theme.is('neon');
    return 'card c-' + c.color + (neon ? ' neon-card' : '') + (opts.mini ? ' mini' : '') +
      (opts.clickable ? ' clickable' : '') + (opts.disabled ? ' disabled' : '') +
      (opts.selected ? ' selected' : '') + (opts.pickable ? ' pickable' : '');
  }

  function cardNode(c, opts) {
    opts = opts || {};
    const neon = Theme.is && Theme.is('neon');
    const d = el('div', cardClassOf(c, opts));
    d.dataset.uid = c.uid;
    d.title = (c.desc ? c.desc + '\n' : '') + c.name + ' · ' + Cards.COLORS[c.color].name +
      ' · 花费 ' + c.cost + (c.scoreValue && c.scoreValue !== c.cost ? ' · 计分 ' + c.scoreValue : '');
    const art = neon && Theme.districtAsset ? Theme.districtAsset(c, 'thumb') : null;
    const full = neon && Theme.districtAsset ? Theme.districtAsset(c, 'full') : null;
    if (art) {
      const img = el('img', 'card-art');
      img.src = art;
      img.alt = c.name;
      // 不再用 loading="lazy"：每次 render 都会重建 DOM，懒加载图片在移动端会
      // 出现「空白→加载」的闪烁。去掉后新节点立即（从缓存）解码，配合 keyed
      // reconciliation（syncCards）复用节点，彻底消除每步行动的画面闪烁。
      img.decoding = 'async';
      d.appendChild(img);
      if (d.dataset) {
        d.dataset.zoomSrc = full || art;
        d.dataset.zoomTitle = c.name;
      }
    } else {
      d.appendChild(el('div', 'c-top'));
      d.appendChild(el('div', 'c-cost', String(c.cost)));
      d.appendChild(el('div', 'c-name', c.name));
      d.appendChild(el('div', 'c-en', c.en || ''));
    }
    if (c.beautified) d.appendChild(el('div', 'c-badges', '美'));
    else if (c.museumCount) d.appendChild(el('div', 'c-badges', '博' + c.museumCount));
    renderMuseumStack(d, c);
    return d;
  }

  function renderMuseumStack(node, c) {
    if (!node || !node.querySelector) return;
    const old = node.querySelector('.museum-stack');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const count = Number(c && c.museumCount) || 0;
    if (!count) return;
    const stack = el('div', 'museum-stack');
    stack.title = '博物馆下叠放 ' + count + ' 张牌';
    stack.setAttribute('aria-label', stack.title);
    for (let i = 0; i < Math.min(3, count); i++) {
      const back = el('span', 'museum-stack-card');
      back.style.setProperty('--stack-index', String(i));
      stack.appendChild(back);
    }
    stack.appendChild(el('span', 'museum-stack-count', String(count)));
    node.appendChild(stack);
  }

  /* 复用已有卡片节点时，只更新外层动态属性（className / title / uid），
   * 不重建内部 <img>，从而不触发图片重新解码与闪烁。 */
  function refreshCardNode(node, c, opts) {
    node.className = cardClassOf(c, opts);
    if (node.dataset) node.dataset.uid = c.uid;
    node.title = (c.desc ? c.desc + '\n' : '') + c.name + ' · ' + Cards.COLORS[c.color].name +
      ' · 花费 ' + c.cost + (c.scoreValue && c.scoreValue !== c.cost ? ' · 计分 ' + c.scoreValue : '');
    renderMuseumStack(node, c);
  }

  /* 按 uid 复用卡片节点的列表渲染：不整盘 innerHTML 清空，已存在的卡片
   * （含内部 <img>）保留不动，只增删变化项并微调顺序。这是消除霓虹主题
   * 「每行动一次整盘重绘→图片闪烁」的根本手段。 */
  function syncCards(container, cards, optsFor, onNode) {
    if (!container) return;
    const existing = {};
    Array.prototype.forEach.call(container.children, ch => {
      const k = ch.dataset && ch.dataset.uid;
      if (k) existing[k] = ch;
    });
    const keep = {};
    const frag = document.createDocumentFragment();
    cards.forEach(c => {
      let node = existing[c.uid];
      if (node) refreshCardNode(node, c, optsFor(c));
      else node = cardNode(c, optsFor(c));
      keep[c.uid] = node;
      if (onNode) onNode(node, c, optsFor(c));
      frag.appendChild(node);
    });
    // 移除已不在列表中的旧节点
    Array.prototype.forEach.call(container.children, ch => {
      const k = ch.dataset && ch.dataset.uid;
      if (k && !keep[k] && ch.parentNode) ch.parentNode.removeChild(ch);
    });
    container.appendChild(frag);
  }

  /* 经典主题沿用旧插画；霓虹主题严格按角色 id 映射最终完整卡图。 */
  const ROLE_IMG = { 1: '刺客', 2: '小偷', 3: '魔术师', 4: '国王', 5: '住持', 6: '商人', 7: '建筑师', 8: '领主' };
  function roleImage(c) {
    if (!c || !ROLE_IMG[c.num]) return null;
    return 'images/roles/' + ROLE_IMG[c.num] + '.jpg';
  }

  function roleThumb(c) {
    if (Theme.is && Theme.is('neon') && Theme.roleAsset) return Theme.roleAsset(c, 'thumb');
    return roleImage(c);
  }
  function roleFull(c) {
    if (Theme.is && Theme.is('neon') && Theme.roleAsset) return Theme.roleAsset(c, 'full');
    return roleImage(c);
  }
  function charMeta(id, num) {
    if (id && Engine && Engine.CHAR_MAP && Engine.CHAR_MAP[id]) return Engine.CHAR_MAP[id];
    if (Engine && Engine.CHAR_MAP) {
      const values = Object.values(Engine.CHAR_MAP);
      return values.find(c => c.num === num) || null;
    }
    return id ? { id: id, num: num, name: String(num || '') } : null;
  }

  function charNode(c, opts) {
    opts = opts || {};
    const neon = Theme.is && Theme.is('neon');
    const d = el('div', 'char-card' + (neon ? ' neon-role-card' : '') + (opts.dim ? ' faceup-char' : '') +
      (opts.clickable ? ' clickable' : '') + (opts.mini ? ' mini' : ''));
    if (d.dataset && c.id) d.dataset.uid = c.id;
    const img = roleThumb(c);
    const full = roleFull(c);
    let art = '<div class="cc-art">';
    if (img) art += '<img src="' + img + '" alt="' + escapeHtml(c.name) + '" decoding="async">';
    else art += '<div class="cc-art-emoji">' + escapeHtml(String(c.num || '?')) + '</div>';
    art += '</div>';
    // 霓虹卡图本身已含编号、名称与规则；经典主题保留原来的简化卡牌排版。
    d.innerHTML = neon ? art : art +
      '<div class="cc-num">' + c.num + '</div>' +
      '<div class="cc-name">' + c.name + '</div>';
    if (img && d.dataset) {
      d.dataset.zoomSrc = full || img;
      d.dataset.zoomTitle = c.name;
    }
    return d;
  }

  let cardHdPreviousFocus = null;
  const CARD_HD_ZOOM_MIN = 0.5;
  const CARD_HD_ZOOM_MAX = 3;
  const CARD_HD_ZOOM_STEP = 0.25;
  let cardHdZoom = 1;
  let cardHdPan = { x: 0, y: 0 };
  let cardHdRenderView = function () {};
  let cardHdPreviewCloser = null;
  let closeCharZoomPreview = null;

  function setCardHdZoom(value) {
    const next = Math.max(CARD_HD_ZOOM_MIN, Math.min(CARD_HD_ZOOM_MAX, Number(value) || 1));
    cardHdZoom = Math.round(next * 100) / 100;
    cardHdRenderView();
  }

  function resetCardHdView() {
    cardHdZoom = 1;
    cardHdPan = { x: 0, y: 0 };
    cardHdRenderView();
  }

  function openCardHd(src, title, previewCloser) {
    const overlay = $('#card-hd-overlay');
    const img = $('#card-hd-img');
    const titleEl = $('#card-hd-title');
    if (!overlay || !img || !src) return;
    cardHdPreviewCloser = typeof previewCloser === 'function' ? previewCloser : null;
    cardHdPreviousFocus = document.activeElement || null;
    resetCardHdView();
    img.src = src;
    img.alt = (title || '卡牌') + '高清大图';
    if (titleEl) titleEl.textContent = title || '卡牌高清大图';
    overlay.hidden = false;
    if (document.body && document.body.classList) document.body.classList.add('card-hd-open');
    const close = $('#card-hd-close');
    if (close && close.focus) close.focus();
  }

  function closeCardHd() {
    const overlay = $('#card-hd-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    if (document.body && document.body.classList) document.body.classList.remove('card-hd-open');
    const previous = cardHdPreviousFocus;
    const previewCloser = cardHdPreviewCloser;
    cardHdPreviousFocus = null;
    cardHdPreviewCloser = null;
    if (previewCloser) previewCloser();
    // 高清图从悬浮预览打开时，原按钮会随预览一起隐藏，不再把焦点放回隐藏节点。
    if (previous && previous.focus && !previous.hidden && previous.isConnected !== false) previous.focus();
  }

  function openCardHdFrom(trigger) {
    if (!trigger || !trigger.getAttribute) return;
    const fromPreview = trigger.closest && trigger.closest('#char-zoom');
    openCardHd(
      trigger.getAttribute('data-hd-src'),
      trigger.getAttribute('data-hd-title') || trigger.getAttribute('aria-label') || '卡牌',
      fromPreview ? closeCharZoomPreview : null
    );
  }

  function initCardHd() {
    const overlay = $('#card-hd-overlay');
    if (!overlay) return;
    const close = $('#card-hd-close');
    const stage = document.querySelector('.card-hd-stage');
    const img = $('#card-hd-img');
    const zoomOut = $('#card-hd-zoom-out');
    const zoomReset = $('#card-hd-zoom-reset');
    const zoomIn = $('#card-hd-zoom-in');
    const zoomValue = $('#card-hd-zoom-value');
    if (close) close.onclick = closeCardHd;
    overlay.onclick = e => { if (e.target === overlay) closeCardHd(); };

    function clampPan() {
      if (!stage || !img) return;
      const width = Number(img.clientWidth) || 0;
      const height = Number(img.clientHeight) || 0;
      const stageWidth = Number(stage.clientWidth) || 0;
      const stageHeight = Number(stage.clientHeight) || 0;
      const maxX = Math.max(0, (width * cardHdZoom - stageWidth) / 2);
      const maxY = Math.max(0, (height * cardHdZoom - stageHeight) / 2);
      cardHdPan.x = Math.max(-maxX, Math.min(maxX, cardHdPan.x));
      cardHdPan.y = Math.max(-maxY, Math.min(maxY, cardHdPan.y));
    }

    function renderView() {
      clampPan();
      if (img && img.style) {
        img.style.transform = 'translate3d(' + cardHdPan.x + 'px,' + cardHdPan.y + 'px,0) scale(' + cardHdZoom + ')';
        img.style.transformOrigin = 'center center';
        img.style.cursor = cardHdZoom > 1 ? 'grab' : 'default';
      }
      if (zoomValue) {
        zoomValue.textContent = Math.round(cardHdZoom * 100) + '%';
        if (zoomValue.setAttribute) zoomValue.setAttribute('aria-valuenow', String(Math.round(cardHdZoom * 100)));
      }
      if (zoomOut) zoomOut.disabled = cardHdZoom <= CARD_HD_ZOOM_MIN;
      if (zoomIn) zoomIn.disabled = cardHdZoom >= CARD_HD_ZOOM_MAX;
      if (stage && stage.classList) {
        if (cardHdZoom > 1) stage.classList.add('zoomed');
        else stage.classList.remove('zoomed');
      }
    }
    cardHdRenderView = renderView;
    if (img && img.addEventListener) img.addEventListener('load', renderView);
    if (zoomOut) zoomOut.onclick = () => setCardHdZoom(cardHdZoom - CARD_HD_ZOOM_STEP);
    if (zoomReset) zoomReset.onclick = resetCardHdView;
    if (zoomIn) zoomIn.onclick = () => setCardHdZoom(cardHdZoom + CARD_HD_ZOOM_STEP);

    // 桌面拖拽：只在放大后接管鼠标，避免影响按钮和普通滚动。
    let mouseDrag = null;
    function stopMouseDrag() {
      mouseDrag = null;
      if (stage && stage.classList) stage.classList.remove('is-dragging');
      if (img && img.style) img.style.cursor = cardHdZoom > 1 ? 'grab' : 'default';
    }
    if (stage && stage.addEventListener) {
      stage.addEventListener('mousedown', e => {
        if (e.button !== 0 || cardHdZoom <= 1) return;
        mouseDrag = { x: e.clientX, y: e.clientY, panX: cardHdPan.x, panY: cardHdPan.y };
        if (stage.classList) stage.classList.add('is-dragging');
        if (e.preventDefault) e.preventDefault();
      });
      stage.addEventListener('wheel', e => {
        if (!e.deltaY) return;
        if (e.preventDefault) e.preventDefault();
        setCardHdZoom(cardHdZoom + (e.deltaY < 0 ? CARD_HD_ZOOM_STEP : -CARD_HD_ZOOM_STEP));
      }, { passive: false });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('mousemove', e => {
        if (!mouseDrag) return;
        cardHdPan.x = mouseDrag.panX + e.clientX - mouseDrag.x;
        cardHdPan.y = mouseDrag.panY + e.clientY - mouseDrag.y;
        renderView();
        if (e.preventDefault) e.preventDefault();
      });
      window.addEventListener('mouseup', stopMouseDrag);
    }

    // 手机拖拽与双指缩放；单指仅在已放大时移动卡图。
    let touchDrag = null;
    let pinch = null;
    function touchDistance(a, b) {
      const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    if (stage && stage.addEventListener) {
      stage.addEventListener('touchstart', e => {
        if (e.touches.length >= 2) {
          pinch = { distance: touchDistance(e.touches[0], e.touches[1]), zoom: cardHdZoom };
          touchDrag = null;
          if (e.preventDefault) e.preventDefault();
        } else if (e.touches.length === 1 && cardHdZoom > 1) {
          const t = e.touches[0];
          touchDrag = { x: t.clientX, y: t.clientY, panX: cardHdPan.x, panY: cardHdPan.y };
        }
      }, { passive: false });
      stage.addEventListener('touchmove', e => {
        if (pinch && e.touches.length >= 2) {
          const distance = touchDistance(e.touches[0], e.touches[1]);
          setCardHdZoom(pinch.zoom * distance / Math.max(1, pinch.distance));
          if (e.preventDefault) e.preventDefault();
        } else if (touchDrag && e.touches.length === 1) {
          const t = e.touches[0];
          cardHdPan.x = touchDrag.panX + t.clientX - touchDrag.x;
          cardHdPan.y = touchDrag.panY + t.clientY - touchDrag.y;
          renderView();
          if (e.preventDefault) e.preventDefault();
        }
      }, { passive: false });
      stage.addEventListener('touchend', e => {
        if (e.touches.length < 2) pinch = null;
        if (e.touches.length === 1 && cardHdZoom > 1) {
          const t = e.touches[0];
          touchDrag = { x: t.clientX, y: t.clientY, panX: cardHdPan.x, panY: cardHdPan.y };
        } else if (!e.touches.length) {
          touchDrag = null;
        }
      }, { passive: true });
    }

    document.addEventListener('click', e => {
      const target = e.target && e.target.closest && e.target.closest('[data-hd-src]');
      if (!target) return;
      e.preventDefault();
      openCardHdFrom(target);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.hidden) { closeCardHd(); return; }
      if (!overlay.hidden && (e.key === '+' || e.key === '=')) { e.preventDefault(); setCardHdZoom(cardHdZoom + CARD_HD_ZOOM_STEP); return; }
      if (!overlay.hidden && (e.key === '-' || e.key === '_')) { e.preventDefault(); setCardHdZoom(cardHdZoom - CARD_HD_ZOOM_STEP); return; }
      if (!overlay.hidden && e.key === '0') { e.preventDefault(); resetCardHdView(); return; }
      const target = e.target && e.target.closest && e.target.closest('[data-hd-src]');
      if (!target || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      openCardHdFrom(target);
    });
    renderView();
  }

  /* 统一卡牌预览：角色卡与建筑卡共用桌面悬浮、触屏确认与高清查看。 */
  function initCharZoom() {
    const zoom = $('#char-zoom');
    if (!zoom) return;
    const zimg = $('#char-zoom-img', zoom);
    const zback = $('#char-zoom-back', zoom);
    const zbg = $('#char-zoom-bg');
    const zact = $('#cz-actions');
    const zok = $('#cz-ok');
    const zcancel = $('#cz-cancel');
    const hdBtn = $('#cz-hd-btn');
    const W = 330; // 放大浮窗宽度
    const SEL = '[data-zoom-src],[data-zoom-back]';
    const HIDE_DELAY = 500;
    let active = null;
    let pending = null;   // 触屏下待确认的选角行动
    let hideTimer = null;
    let overlapTarget = null; // 预览层覆盖的底层卡牌，优先把点击交给它

    function cancelHide() {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    }

    function scheduleHide() {
      cancelHide();
      hideTimer = setTimeout(() => {
        hideTimer = null;
        hide();
      }, HIDE_DELAY);
    }

    function isInsideZoom(e) {
      if (zoom.hidden || !zoom.getBoundingClientRect || typeof e.clientX !== 'number' ||
          typeof e.clientY !== 'number') return false;
      const r = zoom.getBoundingClientRect();
      if (!r) return false;
      return e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top && e.clientY <= r.bottom;
    }

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
      cancelHide();
      zoom.hidden = true; active = null; pending = null; overlapTarget = null;
      if (zbg) zbg.hidden = true;
      if (zact) zact.hidden = true;
      if (hdBtn) hdBtn.hidden = true;
      if (zoom.classList) {
        zoom.classList.remove('touch');
        zoom.classList.remove('interactive');
      }
    }
    closeCharZoomPreview = hide;

    function show(trigger) {
      cancelHide();
      paint(trigger);
      active = trigger;
      zoom.hidden = false;
      const src = trigger.getAttribute('data-zoom-src');
      const zoomTitle = trigger.getAttribute('data-zoom-title') || trigger.getAttribute('aria-label') || '卡牌';
      if (hdBtn) {
        hdBtn.hidden = !src;
        if (src) {
          hdBtn.setAttribute('data-hd-src', src);
          hdBtn.setAttribute('data-hd-title', zoomTitle);
        } else {
          hdBtn.removeAttribute('data-hd-src');
          hdBtn.removeAttribute('data-hd-title');
        }
      }
      if (zoom.classList) zoom.classList.toggle('interactive', !!src);
      if (touchMode) {
        zoom.classList.add('touch');
        if (zbg) zbg.hidden = false;
        // 选角牌或可操作建筑牌，放大后在卡片下方给出「确认 / 取消」。
        pending = typeof trigger.__cardAction === 'function' ? trigger.__cardAction :
          ((trigger.dataset && trigger.dataset.pickChar)
            ? { type: trigger.dataset.pickType, charId: trigger.dataset.pickChar }
            : null);
        if (zact) zact.hidden = !pending;
        return;   // 触屏用 .touch 的居中定位（CSS），不再按卡片坐标摆放
      }
      if (zact) zact.hidden = true;
      place(trigger.getBoundingClientRect());
    }

    // 预览浮层可能挡住另一张卡牌。elementFromPoint 只会返回最上层浮层，
    // 因此使用 elementsFromPoint 找到它下面的卡牌，并排除当前正在预览的卡牌。
    function underlyingCardAt(e) {
      if (!document.elementsFromPoint || typeof e.clientX !== 'number' ||
          typeof e.clientY !== 'number') return null;
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      for (const node of stack) {
        const card = node && node.closest && node.closest(SEL);
        if (card && card !== active) return card;
      }
      return null;
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
          if (hit.__noZoom) return;
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
        if (typeof p === 'function') p();
        else if (p) send(p);
      }, { passive: false });
      if (hdBtn) hdBtn.addEventListener('touchend', e => {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        openCardHdFrom(hdBtn);
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
      // 预览框覆盖另一张卡时，优先切换到底层卡牌。
      if (isInsideZoom(e)) {
        const under = underlyingCardAt(e);
        if (under) { overlapTarget = under; show(under); return; }
        overlapTarget = null; cancelHide(); return;
      }
      const t = e.target.closest && e.target.closest(SEL);
      if (t && t !== active) { overlapTarget = null; show(t); }
      else if (e.target.closest && e.target.closest('#char-zoom')) cancelHide();
    });
    document.addEventListener('mousemove', e => {
      if (zoom.hidden || !active) return;
      if (isInsideZoom(e)) {
        const under = underlyingCardAt(e);
        if (under) { overlapTarget = under; if (under !== active) show(under); }
        else { overlapTarget = null; cancelHide(); }
        return;
      }
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
      const fromZoom = e.target.closest && e.target.closest('#char-zoom');
      const toZoom = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#char-zoom');
      if ((t === active || fromZoom) && !to && !toZoom) scheduleHide();
    });
    // 点击角色卡（选角）后立即收起放大浮窗
    document.addEventListener('click', e => {
      // 若预览层覆盖了另一张卡，点击优先转发给底层卡牌。
      if (e.target.closest && e.target.closest('#char-zoom') && overlapTarget) {
        const target = overlapTarget;
        hide();
        if (target.isConnected && typeof target.click === 'function') target.click();
        return;
      }
      if (e.target.closest && e.target.closest(SEL)) hide();
    });
    // 滚动时位置会失真，直接隐藏
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', hide, true);
      window.addEventListener('resize', hide);
    }
  }

  /**
   * 给可操作卡牌绑定动作。移动端需要先看清完整卡图再确认；桌面端保留直接点击。
   * multi/handpick 这类需要连续点选的手牌动作不走确认浮层。
   */
  function bindCardAction(node, fn, zoomOnTouch) {
    if (!node) return;
    if (isTouchDevice() && zoomOnTouch) node.__cardAction = fn;
    else {
      if (isTouchDevice()) node.__noZoom = true;
      onTap(node, fn);
    }
  }

  /* 玩家小框框里的角色卡状态：未选 / 盖牌 / 翻面；翻面后立即在右侧显示角色名 */
  function charStatusHTML(p) {
    let st = 'none';
    if (p.hasChosen && p.draftComplete !== false) {
      st = (p.revealedCharNum != null) ? 'up' : 'down';
    }
    // 检测本帧是否从「盖牌」变为「翻面」，是则播放翻牌动画
    const prev = App._reveal[p.seat];
    let flip = '';
    if (prev === 'down' && st === 'up') flip = ' flip-in';
    App._reveal[p.seat] = st;
    let front = '', nameSpan = '';
    if (st === 'up') {
      const ch = charMeta(p.revealedCharId, p.revealedCharNum) ||
        { id: p.revealedCharId, num: p.revealedCharNum, name: String(p.revealedCharNum || '') };
      const img = roleThumb(ch);
      const full = roleFull(ch);
      front = img
        ? '<img src="' + img + '" alt="' + escapeHtml(ch.name) + '" decoding="async">'
        : '<div class="cs-emoji">' + escapeHtml(String(p.revealedCharNum || '?')) + '</div>';
      const nm = ch.name || ROLE_IMG[p.revealedCharNum] || ('' + p.revealedCharNum);
      nameSpan = '<span class="cs-name">' + escapeHtml(nm) + '</span>';
      var zoomAttr = img ? ' data-zoom-src="' + escapeHtml(full || img) + '" data-zoom-title="' + escapeHtml(ch.name) + '"' : ' data-zoom-back="1"';
    } else if (st === 'down') {
      var zoomAttr = ' data-zoom-back="1"';
    } else {
      var zoomAttr = '';
    }
    const cardBody = st === 'none' ? '' :
      '<div class="cs-inner">' +
        '<div class="cs-face cs-back">▧</div>' +
        '<div class="cs-face cs-front">' + front + '</div>' +
      '</div>';
    return '<div class="cs-card ' + st + flip + '"' + zoomAttr + '>' + cardBody + '</div>' + nameSpan;
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
      c.innerHTML = '<i class="coin-icon" aria-hidden="true"></i>';
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

  // 魔术师换手牌：用两张牌背沿相反方向飞行，保持信息隐藏但让交换关系清楚可见。
  function handSwapAnim(fromSeat, toSeat) {
    if (fromSeat == null || toSeat == null || fromSeat === toSeat) return;
    const from = rectOf(playerBox(fromSeat));
    const to = rectOf(playerBox(toSeat));
    if (!from || !to || typeof document === 'undefined' || !document.body) return;
    const sx = from.left + from.width / 2, sy = from.top + from.height / 2;
    const ex = to.left + to.width / 2, ey = to.top + to.height / 2;
    const dx = ex - sx, dy = ey - sy;
    [
      { x: sx, y: sy, dx: dx, dy: dy, rotate: '-8deg' },
      { x: ex, y: ey, dx: -dx, dy: -dy, rotate: '8deg' }
    ].forEach((v, i) => {
      const card = document.createElement('div');
      card.className = 'hand-swap-flight';
      card.textContent = '▧';
      card.style.left = (v.x - 21) + 'px';
      card.style.top = (v.y - 29) + 'px';
      card.style.setProperty('--swap-dx', v.dx + 'px');
      card.style.setProperty('--swap-dy', v.dy + 'px');
      card.style.setProperty('--swap-rotate', v.rotate);
      card.style.animationDelay = (i * 90) + 'ms';
      document.body.appendChild(card);
      setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 1150 + i * 90);
    });
    const badge = document.createElement('div');
    badge.className = 'hand-swap-badge';
    badge.textContent = '手牌交换';
    badge.style.left = ((sx + ex) / 2 - 34) + 'px';
    badge.style.top = ((sy + ey) / 2 - 12) + 'px';
    document.body.appendChild(badge);
    setTimeout(() => { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 1250);
  }

  // 外交官交换建筑：从两张建筑牌当前 DOM 位置飞向交换后的真实 DOM 位置。
  function buildingSwapAnim(fromSeat, toSeat, mineCard, theirsCard) {
    if (fromSeat == null || toSeat == null || fromSeat === toSeat ||
        typeof document === 'undefined' || !document.body) return;
    const findCard = uid => {
      if (!uid) return null;
      return Array.prototype.find.call(document.querySelectorAll('[data-uid]'), node =>
        node.dataset && node.dataset.uid === uid);
    };
    const entries = [
      { data: mineCard, from: fromSeat, to: toSeat, rotate: '-7deg' },
      { data: theirsCard, from: toSeat, to: fromSeat, rotate: '7deg' }
    ];
    const flights = entries.map((entry, i) => {
      const data = entry.data || {};
      const source = findCard(data.uid);
      const start = rectOf(source);
      if (!start) return null;
      const card = source.cloneNode(true);
      card.classList.remove('clickable', 'pickable', 'selected');
      card.classList.add('building-swap-flight');
      card.style.left = start.left + 'px';
      card.style.top = start.top + 'px';
      card.style.width = start.width + 'px';
      card.style.height = start.height + 'px';
      card.style.setProperty('--swap-rotate', entry.rotate);
      card.style.animationDelay = (i * 90) + 'ms';
      document.body.appendChild(card);
      return { card: card, entry: entry, start: start };
    }).filter(Boolean);
    if (!flights.length) return;

    // 当前通知在 render() 的前半段处理，等本轮 DOM reconciliation 完成后读取目标卡牌位置。
    const nextFrame = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    nextFrame(() => {
      flights.forEach((flight, i) => {
        const uid = flight.entry.data && flight.entry.data.uid;
        const targetCard = findCard(uid);
        const target = rectOf(targetCard) || rectOf(playerCityBox(flight.entry.to));
        if (!target) {
          if (flight.card.parentNode) flight.card.parentNode.removeChild(flight.card);
          return;
        }
        const dx = target.left - flight.start.left;
        const dy = target.top - flight.start.top;
        flight.card.style.setProperty('--swap-dx', dx + 'px');
        flight.card.style.setProperty('--swap-dy', dy + 'px');
        flight.card.style.setProperty('--swap-scale-x', (target.width / flight.start.width).toFixed(4));
        flight.card.style.setProperty('--swap-scale-y', (target.height / flight.start.height).toFixed(4));
        flight.card.classList.add('is-flying');
        setTimeout(() => { if (flight.card.parentNode) flight.card.parentNode.removeChild(flight.card); }, 1150 + i * 90);
      });
    });
  }

  // 建造动画：建筑牌从屏幕中央缩小飞入建造者的城区，并提示玩家框完成扩张。
  function buildingBuildAnim(seat, data, onDone) {
    const finish = typeof onDone === 'function' ? onDone : function () {};
    if (seat == null || !data || typeof document === 'undefined' || !document.body) {
      finish();
      return;
    }
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
    const BASE_BUILD_FLIGHT_MS = 1050;
    // 在上一版基础上，中央展示时间减半，飞行时间缩短为五分之一。
    const BUILD_HOLD_MS = Math.round(BASE_BUILD_FLIGHT_MS * 5 / 6);
    const BUILD_FLIGHT_MS = Math.round(BASE_BUILD_FLIGHT_MS * 3 / 5);
    const baseWidth = Math.min(148, Math.max(112, Math.round(window.innerWidth * .12)));
    const width = baseWidth * 3;
    // 霓虹建筑卡图比例为 1:1.5；保持原图比例，避免 object-fit:cover 裁掉上下内容。
    const height = Math.round(width * 1.5);
    const sx = window.innerWidth / 2 - width / 2;
    const sy = window.innerHeight / 2 - height / 2;
    const card = cardNode(data, {});
    card.classList.add('building-build-flight');
    card.style.width = width + 'px';
    card.style.height = height + 'px';
    card.style.left = sx + 'px';
    card.style.top = sy + 'px';
    card.style.transformOrigin = 'center center';
    document.body.appendChild(card);

    raf(() => {
      const box = playerBox(seat);
      const city = playerCityBox(seat);
      const targetCard = data.uid
        ? Array.prototype.find.call(document.querySelectorAll('.card[data-uid]'), node =>
            node.dataset && node.dataset.uid === String(data.uid))
        : null;
      const target = rectOf(targetCard) || rectOf(city) || rectOf(box);
      if (!target) {
        if (card.parentNode) card.parentNode.removeChild(card);
        finish();
        return;
      }
      // render() 已经把新建筑放入城区；动画期间隐藏静态卡，避免出现“静态卡+飞行卡”两张。
      if (targetCard) {
        targetCard.style.visibility = 'hidden';
        targetCard.dataset.buildArrivalHidden = 'true';
      }
      if (box) {
        box.classList.add('building-arrival-expand');
        setTimeout(() => box.classList.remove('building-arrival-expand'), 900);
      }
      // 以卡牌中心为基准计算位移，并将最终缩放设置为目标卡牌的实际尺寸，
      // 确保飞行结束时准确落在城区中对应的卡位。
      const tx = target.left + target.width / 2 - (sx + width / 2);
      const ty = target.top + target.height / 2 - (sy + height / 2);
      card.style.setProperty('--build-dx', tx + 'px');
      card.style.setProperty('--build-dy', ty + 'px');
      card.style.setProperty('--build-scale-x', (target.width / width).toFixed(4));
      card.style.setProperty('--build-scale-y', (target.height / height).toFixed(4));
      // 先在中央保持展示，再开始缩小飞行。
      setTimeout(() => {
        if (!card.parentNode) {
          finish();
          return;
        }
        card.classList.add('is-flying');
        setTimeout(() => {
          if (targetCard && targetCard.dataset.buildArrivalHidden === 'true') {
            targetCard.style.visibility = '';
            delete targetCard.dataset.buildArrivalHidden;
          }
          if (card.parentNode) card.parentNode.removeChild(card);
          finish();
        }, BUILD_FLIGHT_MS + 180);
      }, BUILD_HOLD_MS);
    });
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

  // 名称右侧是皇冠在界面中的视觉锚点；自己的玩家框没有对手同款名称节点，
  // 因此退回到玩家框右上区域，保证皇冠动画在所有座位都能播放。
  function playerNameAnchor(seat) {
    const box = playerBox(seat);
    if (!box) return null;
    const name = box.querySelector('.opp-name');
    const r = rectOf(name) || rectOf(box);
    if (!r) return null;
    return {
      x: name ? r.right + 5 : r.right - Math.min(24, r.width * .12),
      y: r.top + r.height / 2
    };
  }

  function crownTransferAnim(fromSeat, toSeat) {
    if (fromSeat == null || toSeat == null || fromSeat === toSeat ||
        typeof document === 'undefined' || !document.body) return;
    const from = playerNameAnchor(fromSeat), to = playerNameAnchor(toSeat);
    if (!from || !to) return;
    const crown = document.createElement('div');
    crown.className = 'crown-flight';
    crown.innerHTML = '<i class="crown-icon" aria-hidden="true">♛</i>';
    crown.style.left = (from.x - 11) + 'px';
    crown.style.top = (from.y - 11) + 'px';
    crown.style.setProperty('--crown-dx', (to.x - from.x) + 'px');
    crown.style.setProperty('--crown-dy', (to.y - from.y) + 'px');
    document.body.appendChild(crown);
    setTimeout(() => { if (crown.parentNode) crown.parentNode.removeChild(crown); }, 1250);
  }

  // 单张手牌从目标玩家飞向皇帝，使用牌背以保持信息隐藏。
  function handTransferAnim(fromSeat, toSeat) {
    if (fromSeat == null || toSeat == null || fromSeat === toSeat ||
        typeof document === 'undefined' || !document.body) return;
    const from = rectOf(playerBox(fromSeat)), to = rectOf(playerBox(toSeat));
    if (!from || !to) return;
    const sx = from.left + from.width / 2, sy = from.top + from.height / 2;
    const ex = to.left + to.width / 2, ey = to.top + to.height / 2;
    const card = document.createElement('div');
    card.className = 'hand-swap-flight hand-transfer-flight';
    card.textContent = '▧';
    card.style.left = (sx - 21) + 'px';
    card.style.top = (sy - 29) + 'px';
    card.style.setProperty('--swap-dx', (ex - sx) + 'px');
    card.style.setProperty('--swap-dy', (ey - sy) + 'px');
    card.style.setProperty('--swap-rotate', '-7deg');
    document.body.appendChild(card);
    const badge = document.createElement('div');
    badge.className = 'hand-swap-badge';
    badge.textContent = '手牌转移';
    badge.style.left = ((sx + ex) / 2 - 34) + 'px';
    badge.style.top = ((sy + ey) / 2 - 12) + 'px';
    document.body.appendChild(badge);
    setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 1150);
    setTimeout(() => { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 1250);
  }

  // 建造动画期间锁住所有行动，避免下一步操作与建筑入场效果重叠。
  let buildingAnimDepth = 0;
  function beginBuildingAnimation() {
    buildingAnimDepth++;
    App.buildingAnimPaused = true;
    App.paused = true;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.add('building-animation-paused');
    }
    if (typeof Local !== 'undefined' && Local.timer) {
      clearTimeout(Local.timer);
      Local.timer = null;
    }
  }

  function endBuildingAnimation() {
    buildingAnimDepth = Math.max(0, buildingAnimDepth - 1);
    if (buildingAnimDepth > 0) return;
    App.buildingAnimPaused = false;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('building-animation-paused');
    }
    // 若同时有事件弹层，继续保持暂停；否则恢复本地电脑行动循环。
    const eventVisible = $('#event-overlay') && !$('#event-overlay').hidden;
    App.paused = !!eventVisible;
    if (!eventVisible && App.mode === 'local' && typeof Local !== 'undefined') Local.resume();
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

  let mobileFitRaf = null;
  function scheduleMobileFitScale() {
    if (mobileFitRaf != null || typeof requestAnimationFrame !== 'function') return;
    mobileFitRaf = requestAnimationFrame(() => {
      mobileFitRaf = null;
      updateMobileFitScale();
    });
  }
  function updateMobileFitScale() {
    const root = $('#mobile-fit-root');
    const screen = $('#screen-game');
    if (!root || !screen) return;
    const mobile = typeof window !== 'undefined' && window.innerWidth <= 820;
    const standalone = typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(display-mode:standalone), (display-mode:fullscreen)').matches;
    if ((!mobile && !standalone) || !screen.classList.contains('active')) {
      root.classList.remove('mobile-fit-scaled');
      root.style.removeProperty('--mobile-fit-scale');
      return;
    }
    // 先恢复原始布局再测量，避免上一次缩放结果影响下一次计算。
    root.classList.remove('mobile-fit-scaled');
    root.style.setProperty('--mobile-fit-scale', '1');
    const topbar = root.querySelector('.topbar');
    const board = root.querySelector('.board');
    const boardMain = root.querySelector('.board-main');
    const actionbar = root.querySelector('.actionbar');
    const naturalHeight = (topbar ? topbar.offsetHeight : 0) +
      Math.max(board ? board.offsetHeight : 0, boardMain ? boardMain.scrollHeight : 0) +
      (actionbar ? actionbar.offsetHeight : 0);
    const naturalWidth = Math.max(root.scrollWidth || 0, boardMain ? boardMain.scrollWidth : 0, 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    // 留出少量安全边距；下限避免极端小屏变得完全不可操作。
    const scale = Math.max(.45, Math.min(1, (viewportHeight - 6) / Math.max(1, naturalHeight),
      (viewportWidth - 6) / Math.max(1, naturalWidth)));
    if (scale < .999) {
      root.style.setProperty('--mobile-fit-scale', scale.toFixed(4));
      root.classList.add('mobile-fit-scaled');
    }
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
    const bits = ['×', '+', '!', '·'];
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
    $('#tb-crown').innerHTML = '<i class="crown-icon" aria-hidden="true">♛</i>' +
      '<span class="crown-owner">' + (crownP ? escapeHtml(crownP.name) : '—') + '</span>';
    $('#tb-room').textContent = s.roomName || (App.mode === 'local' ? '单人模式' : '联机房间 ' + (s.roomId || ''));
    syncSpeedBtn();
    syncThemeBtn();

    // 本轮生效的负面效果常驻显示，别让玩家忘了自己被刺杀/被盯上
    const fx = $('#tb-effects');
    if (fx) {
      const parts = [];
      const e = s.effects || {};
      if (e.assassinated != null) parts.push('! ' + e.assassinated + ' 号被刺杀');
      if (e.bewitched != null) parts.push('* ' + e.bewitched + ' 号被施咒');
      if (e.thief != null) parts.push('$ ' + e.thief + ' 号被盯上');
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
        '<div class="tb-who">选角阶段</div>' +
        '<div class="tb-sub">上方为当前选角者与牌池，下方为场上局势</div>' +
        '<div class="turn-order-guide draft-guide" id="turn-order-guide-draft" aria-label="行动顺序"></div>';
      renderTableGuide(s);
      renderOpponents(s);
      renderMe(s);
      renderLog(s);
      restoreScroll(_scrollSnap);
      scheduleMobileFitScale();
      return;
    }

    renderTurnBanner(s);
    renderTableGuide(s);
    renderOpponents(s);
    renderMe(s);
    renderLog(s);
    renderActions(s);
    autoOpenPick(s);
    restoreScroll(_scrollSnap);
    scheduleMobileFitScale();
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
        escapeHtml(p.name) + (okd ? ' ✓' : ' 等待') + '</span>';
    }).join('');
    left.innerHTML =
      '<div class="tb-who">第 ' + rc.round + ' 轮结束 — 请确认本轮战果</div>' +
      '<div class="rc-list">' + rows + '</div>';
    box.appendChild(left);

    const btn = el('button', 'btn rc-btn');
    if (myIdx >= 0 && rc.confirmed[myIdx]) {
      btn.textContent = '已确认，等待其他玩家（' + done + '/' + total + '）';
      btn.className = 'btn ghost rc-btn';
      btn.disabled = true;
    } else {
      btn.textContent = '确认本轮战果（' + done + '/' + total + '）';
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
    left.innerHTML = '<div class="tb-who">' + (who.id === App.myId ? '你' : escapeHtml(who.name)) +
      ' — ' + t.charNum + ' · ' + escapeHtml(t.charName) + mark + ' ' + phaseTip + '</div>' +
      '<div class="tb-sub">已建造 ' + t.builds + ' / ' + t.buildLimit + ' 栋' +
      (t.takenResources ? ' · 已领资源' : '') + '</div>';
    box.appendChild(left);

    const stats = el('div', 'tb-stats');
    stats.innerHTML =
      '<span>牌堆 <b>' + s.deckCount + '</b></span>' +
      '<span>弃牌 <b>' + s.discardCount + '</b></span>' +
      (s.effects.thief != null ? '<span>盗贼锁定 <b>' + s.effects.thief + ' 号</b></span>' : '') +
      (s.firstToFinish >= 0 ? '<span>* <b>' + escapeHtml(s.players[s.firstToFinish].name) + '</b> 已达标</span>' : '');
    box.appendChild(stats);
  }

  function playerCityBox(s) {
    const box = playerBox(s);
    if (!box) return null;
    return box.id === 'me-area' ? $('#my-city') : box.querySelector('.opp-city');
  }

  function renderTableGuide(s) {
    // 选角阶段使用横条内的独立槽位；行动阶段使用桌面顶部槽位。
    // 两个节点不来回搬运，避免 render() 重建横条时把行动指引一起清掉。
    const arenaGuide = $('#turn-order-guide');
    const guide = s.phase === 'draft'
      ? ($('#turn-order-guide-draft') || arenaGuide)
      : arenaGuide;
    if (!guide) return;
    const banner = $('#turn-banner');
    if (s.phase === 'draft') {
      // 选角阶段：行动指引属于“选角阶段”横条的一部分，避免压住桌面玩家卡片。
      if (arenaGuide && arenaGuide !== guide) {
        arenaGuide.hidden = true;
        arenaGuide.style.display = 'none';
        arenaGuide.setAttribute('aria-hidden', 'true');
      }
      guide.hidden = false;
      guide.style.display = 'flex';
      guide.style.visibility = 'visible';
      guide.setAttribute('aria-hidden', 'false');
    } else if (banner && guide.parentNode !== banner) {
      // 行动阶段也固定放在顶部横条，避免遮住圆桌上方的玩家卡片。
      banner.appendChild(guide);
      guide.hidden = false;
      guide.style.display = 'flex';
      guide.style.visibility = 'visible';
      guide.setAttribute('aria-hidden', 'false');
    }
    const actor = localActor(s);
    const actorIdx = actor ? s.players.findIndex(p => p.id === actor.id) : -1;
    const roleHint = s.turn && s.turn.charNum != null ? ' · ' + s.turn.charNum + '号角色' : '';
    guide.innerHTML = '<span class="order-label">行动指引</span>' +
      '<span class="order-note">角色按编号顺序行动</span>' +
      s.players.map((p, i) =>
        (i ? '<span class="order-arrow">→</span>' : '') +
        '<span class="order-step' + (i === actorIdx ? ' current' : '') + '"' +
        (i === actorIdx ? ' aria-current="step"' : '') + '>' +
        '<span class="order-seat">' + (p.seat + 1) + '</span>' + escapeHtml(p.name) +
        (i === actorIdx ? ' · 当前' : '') + '</span>'
      ).join('');
  }

  function renderOpponents(s) {
    const wrap = $('#opponents');
    const totalPlayers = s.players.length || 1;
    const mobileRingLayout = isMobileOpponentLayout() && totalPlayers >= 5;
    const compactLevel = totalPlayers >= 8 ? 3 : totalPlayers >= 7 ? 2 : totalPlayers >= 5 ? 1 : 0;
    const radiusX = totalPlayers >= 7 ? 43 : totalPlayers >= 5 ? 40 : 36;
    const radiusY = totalPlayers >= 7 ? 42 : totalPlayers >= 5 ? 40 : 38;
    const cardWidth = totalPlayers >= 8 ? 17 : totalPlayers >= 7 ? 19 : totalPlayers >= 5 ? 21 : totalPlayers === 4 ? 30 : 24;
    wrap.dataset.players = String(totalPlayers);
    wrap.dataset.layout = mobileRingLayout ? 'mobile-ring' : 'ring';
    const arena = $('#table-arena');
    if (arena) arena.dataset.players = String(totalPlayers);
    // 多人时顶部玩家卡片更容易向下延伸，圆桌下移到环形座位的空白中心，避免相互覆盖。
    const me = s.players.find(p => p.id === App.myId);
    const meSeat = me ? me.seat : 0;
    const picking = districtSelectMode();
    // 按 seat 复用对手区块，避免整盘重建导致城区卡图在移动端闪烁
    const existing = {};
    Array.prototype.forEach.call(wrap.children, ch => { if (ch.dataset && ch.dataset.seat != null) existing[ch.dataset.seat] = ch; });
    const keep = {};
    const frag = document.createDocumentFragment();
    s.players.forEach((p, i) => {
      if (p.id === App.myId) return;
      let d = existing[p.seat];
      if (!d) {
        d = el('div', 'opp');
        d.dataset.seat = p.seat;
        const roleRow = el('div', 'opp-role-row');
        roleRow.appendChild(el('div', 'opp-char'));
        roleRow.appendChild(el('div', 'opp-char-stats'));
        d.appendChild(roleRow);
        const head = el('div', 'opp-head'); d.appendChild(head);
        const body = el('div', 'opp-body');
        body.appendChild(el('div', 'opp-city'));
        d.appendChild(body);
      }
      keep[p.seat] = d;
      const relativeSeat = (p.seat - meSeat + totalPlayers) % totalPlayers;
      const angle = Math.PI / 2 + relativeSeat / totalPlayers * Math.PI * 2;
      d.style.setProperty('--seat-x', String(50 + Math.cos(angle) * radiusX));
      d.style.setProperty('--seat-y', String(50 + Math.sin(angle) * radiusY));
      // 行动提示条位于游戏区域上沿。4 人时正上方座位、5 人时上方两个座位
      // 都需要额外下移，避免玩家卡片与提示条发生重叠。
      const inPlayPhase = s.phase === 'action' || s.phase === 'draft';
      const isTopSeat = totalPlayers === 4
        ? relativeSeat === 2
        : totalPlayers === 5 && (relativeSeat === 2 || relativeSeat === 3);
      const topSeatShift = !mobileRingLayout && inPlayPhase && isTopSeat
        ? (totalPlayers === 5 ? 110 : 58)
        : 0;
      d.style.setProperty('--seat-shift-y', (totalPlayers === 4 ? 42 + topSeatShift : topSeatShift) + 'px');
      const cityWidth = totalPlayers === 4
        ? Math.min(700, 340 + Math.max(0, p.city.length - 5) * 90) + 'px'
        : 'min(340px, ' + cardWidth + '%)';
      d.style.width = cityWidth;
      d.dataset.widthBase = cityWidth;
      d.dataset.cardWidth = String(cardWidth);
      d.dataset.cityCount = String(p.city.length);
      d.style.setProperty('--push-x', '0px');
      d.style.setProperty('--push-y', '0px');
      d.dataset.compact = String(mobileRingLayout ? 3 : compactLevel);
      const draftActive = !!(s.phase === 'draft' && s.draft && s.draft.currentPlayer === p.id);
      const actionActive = !!(s.turn && s.turn.playerIdx === p.seat);
      d.classList.toggle('active', draftActive || actionActive);
      // 角色状态 HTML 未变（如每步行动但身份没翻面）时跳过重建，避免霓虹角色立绘闪烁
      const cs = d.querySelector('.opp-char');
      const csHtml = charStatusHTML(p);
      if (cs._lastHTML !== csHtml) { cs.innerHTML = csHtml; cs._lastHTML = csHtml; }
      const tags = (p.disconnected ? '<span class="tag disconnected">已断连</span>' : '') +
        (p.left ? '<span class="tag left">已离开</span>' : '') +
        (!p.disconnected && !p.left && p.isBot ? '<span class="tag bot">电脑</span>' : '') +
        (p.hasCrown ? '<span class="tag crown crown-icon-tag" title="当前持有皇冠" aria-label="当前持有皇冠"><i class="crown-icon" aria-hidden="true">♛</i></span>' : '');
      const head = d.querySelector('.opp-head');
      head.innerHTML = '<span class="opp-seat-no">座位 ' + (p.seat + 1) + '</span>' +
        '<span class="opp-name">' + escapeHtml(p.name) + '</span>' + tags +
        '<span class="opp-gold"><i class="coin-icon" aria-hidden="true"></i><span>' + p.gold + '</span></span>';
      const sb = el('button', 'score-btn');
      sb.title = '显示 ' + p.name + ' 的得分与计算过程';
      sb.textContent = '分数';
      onTap(sb, () => openScore(i));
      head.appendChild(sb);

      const city = d.querySelector('.opp-city');
      if (!p.city.length) {
        Array.prototype.forEach.call(city.children, ch => { if (ch.dataset && ch.dataset.uid && ch.parentNode) ch.parentNode.removeChild(ch); });
        if (!city.querySelector('.empty-hint')) city.appendChild(el('div', 'empty-hint', '（尚无建筑）'));
      } else {
        const eh = city.querySelector('.empty-hint'); if (eh) eh.remove();
        syncCards(city, p.city, c => {
          const sel = isSelectableDistrict(p, c);
          // 选择目标时放大对手的建筑牌，方便触屏点击
          return { mini: !picking, clickable: sel, pickable: sel };
        }, (node, c) => {
          const sel = isSelectableDistrict(p, c);
          if (sel) bindCardAction(node, () => pickDistrict(p.id, c.uid), true);
          else { node.__cardAction = null; node.__noZoom = false; node.onclick = null; node.__tapFn = null; }
        });
      }
      d.querySelector('.opp-char-stats').innerHTML = '城区 <b>' + p.cityCount + '</b>/' + s.endDistricts + '<br>手牌 ' + p.handCount + ' 张' +
        (p.played && p.played.length ? '<br>已用：' + p.played.map(c => escapeHtml(Engine.charOf(c).name)).join('、') : '');
      frag.appendChild(d);
    });
    // 移除已不存在的对手区块
    Array.prototype.forEach.call(wrap.children, ch => {
      if (ch.dataset && ch.dataset.seat != null && !keep[ch.dataset.seat] && ch.parentNode) ch.parentNode.removeChild(ch);
    });
    wrap.appendChild(frag);
    if (mobileRingLayout) applyMobileRingLayout(wrap);
    else resolveOpponentTableCollisions();
  }

  function isMobileOpponentLayout() {
    if (typeof window === 'undefined') return false;
    const touch = (typeof navigator !== 'undefined' &&
      (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));
    return window.innerWidth <= 1000 || (touch && window.innerWidth <= 1400);
  }

  // 移动端多人布局：保留圆桌座位角度，只缩小玩家框和内部元素，
  // 再用真实 DOM 矩形做碰撞检测，必要时沿环形方向微调位置。
  function applyMobileRingLayout(wrap) {
    if (!wrap) return;
    const nodes = Array.prototype.slice.call(wrap.querySelectorAll('.opp'));
    if (!nodes.length) { wrap.style.height = ''; return; }
    const width = Math.max(280, wrap.clientWidth || window.innerWidth || 360);
    const gap = Math.max(6, Math.round(Math.min(14, width * .018)));
    const totalPlayers = Number(wrap.dataset.players || nodes.length + 1);
    // 玩家框至少保持 1.5:1 的宽高比；有空间时先横向容纳更多建筑，
    // 空间不足时再切换到更紧凑的卡牌尺寸。
    const maxWidth = Math.max(126, Math.floor(width * (totalPlayers >= 7 ? .46 : totalPlayers >= 5 ? .5 : .58)));
    const cardWidth = Math.max(104, Math.min(maxWidth, Math.floor(width * .25)));
    const minWidth = Math.max(104, Math.floor(cardWidth * .78));
    const height = Math.max(300, Math.min(400, Math.round((window.innerHeight || 720) * .44)));
    wrap.style.display = 'block';
    wrap.style.height = height + 'px';
    wrap.style.overflow = 'visible';
    nodes.forEach(node => {
      node.style.setProperty('--mobile-opp-width', cardWidth + 'px');
      node.style.setProperty('--push-x', '0px');
      node.style.setProperty('--push-y', '0px');
      node.dataset.pushX = '0';
      node.dataset.pushY = '0';
      node.dataset.compact = '3';
    });

    const fitPanelRatioAndBuildings = () => {
      for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        nodes.forEach(node => {
          const compact = Number(node.dataset.compact || 3);
          const cityCount = Number(node.dataset.cityCount || 0);
          const cityCardWidth = compact >= 4
            ? Math.max(16, Math.min(31, Math.floor((maxWidth - 18 - Math.max(0, cityCount - 1) * 3) / Math.max(1, cityCount))))
            : 40;
          node.style.setProperty('--mobile-city-card-width', cityCardWidth + 'px');
          node.style.setProperty('--mobile-city-card-height', Math.round(cityCardWidth * 1.5) + 'px');
          const cityNeed = cityCount
            ? 18 + Math.min(cityCount, 7) * (cityCardWidth + 3)
            : 0;
          const rect = node.getBoundingClientRect();
          const ratioNeed = Math.ceil(rect.height * 1.5);
          const current = parseFloat(getComputedStyle(node).width || cardWidth);
          const desired = Math.min(maxWidth, Math.max(cardWidth, minWidth, cityNeed, ratioNeed));
          if (desired > current + 1) {
            node.style.setProperty('--mobile-opp-width', desired + 'px');
            changed = true;
          }
          // 达到屏幕允许的最大宽度仍放不下时，缩小角色牌和建筑牌，
          // 保留横向布局，避免建筑牌优先换行导致玩家框变高。
          if (desired >= maxWidth && (rect.height * 1.5 > maxWidth || cityNeed > maxWidth) && compact < 4) {
            node.dataset.compact = '4';
            changed = true;
          }
        });
        if (!changed) break;
      }
    };
    fitPanelRatioAndBuildings();

    const clampInsideRing = () => {
      const wr = wrap.getBoundingClientRect();
      nodes.forEach(node => {
        const r = node.getBoundingClientRect();
        let pushX = parseFloat(node.dataset.pushX || '0');
        let pushY = parseFloat(node.dataset.pushY || '0');
        if (r.left < wr.left + gap) pushX += wr.left + gap - r.left;
        if (r.right > wr.right - gap) pushX -= r.right - (wr.right - gap);
        if (r.top < wr.top + gap) pushY += wr.top + gap - r.top;
        if (r.bottom > wr.bottom - gap) pushY -= r.bottom - (wr.bottom - gap);
        node.dataset.pushX = String(pushX);
        node.dataset.pushY = String(pushY);
        node.style.setProperty('--push-x', pushX + 'px');
        node.style.setProperty('--push-y', pushY + 'px');
      });
    };
    clampInsideRing();

    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i].getBoundingClientRect();
          const b = nodes[j].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX <= 0 || overlapY <= 0) continue;
          changed = true;
          const currentWidth = parseFloat(getComputedStyle(nodes[j]).width || cardWidth);
          if (currentWidth > minWidth) {
            const nextWidth = Math.max(minWidth, Math.floor(currentWidth * .9));
            nodes[i].style.setProperty('--mobile-opp-width', nextWidth + 'px');
            nodes[j].style.setProperty('--mobile-opp-width', nextWidth + 'px');
            continue;
          }
          // 到达安全最小宽度后，沿玩家相对圆心的方向轻推后一个玩家框。
          const wr = wrap.getBoundingClientRect();
          const cx = wr.left + wr.width / 2, cy = wr.top + wr.height / 2;
          const dx = (b.left + b.width / 2) - cx;
          const dy = (b.top + b.height / 2) - cy;
          const pushX = (parseFloat(nodes[j].dataset.pushX || '0')) +
            (Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? -1 : 1) * (overlapX + gap) : 0);
          const pushY = (parseFloat(nodes[j].dataset.pushY || '0')) +
            (Math.abs(dx) < Math.abs(dy) ? (dy < 0 ? -1 : 1) * (overlapY + gap) : 0);
          nodes[j].dataset.pushX = String(pushX);
          nodes[j].dataset.pushY = String(pushY);
          nodes[j].style.setProperty('--push-x', pushX + 'px');
          nodes[j].style.setProperty('--push-y', pushY + 'px');
        }
      }
      clampInsideRing();
      if (!changed) break;
    }
  }

  // 兼容旧调用名，保留旧实现，实际移动端使用上面的圆桌布局。
  // 移动端多人布局：先放入两列网格，再用真实 DOM 矩形做碰撞检测。
  // 如果内容仍然挤压，就逐步缩小玩家框；data-compact 会同步缩小内部角色牌和文字。
  function applyMobileOpponentLayout(wrap) {
    if (!wrap) return;
    const nodes = Array.prototype.slice.call(wrap.querySelectorAll('.opp'));
    if (!nodes.length) { wrap.style.height = ''; return; }
    const width = Math.max(280, wrap.clientWidth || window.innerWidth || 360);
    const gap = Math.max(8, Math.round(Math.min(18, width * .025)));
    const cols = 2;
    // 5 人以上时给左右和中间留出安全间距，避免玩家框贴边或被横向滚动截断。
    const cardWidth = Math.max(112, Math.min(220, Math.floor((width - gap * 3) * .44)));
    const minWidth = Math.max(118, Math.floor(cardWidth * .72));
    wrap.style.display = 'block';
    wrap.style.overflow = 'visible';
    nodes.forEach((node, i) => {
      node.style.setProperty('--mobile-opp-width', cardWidth + 'px');
      node.style.left = (gap + (i % cols) * (cardWidth + gap)) + 'px';
      node.style.top = (gap + Math.floor(i / cols) * 190) + 'px';
      node.style.setProperty('--push-x', '0px');
      node.style.setProperty('--push-y', '0px');
    });
    const updateHeight = () => {
      let bottom = 0;
      const wr = wrap.getBoundingClientRect();
      nodes.forEach(node => { bottom = Math.max(bottom, node.getBoundingClientRect().bottom - wr.top); });
      wrap.style.height = Math.ceil(bottom + gap) + 'px';
    };
    updateHeight();

    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i].getBoundingClientRect();
          const b = nodes[j].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX <= 0 || overlapY <= 0) continue;
          changed = true;
          const currentTop = parseFloat(nodes[j].style.top) || 0;
          const nextTop = currentTop + overlapY + gap;
          const wrapHeight = Math.max(wrap.clientHeight, 1);
          if (nextTop + b.height <= wrapHeight + 24) {
            nodes[j].style.top = nextTop + 'px';
          } else {
            const currentWidth = parseFloat(nodes[j].style.width || cardWidth);
            const nextWidth = Math.max(minWidth, Math.floor(currentWidth * .9));
            nodes[i].style.width = nextWidth + 'px';
            nodes[j].style.width = nextWidth + 'px';
            nodes[i].style.setProperty('--mobile-opp-width', nextWidth + 'px');
            nodes[j].style.setProperty('--mobile-opp-width', nextWidth + 'px');
            nodes[i].dataset.compact = '3';
            nodes[j].dataset.compact = '3';
          }
        }
      }
      updateHeight();
      if (!changed) break;
    }
    updateHeight();
  }

  // 用实际屏幕矩形检查玩家卡片与圆桌是否相交；相交时沿座位方向推开，
  // 并横向增加少量宽度，让卡片之间的间距更稳定。
  function resolveOpponentTableCollisions() {
    const table = $('#table-core');
    const wrap = $('#opponents');
    if (!table || !wrap) return;
    const tr = table.getBoundingClientRect();
    if (!tr.width || !tr.height) return;
    const tcx = tr.left + tr.width / 2;
    const tcy = tr.top + tr.height / 2;
    Array.prototype.forEach.call(wrap.querySelectorAll('.opp'), d => {
      d.style.setProperty('--push-x', '0px');
      d.style.setProperty('--push-y', '0px');
      const baseWidth = d.dataset.widthBase || ('min(340px, ' + (d.dataset.cardWidth || 24) + '%)');
      d.style.width = baseWidth;
      const r = d.getBoundingClientRect();
      const overlapX = Math.min(r.right, tr.right) - Math.max(r.left, tr.left);
      const overlapY = Math.min(r.bottom, tr.bottom) - Math.max(r.top, tr.top);
      if (overlapX <= 0 || overlapY <= 0) return;
      const dx = r.left + r.width / 2 - tcx;
      const dy = r.top + r.height / 2 - tcy;
      let pushX = 0, pushY = 0;
      if (Math.abs(dx) > Math.abs(dy)) pushX = (dx < 0 ? -1 : 1) * (overlapX + 12);
      else pushY = (dy < 0 ? -1 : 1) * (overlapY + 12);
      d.style.setProperty('--push-x', pushX + 'px');
      d.style.setProperty('--push-y', pushY + 'px');
      const expand = Math.min(26, Math.max(8, Math.round(overlapX * 0.12)));
      d.style.width = baseWidth.indexOf('px') >= 0
        ? 'min(720px, calc(' + baseWidth + ' + ' + expand + 'px))'
        : 'min(340px, calc(' + baseWidth + ' + ' + expand + 'px))';
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
      ? (s.winner === idx ? '本局胜利者' : '游戏已结束') + '（最终得分）'
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
    if (meArea) {
      const totalPlayers = s.players.length || 1;
      if (totalPlayers === 4 && window.innerWidth > 1000) {
        const desired = Math.min(1120, 860 + Math.max(0, me.city.length - 5) * 85);
        const viewportLimit = Math.max(860, window.innerWidth - 120);
        meArea.style.width = Math.min(desired, viewportLimit) + 'px';
      } else {
        meArea.style.width = '';
      }
    }
    const draftActive = !!(s.phase === 'draft' && s.draft && s.draft.currentPlayer === me.id);
    const actionActive = !!(s.turn && s.turn.playerIdx === App.myIdx);
    if (meArea) meArea.classList.toggle('active', draftActive || actionActive);
    const ms = $('#my-char-status');
    if (ms) ms.innerHTML = charStatusHTML(me);
    const myStats = $('#my-char-stats');
    if (myStats) myStats.innerHTML = '城区 <b>' + me.cityCount + '</b>/' + s.endDistricts +
      '<br>手牌 ' + me.hand.length + ' 张' +
      (me.chars.some(c => c.played) ? '<br>已用：' + me.chars.filter(c => c.played).map(c => escapeHtml(c.name)).join('、') : '');
    $('#my-gold').innerHTML = '<i class="coin-icon" aria-hidden="true"></i><span>' + me.gold + '</span>';
    $('#my-city-count').textContent = '';
    $('#my-hand-count').textContent = '';
    $('#my-chars-tip').innerHTML = '';

    const city = $('#my-city');
    if (!me.city.length) {
      // 按 uid 清掉残留卡片（如被摧毁后清空），再补空提示，避免整盘 innerHTML 重建导致图片闪烁
      Array.prototype.forEach.call(city.children, ch => { if (ch.dataset && ch.dataset.uid && ch.parentNode) ch.parentNode.removeChild(ch); });
      if (!city.querySelector('.empty-hint')) city.appendChild(el('div', 'empty-hint', '（尚无建筑，快去建造吧）'));
    } else {
      const eh = city.querySelector('.empty-hint'); if (eh) eh.remove();
      syncCards(city, me.city, c => {
        const sel = isSelectableDistrict(me, c);
        return { clickable: sel, pickable: sel, selected: App.sel && App.sel.items.indexOf(c.uid) >= 0 };
      }, (node, c) => {
        const sel = isSelectableDistrict(me, c);
        if (sel) bindCardAction(node, () => pickDistrict(me.id, c.uid), true);
        else { node.__cardAction = null; node.__noZoom = false; node.onclick = null; node.__tapFn = null; }
      });
    }

    const hand = $('#my-hand');
    if (!me.hand.length) {
      Array.prototype.forEach.call(hand.children, ch => { if (ch.dataset && ch.dataset.uid && ch.parentNode) ch.parentNode.removeChild(ch); });
      if (!hand.querySelector('.empty-hint')) hand.appendChild(el('div', 'empty-hint', '（手牌为空）'));
    } else {
      const eh = hand.querySelector('.empty-hint'); if (eh) eh.remove();
      syncCards(hand, me.hand, c => {
        const inSel = App.sel && App.sel.items.indexOf(c.uid) >= 0;
        let clickable = false, disabled = false, pickable = false;
        if (App.sel && App.sel.kind === 'handpick') { clickable = true; pickable = true; }
        else if (App.sel && App.sel.kind === 'multi') { clickable = true; }
        else if (s.turn && s.turn.playerId === App.myId && !s.turn.pending) { clickable = c.canBuild; disabled = !c.canBuild; }
        return { clickable: clickable, disabled: disabled, selected: inSel, pickable: pickable };
      }, (node, c) => {
        const inSel = App.sel && App.sel.items.indexOf(c.uid) >= 0;
        let clickable = false;
        if (App.sel && App.sel.kind === 'handpick') clickable = true;
        else if (App.sel && App.sel.kind === 'multi') clickable = true;
        else if (s.turn && s.turn.playerId === App.myId && !s.turn.pending) clickable = c.canBuild;
        if (clickable) bindCardAction(node, () => onHandClick(c), !(App.sel && (App.sel.kind === 'handpick' || App.sel.kind === 'multi')));
        else { node.__cardAction = null; node.__noZoom = false; node.onclick = null; node.__tapFn = null; }
      });
    }
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
    const viewerId = s.you || App.myId;
    const hasDraftAction = !!(s.available && s.available.actions &&
      s.available.actions.some(a => a.type === 'draft_pick' || a.type === 'draft_discard'));
    // 以状态里的 you / available 为准，避免重连或本地状态切换时 App.myId 短暂滞后。
    const isPicker = d.currentPlayer === viewerId || hasDraftAction;
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
      $('#prompt').textContent = '选角阶段 · 轮到你选择角色';
    } else {
      $('#prompt').innerHTML = '选角阶段 · ' + (cur && cur.isBot ? '电脑：' : '等待：') +
        escapeHtml(cur ? cur.name : '') + ' 正在选角' + thinkingDots();
    }
    $('#actions').innerHTML = '';
  }

  /* ============================== 本轮出局角色 ============================== */
  /* 明置移除：画出整张角色卡（身份公开）；暗置移除：画出盖着的牌背（身份保密，仅显示数量） */
  function renderRemoved(s) {
    const rem = (s && s.removed) || { faceUp: [], faceDownCount: 0 };
    const corner = $('#removed-corner');
    if (!corner) return;
    const fu = $('#rs-faceup-corner');
    const fd = $('#rs-facedown-corner');
    const faceUp = rem.faceUp || [];
    const faceDownCount = rem.faceDownCount || 0;
    if (fu) {
      // 按角色 id 复用节点，避免每步行动整盘重建导致霓虹角色立绘在移动端闪烁
      const existing = {};
      Array.prototype.forEach.call(fu.children, ch => { const k = ch.dataset && ch.dataset.uid; if (k) existing[k] = ch; });
      const keep = {};
      const frag = document.createDocumentFragment();
      faceUp.forEach(c => {
        let node = existing[c.id];
        if (!node) node = charNode(c, { dim: true, mini: true });
        keep[c.id] = node;
        frag.appendChild(node);
      });
      Array.prototype.forEach.call(fu.children, ch => {
        const k = ch.dataset && ch.dataset.uid;
        if (k && !keep[k] && ch.parentNode) ch.parentNode.removeChild(ch);
      });
      fu.appendChild(frag);
    }
    if (fd) {
      fd.innerHTML = '';
      for (let i = 0; i < faceDownCount; i++) fd.appendChild(el('div', 'facedown sm', '？'));
    }
    const empty = faceUp.length === 0 && faceDownCount === 0;
    const count = $('#removed-widget-count');
    if (count) count.textContent = String(faceUp.length + faceDownCount);
    corner.hidden = empty;
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
        promptEl.innerHTML = '墓地：' + escapeHtml(s.reaction.prompt);
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
        promptEl.innerHTML = (who.isBot ? '电脑：' : '等待：') + escapeHtml(who.name) +
          '（' + t.charNum + '·' + escapeHtml(t.charName) + '）正在行动' + thinkingDots();
      } else promptEl.textContent = '';
      return;
    }

    promptEl.innerHTML = escapeHtml(av.prompt || '请选择行动');
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
      promptEl.innerHTML = escapeHtml(App.sel.label);
      const c = el('button', 'act', '取消');
      onTap(c, () => { App.sel = null; render(); });
      actionsEl.appendChild(c);
    }
    // pending 卡牌选择弹窗（抽牌保留 / 学者 / 预言家归还）
    const tk = s.turn && s.turn.pending ? s.turn.pending.kind : null;
    if (tk === 'draw_keep' || tk === 'scholar_pick' || tk === 'prophet_give') {
      const b = el('button', 'act main', '打开卡牌选择');
      onTap(b, openPickModal);
      actionsEl.appendChild(b);
    }
  }

  function actionBtn(a, cls) {
    const b = el('button', 'act ' + (cls || '') + (a.disabled ? ' disabled' : ''));
    b.innerHTML = escapeHtml(a.label || a.type);
    b.disabled = !!a.disabled;
    if (!a.disabled) onTap(b, () => runAction(a));
    return b;
  }

  /* ============================== 行动分发 ============================== */
  function runAction(a) {
    if (App.buildingAnimPaused) return;
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
    if (App.buildingAnimPaused) return;
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
    const grid = el('div', 'pick-grid pick-grid-' + kind);
    if (kind === 'prophet_give') {
      const me = s.players.find(p => p.id === App.myId);
      me.hand.forEach(c => {
        const n = cardNode(c, { clickable: true });
        bindCardAction(n, () => { closeModal(); send({ type: 'prophet_give', uid: c.uid }); }, true);
        grid.appendChild(n);
      });
    } else {
      cards.forEach(c => {
        const n = cardNode(c, { clickable: true });
        bindCardAction(n, () => {
          closeModal();
          if (kind === 'scholar_pick') send({ type: 'scholar_pick', uid: c.uid });
          else send({ type: 'draw_keep', uid: c.uid });
        }, true);
        grid.appendChild(n);
      });
    }
    body.appendChild(grid);
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; }

  /* ============================== 结算 ============================== */
  function showOver(s) {
    // 避免之前打开的计分详情浮层挡住结算页按钮，导致首击只关闭浮层。
    closeScore();
    const rows = s.scores || [];
    let best = -1;
    rows.forEach(r => { if (r.total > best) best = r.total; });
    $('#over-title').innerHTML = s.winner != null
      ? escapeHtml(s.players[s.winner].name) + ' 获胜！'
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
      const img = roleThumb(c);
      const full = roleFull(c);
      const art = img ? '<img class="rc-art" src="' + img + '" alt="' + escapeHtml(c.name) + '" loading="lazy" decoding="async">' : '';
      const hd = full ? '<button class="ref-hd-trigger" type="button" data-hd-src="' + escapeHtml(full) + '" data-hd-title="' + escapeHtml(c.name) + '">查看高清大图</button>' : '';
      // 角色卡图已含效果文字，顶部仅保留名称，不再重复说明
      d.innerHTML = art + hd + '<h4><span class="rc-num">' + c.num + '</span>' + c.name +
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
        const e = el('div', 'ref-card c-' + k);
        const thumb = Theme.is && Theme.is('neon') && Theme.districtAsset ? Theme.districtAsset(d, 'thumb') : null;
        const full = Theme.is && Theme.is('neon') && Theme.districtAsset ? Theme.districtAsset(d, 'full') : null;
        const art = thumb
          ? '<img class="rc-art district-ref-art" src="' + thumb + '" alt="' + escapeHtml(d.name) + '" loading="lazy" decoding="async">'
          : '';
        const hd = full ? '<button class="ref-hd-trigger" type="button" data-hd-src="' + escapeHtml(full) + '" data-hd-title="' + escapeHtml(d.name) + '">查看高清大图</button>' : '';
        e.innerHTML = art + hd + '<h4>' + d.name + '<span class="rc-en">' + d.en + ' · ' + d.cost + ' 金</span></h4>' +
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
        '<div class="seat-tag">' + (s.disconnected ? '已断连' : s.left ? '已离开' :
          (s.isBot ? '电脑' : (s.taken ? '真人玩家' : '可加入'))) + '</div>';
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
    if (Theme.onChange) Theme.onChange(() => {
      syncThemeBtn();
      // 主题切换会改变卡片内部结构（neon 用 <img>、classic 用文本），复用旧节点会错乱，
      // 因此先清空所有卡片容器，让本次 render 全量重建出正确结构。
      ['#my-city', '#my-hand', '#opponents'].forEach(sel => { const e = $(sel); if (e) e.innerHTML = ''; });
      if (App.state && App.state.phase !== 'lobby') render();
    });
    $$('[data-theme-choice]').forEach(b => b.onclick = () => Theme.apply(b.dataset.themeChoice));
    const themeBtn = $('#btn-theme');
    if (themeBtn) themeBtn.onclick = () => Theme.toggle();
    if (Theme.updateControls) Theme.updateControls();
    syncThemeBtn();
    $$('[data-goto]').forEach(b => b.onclick = () => {
      const target = b.dataset.goto;
      if (target === 'home' && App.mode === 'net' && App.state && App.state.phase === 'gameover') {
        // 结算页返回主菜单代表结束这次联机体验，不应在刷新后自动回到旧计分页。
        App.leavingNetGame = true;
        Net.send({ t: 'leaveRoom' });
        clearNetSession();
        Net.roomId = null;
        App.state = null;
        App.myId = null;
      }
      showScreen('screen-' + target);
    });

    $('#btn-single').onclick = () => showScreen('screen-setup');
    $('#btn-online').onclick = () => {
      App.leavingNetGame = false;
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
    initCardHd();
    const removedWidget = $('#removed-corner');
    const removedToggle = $('#removed-widget-toggle');
    if (removedWidget && removedToggle) {
      removedToggle.onclick = () => {
        const collapsed = removedWidget.classList.toggle('collapsed');
        removedToggle.setAttribute('aria-expanded', String(!collapsed));
      };
      removedWidget.classList.add('collapsed');
    }
    const mobileMenuToggle = $('#mobile-menu-toggle');
    const gameScreen = $('#screen-game');
    if (mobileMenuToggle && gameScreen) {
      mobileMenuToggle.onclick = () => {
        const open = gameScreen.classList.toggle('mobile-menu-open');
        mobileMenuToggle.setAttribute('aria-expanded', String(open));
        mobileMenuToggle.title = open ? '收起游戏菜单' : '展开游戏菜单';
        scheduleMobileFitScale();
      };
    }

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
      App.leavingNetGame = false;
      const code = ($('#net-code').value || '').trim().toUpperCase();
      if (code.length !== 4) { toast('请输入 4 位房间号'); return; }
      Net.name = ($('#net-name').value || '玩家').trim();
      Net.connect(() => Net.send({ t: 'joinRoom', roomId: code, name: Net.name }));
      App.mode = 'net';
    };
    $('#btn-refresh').onclick = () => Net.send({ t: 'listRooms' });
    $('#btn-leave').onclick = () => {
      Net.send({ t: 'leaveRoom' });
      clearNetSession();
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
    window.addEventListener('resize', scheduleMobileFitScale);
    window.addEventListener('orientationchange', scheduleMobileFitScale);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  bind();
  // 浏览器刷新或重启后，使用本地保存的令牌自动回到原来的座位/对局。
  const savedNetSession = loadNetSession();
  if (savedNetSession) {
    App.mode = 'net';
    Net.name = savedNetSession.name || '玩家';
    Net.connect(() => Net.send({ t: 'listRooms' }));
  }
  // 供自动化测试驱动使用
  App.__local = Local;
  App.__net = Net;
  window.__CitadelsApp = App;
  // PWA：支持从主屏幕/桌面以独立窗口启动；联机功能仍需网络连接服务器。
  if (typeof navigator !== 'undefined' && navigator.serviceWorker && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
})();
