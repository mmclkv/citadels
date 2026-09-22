/* =========================================================================
 * 富饶之城 / 荣耀之城 (Citadels) — 规则引擎
 * 纯逻辑，可在 Node（权威服务端）与浏览器（单人本地）中运行
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cards.js'));
  } else {
    root.CitEngine = factory(root.CitCards);
  }
})(typeof self !== 'undefined' ? self : this, function (CitCards) {
  'use strict';

  const CHAR_MAP = CitCards.CHAR_MAP;

  /* ------------------------------ 随机数 ------------------------------ */
  function nextRand(state) {
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function randInt(state, n) { return Math.floor(nextRand(state) * n); }
  function pickRandom(state, arr) { return arr[randInt(state, arr.length)]; }

  /* ------------------------------ 日志 ------------------------------- */
  function log(state, text, type) {
    state.log.push({ i: state.log.length, text: text, type: type || 'info', round: state.round });
    if (state.log.length > 400) state.log.shift();
  }

  /**
   * 关键事件通知：供客户端做弹窗 / toast 提示（被刺杀、被施咒、被偷、被摧毁…）。
   * 这些事件在桌游里都是公开宣告的，所以可以随 sanitize 一并下发给所有人。
   * seq 单调递增，客户端只需记住「已展示到第几条」即可，天然避免重复弹窗，
   * 也能正确处理一次 applyAction 内连续产生多条事件的情况（beginNextCall 会递归）。
   */
  function notify(state, kind, data) {
    state.noticeSeq = (state.noticeSeq || 0) + 1;
    if (!state.notices) state.notices = [];
    const n = { seq: state.noticeSeq, kind: kind, round: state.round };
    if (data) { for (const k in data) if (Object.prototype.hasOwnProperty.call(data, k)) n[k] = data[k]; }
    state.notices.push(n);
    if (state.notices.length > 24) state.notices.shift();
  }

  function notifyHandGain(state, toIdx, amount, fromIdx, why) {
    if (!(amount > 0) || !state.players[toIdx]) return;
    const to = state.players[toIdx];
    const from = fromIdx == null ? null : state.players[fromIdx];
    notify(state, 'hand_gain', {
      playerIdx: toIdx, playerId: to.id, playerName: to.name,
      amount: amount, fromIdx: from ? fromIdx : null,
      fromName: from ? from.name : null, why: why || '获得手牌'
    });
  }

  /**
   * 金币易主的统一上报，和 notifyHandGain 对称。
   * toIdx 收到 amount 枚金币；fromIdx 为来源玩家（null 表示来自银行/金库，非玩家间转移）。
   * 客户端据此决定播「玩家间金币飞行」还是「从金库飞入」，避免每个效果各写一遍。
   * 注意：本函数只负责「获得」侧，付费到银行的支出（建造、抢夺费等）另有专门的位移动画，
   * 不要用它报告，否则会看到金币凭空飞进来。
   */
  function notifyGoldGain(state, toIdx, amount, fromIdx, why) {
    const amt = Math.floor(Number(amount) || 0);
    if (!(amt > 0) || !state.players[toIdx]) return;
    const to = state.players[toIdx];
    const from = fromIdx == null ? null : state.players[fromIdx];
    notify(state, 'got_gold', {
      playerIdx: toIdx, playerId: to.id, playerName: to.name,
      amount: amt, fromIdx: from ? fromIdx : null,
      fromName: from ? from.name : null, why: why || '获得金币'
    });
  }

  /* ------------------------------ 工具 ------------------------------- */
  function getPlayer(state, id) {
    return state.players.find(p => p.id === id) || null;
  }
  function playerIdx(state, id) {
    return state.players.findIndex(p => p.id === id);
  }
  function crownIdx(state) {
    return state.players.findIndex(p => p.hasCrown);
  }
  function charOf(id) { return CHAR_MAP[id]; }
  function charByNum(state, num) {
    const id = (state.charDeck || []).find(cid => charOf(cid) && charOf(cid).num === num);
    return id ? charOf(id) : null;
  }
  /** 玩家当前正在行动的角色（用于判断主教保护等） */
  function playerHolds(state, idx, charId) {
    return state.players[idx].chars.indexOf(charId) >= 0;
  }
  function hasBuilt(player, name) {
    return player.city.some(d => d.name === name);
  }
  function quarryCount(player) {
    return player.city.filter(d => d.purple && d.purple.effect === 'quarry').length;
  }
  /** 允许同名建筑的最大数量（采石场 +1） */
  function maxSameName(player) { return 1 + quarryCount(player); }
  /**
   * 博物馆下压着的建筑牌是「物理牌」，会附着在博物馆建筑对象上（card.museum）。
   * 当一栋建筑离开玩家城市（被摧毁 / 墓地回收 / 外交官或元帅转移）时，
   * 它附带的 museum 牌必须显式处理，否则会随浅拷贝丢失、导致整局牌数不守恒。
   * 这里统一把附带的牌收回弃牌堆（它们是已被使用的牌，不应重新进入城市）。
   * 注意：调用方必须先把该建筑从 city 中移除，再调用本函数。
   */
  function detachMuseum(state, card) {
    if (card && Array.isArray(card.museum) && card.museum.length) {
      card.museum.forEach(mc => { if (mc) state.discard.push(mc); });
      card.museum = [];
    }
  }
  /** 计算某颜色的建筑数量（用于收入）；魔法学院可视为任意颜色 */
  function countColorForIncome(player, color, anyColorChoice) {
    let n = 0, wild = 0;
    player.city.forEach(d => {
      if (d.color === color) n++;
      else if (d.purple && d.purple.effect === 'anyColorIncome') wild++;
    });
    if (anyColorChoice && typeof anyColorChoice === 'string') {
      if (anyColorChoice === color) n += wild;
    }
    return n;
  }
  function drawCards(state, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (state.deck.length === 0) {
        if (state.discard.length === 0) break;
        state.deck = CitCards.shuffle(state.discard, () => nextRand(state));
        state.discard = [];
        log(state, '建筑牌堆已用完，弃牌堆重新洗回。', 'sys');
      }
      out.push(state.deck.shift());
    }
    return out;
  }
  function toBottom(state, cards) {
    cards.forEach(c => state.deck.push(c));
  }
  function beautifiedExtra(card) { return card.beautified ? 1 : 0; }
  function districtScoreValue(card) {
    if (card.purple && card.purple.effect === 'scoreAs') return card.purple.scoreAs;
    return card.scoreValue || card.cost;
  }

  /* ============================ 创建游戏 ============================ */
  function createGame(config) {
    config = config || {};
    const seats = config.seats || [];
    const playerCount = seats.length;
    const state = {
      roomId: config.roomId || 'local',
      phase: 'lobby',
      rngState: (config.seed != null ? config.seed : Math.floor(Math.random() * 1e9)) >>> 0,
      config: {
        playerCount: playerCount,
        endDistricts: config.endDistricts || 8,
        charSetMode: config.charSetMode || 'base',
        startingHand: 4,
        startingGold: 2,
        // 训练和复盘可以显式轮换开局皇冠；未提供时保持历史行为（座位 0）。
        initialCrownSeat: Number.isInteger(Number(config.initialCrownSeat)) &&
          Number(config.initialCrownSeat) >= 0 && Number(config.initialCrownSeat) < playerCount
          ? Number(config.initialCrownSeat) : 0
      },
      players: [],
      deck: [],
      discard: [],
      round: 0,
      charDeck: [],
      draft: null,
      callQueue: [],
      callIdx: 0,
      turn: null,
      witchResume: null,
      reaction: null,
      effects: { assassinated: null, thief: null, bewitched: null, witchBy: null, thiefBy: null,
        magistrate: null, blackmailer: null, taxCollectorGold: 0 },
      firstToFinish: -1,
      pendingQueen: null,
      // 信念观测账本：每位玩家一条，全部由公开量派生（见 recordObservation）
      observations: [],
      log: [],
      notices: [],
      noticeSeq: 0,
      scores: null,
      winner: null,
      createdAt: Date.now()
    };

    seats.forEach((s, i) => {
      state.players.push({
        id: s.id,
        name: s.name,
        isBot: !!s.isBot,
        botLevel: s.botLevel || 'normal',
        botType: s.botType || 'npc',
        seat: i,
        gold: 0,
        hand: [],
        city: [],
        chars: [],
        played: [],
        hasCrown: false,
        connected: true
      });
    });

    // mixed 模式要按编号抽一套角色，必须吃同一条种子流，否则同一 seed 复现不出同一局
    state.charDeck = CitCards.pickCharacterSet(playerCount, state.config.charSetMode,
      () => nextRand(state)).map(c => c.id);
    return state;
  }

  function startGame(state) {
    if (state.players.length < 2) return { ok: false, error: '至少需要 2 位玩家' };
    state.deck = CitCards.buildDistrictDeck(() => nextRand(state));
    state.players.forEach(p => {
      p.hand = drawCards(state, state.config.startingHand);
      p.gold = state.config.startingGold;
      p.city = [];
    });
    state.players.forEach(p => { p.hasCrown = false; });
    state.players[state.config.initialCrownSeat || 0].hasCrown = true;
    const crownHolder = state.players.find(p => p.hasCrown);
    log(state, '游戏开始！每位玩家获得 4 张建筑牌与 2 枚金币。皇冠由 ' +
      (crownHolder ? crownHolder.name : '未知玩家') + ' 持有。', 'sys');
    log(state, '本局使用角色：' + state.charDeck.map(id => CHAR_MAP[id].num + '.' + CHAR_MAP[id].name).join('、'), 'sys');
    startRound(state);
    return { ok: true };
  }

  /* ============================ 回合：选角 ============================ */
  function startRound(state) {
    state.round++;
    state.effects.assassinated = null; state.effects.thief = null; state.effects.bewitched = null;
    state.effects.witchBy = null; state.effects.thiefBy = null;
    state.effects.magistrate = null; state.effects.blackmailer = null;
    state.witchResume = null;
    state.reaction = null;
    state.pendingQueen = null;
    state.roundConfirm = null;
    state.players.forEach(p => { p.chars = []; p.played = []; });

    const pool = CitCards.shuffle(state.charDeck, () => nextRand(state));
    const n = state.players.length;
    const crown = crownIdx(state);
    const draft = {
      pool: pool,
      faceUp: [],
      faceDown: [],
      steps: [],
      stepIdx: 0,
      sub: 'pick',
      crown: crown
    };

    // 依次传给左手边玩家（座位 +1 方向）
    const order = [];
    for (let k = 0; k < n; k++) order.push((crown + k) % n);

    if (n === 2) {
      // 8 张：先暗置 1 张
      draft.faceDown.push(draft.pool.shift());
      draft.steps = [
        { player: order[0], keep: 1, discard: 0 },
        { player: order[1], keep: 1, discard: 1 },
        { player: order[0], keep: 1, discard: 1 },
        { player: order[1], keep: 1, discard: 0 }
      ];
    } else if (n === 3) {
      draft.faceDown.push(draft.pool.shift());
      draft.steps = [];
      for (let k = 0; k < 6; k++) draft.steps.push({ player: order[k % 3], keep: 1, discard: 0 });
    } else {
      // 4~8 人：移除若干明置 + 1 张暗置
      const total = pool.length;
      const up = Math.max(0, total - n - 2);
      for (let k = 0; k < up; k++) {
        // 4 号角色不可被明置移除
        let idx = -1;
        for (let tries = 0; tries < 50; tries++) {
          const t = randInt(state, draft.pool.length);
          if (charOf(draft.pool[t]).num !== 4) { idx = t; break; }
        }
        if (idx < 0) idx = randInt(state, draft.pool.length);
        draft.faceUp.push(draft.pool.splice(idx, 1)[0]);
      }
      if (draft.pool.length > 0) draft.faceDown.push(draft.pool.splice(randInt(state, draft.pool.length), 1)[0]);
      for (let k = 0; k < n; k++) draft.steps.push({ player: order[k], keep: 1, discard: 0 });
      // 7~8 人：最后一位从「传下来的牌 + 暗置牌」中二选一
      if (n >= 7) draft.steps[draft.steps.length - 1].fromFaceDown = true;
    }

    state.draft = draft;
    state.phase = 'draft';
    if (draft.faceUp.length) {
      log(state, '第 ' + state.round + ' 轮：明置移除 ' + draft.faceUp.map(id => CHAR_MAP[id].name).join('、') +
        '，另有 ' + draft.faceDown.length + ' 张暗置移除。', 'sys');
    } else {
      log(state, '第 ' + state.round + ' 轮开始选角（' + draft.faceDown.length + ' 张暗置移除）。', 'sys');
    }
    return draft;
  }

  function draftOptions(state, playerId) {
    const d = state.draft;
    if (!d || state.phase !== 'draft') return { actions: [] };
    const step = d.steps[d.stepIdx];
    if (!step) return { actions: [] };
    const idx = playerIdx(state, playerId);
    if (step.player !== idx) return { actions: [], prompt: '等待其他玩家选择角色…' };

    let pool = d.pool;
    if (step.fromFaceDown && d.sub === 'pick') pool = d.pool.concat(d.faceDown);

    if (d.sub === 'pick') {
      return {
        prompt: '选择一张角色牌作为你的角色',
        actions: pool.map(id => ({
          type: 'draft_pick', charId: id,
          label: CHAR_MAP[id].num + ' · ' + CHAR_MAP[id].name,
          desc: CHAR_MAP[id].desc
        }))
      };
    } else {
      // 弃置（4 号角色不可被弃置）
      const opts = pool.filter(id => charOf(id).num !== 4);
      return {
        prompt: '再选择一张角色牌暗置弃掉（国王/皇帝/贵族不可弃置）',
        actions: opts.map(id => ({
          type: 'draft_discard', charId: id,
          label: CHAR_MAP[id].num + ' · ' + CHAR_MAP[id].name
        }))
      };
    }
  }

  function removeFromDraftPool(d, charId) {
    let i = d.pool.indexOf(charId);
    if (i >= 0) { d.pool.splice(i, 1); return true; }
    i = d.faceDown.indexOf(charId);
    if (i >= 0) { d.faceDown.splice(i, 1); return true; }
    return false;
  }

  function advanceDraft(state) {
    const d = state.draft;
    const step = d.steps[d.stepIdx];
    if (step && step.discard > 0 && d.sub === 'pick') { d.sub = 'discard'; return; }
    d.stepIdx++;
    d.sub = 'pick';
    if (d.stepIdx >= d.steps.length) {
      // 剩余角色牌暗置
      while (d.pool.length) d.faceDown.push(d.pool.shift());
      state.phase = 'action';
      buildCallQueue(state);
    }
  }

  /* ============================ 回合：叫号 ============================ */
  function buildCallQueue(state) {
    const q = [];
    state.players.forEach((p, i) => {
      p.chars.forEach(cid => q.push({ charId: cid, num: charOf(cid).num, playerIdx: i }));
    });
    q.sort((a, b) => a.num - b.num);
    state.callQueue = q;
    state.callIdx = 0;
    log(state, '—— 第 ' + state.round + ' 轮行动阶段开始 ——', 'round');
    beginNextCall(state);
  }

  function beginNextCall(state) {
    state.turn = null;
    if (state.callIdx >= state.callQueue.length) { endRound(state); return; }
    const entry = state.callQueue[state.callIdx];

    // 被刺杀
    if (state.effects.assassinated === entry.num) {
      const p = state.players[entry.playerIdx];
      log(state, '【' + entry.num + ' ' + charOf(entry.charId).name + '】被刺杀，' + p.name + ' 跳过本回合。', 'bad');
      notify(state, 'assassinated', {
        playerIdx: entry.playerIdx, playerId: p.id, playerName: p.name,
        num: entry.num, charName: charOf(entry.charId).name
      });
      state.callIdx++;
      return beginNextCall(state);
    }

    // 被施咒：受害者只能领资源，随后女巫接管
    if (state.effects.bewitched === entry.num) {
      state.turn = newTurn(state, entry, 'bewitched');
      applyNum4TurnStart(state, entry);
      const vp = state.players[entry.playerIdx];
      log(state, '【' + entry.num + ' ' + charOf(entry.charId).name + '】被施咒，' +
        vp.name + ' 只能领取资源。', 'magic');
      notify(state, 'bewitched', {
        playerIdx: entry.playerIdx, playerId: vp.id, playerName: vp.name,
        num: entry.num, charName: charOf(entry.charId).name,
        byName: state.effects.witchBy != null ? state.players[state.effects.witchBy].name : ''
      });
      return;
    }

    // 盗贼结算
    if (state.effects.thief === entry.num && state.effects.thiefBy != null) {
      const victim = state.players[entry.playerIdx];
      const thief = state.players[state.effects.thiefBy];
      const amt = victim.gold;
      victim.gold = 0;
      thief.gold += amt;
      log(state, '【盗贼】' + thief.name + ' 偷走了 ' + victim.name + ' 的 ' + amt + ' 枚金币。', 'bad');
      notify(state, 'thief_steal', {
        playerIdx: entry.playerIdx, playerId: victim.id, playerName: victim.name,
        byIdx: state.effects.thiefBy, byName: thief.name, amount: amt,
        num: entry.num, charName: charOf(entry.charId).name
      });
      state.effects.thief = null;
    }

    // 勒索者的威胁必须在目标领取资源前处理：先问目标要不要花钱赎回，
    // 拒绝的话冻结该玩家，交给勒索者决定是否翻开盖牌（见 blackmailer_refuse）。
    const threat = state.effects.blackmailer;
    if (threat && threat.nums.indexOf(entry.num) >= 0 && (threat.done || []).indexOf(entry.num) < 0) {
      const target = state.players[entry.playerIdx];
      state.turn = newTurn(state, entry, 'main');
      state.turn.pending = { kind: 'blackmailer_threat', targetIdx: entry.playerIdx,
        signed: threat.signed === entry.num };
      log(state, '【勒索者】' + target.name + ' 受到威胁，可支付一半金币赎回。', 'bad');
      // 不写 signed：中没中真标记正是受害者要赌的信息，客户端也不该在响应前拿到。
      notify(state, 'blackmailer_threat', { playerIdx: entry.playerIdx, playerId: target.id,
        playerName: target.name });
      // 勒索只是插到回合开头问一句，角色本身的回合已经开始了 —— 4 号的即时收益照给。
      applyNum4TurnStart(state, entry);
      return;
    }

    state.turn = newTurn(state, entry, 'main');

    // 4 号角色的即时收益（皇冠 / 贵族抽牌）
    const c = charOf(entry.charId);
    applyNum4TurnStart(state, entry);
    if (c.id === 'queen') resolveQueen(state, entry);
  }

  /**
   * 4 号角色「被叫到号」这一瞬间结算的持有者收益：皇冠，以及贵族的皇家建筑抽牌。
   *
   * 为什么必须单独抽出来：这两项都不是「回合内的一个行动」，而是叫号瞬间就落定的
   * 被动收益，所以只要该角色被叫到号就该结算 —— 不管回合随后被打断成什么形态。
   * 女巫接管的是「剩余行动」（建造、主动能力），勒索者只是插到回合开头问一句，
   * 两者都不该把已经结算过的被动收益吞掉或转走。
   *
   * 被刺杀时【不】调用：那一整个回合被跳过，皇冠改在轮末（endRound）补发，
   * 贵族的抽牌则随回合一起失去（与官方「被刺杀角色失去整回合」一致）。
   */
  function applyNum4TurnStart(state, entry) {
    if (entry.num !== 4) return;
    const c = charOf(entry.charId);
    if (c.id === 'king' || c.id === 'noble') setCrown(state, entry.playerIdx);
    // 贵族：每 1 栋皇家（黄）建筑抽 1 张。归角色持有者本人，不随接管/打断转移。
    if (c.id === 'noble') doNobleIncome(state);
  }

  function newTurn(state, entry, phase) {
    const c = charOf(entry.charId);
    return {
      charId: entry.charId,
      num: entry.num,
      playerIdx: entry.playerIdx,
      phase: phase,                    // main | bewitched | witch_resume
      takenResources: false,
      incomeTaken: false,
      abilityUsed: false,
      builds: 0,
      spentOnBuild: 0,
      usedLab: false,
      usedSmithy: false,
      usedMuseum: false,
      pending: null,
      bonusDone: false
    };
  }

  function setCrown(state, idx) {
    state.players.forEach((p, i) => { p.hasCrown = (i === idx); });
    log(state, '【皇冠】' + state.players[idx].name + ' 获得皇冠，下轮优先选角。', 'crown');
  }

  function resolveQueen(state, entry) {
    const holder = state.players.findIndex(p => p.chars.some(c => charOf(c).num === 4));
    if (holder < 0) return;
    if (state.effects.assassinated === 4) { state.pendingQueen = { playerIdx: entry.playerIdx }; return; }
    const n = state.players.length;
    const a = entry.playerIdx, b = holder;
    const adjacent = (Math.abs(a - b) === 1) || (Math.abs(a - b) === n - 1);
    if (adjacent) {
      state.players[entry.playerIdx].gold += 3;
      notifyGoldGain(state, entry.playerIdx, 3, null, '皇后相邻奖励');
      log(state, '【皇后】' + state.players[entry.playerIdx].name + ' 坐在 ' +
        state.players[holder].name + '（4号角色）旁边，获得 3 枚金币。', 'good');
    } else {
      log(state, '【皇后】座位未与 4 号角色相邻，未获得金币。', 'info');
    }
  }

  function doNobleIncome(state) {
    const t = state.turn;
    const p = state.players[t.playerIdx];
    const n = countColorForIncome(p, 'yellow', 'yellow');
    if (n > 0) {
      const cards = drawCards(state, n);
      p.hand = p.hand.concat(cards);
      notify(state, 'noble_draw', {
        playerIdx: t.playerIdx, playerId: p.id, playerName: p.name,
        amount: n, cardNames: cards.map(c => c.name)
      });
      log(state, '【贵族】' + p.name + ' 因 ' + n + ' 栋皇家建筑抽取 ' + n + ' 张建筑牌。', 'good');
    }
    t.incomeTaken = true;
  }

  /* ========================= 行动可用性 ========================= */
  function buildLimitFor(state, turn) {
    const c = charOf(turn.charId);
    if (turn.phase === 'witch_resume') return Math.max(1, c.buildLimit);
    return c.buildLimit;
  }

  function canBuildCard(state, p, card, turn) {
    const c = charOf(turn.charId);
    if (card.cost > p.gold) return false;
    if (c.id === 'navigator' && turn.phase !== 'witch_resume') return false;
    const limit = buildLimitFor(state, turn);
    // 生意人：绿色建筑不受建造限额限制
    const greenFree = (c.id === 'businessman' && turn.phase !== 'witch_resume' && card.color === 'green');
    if (!greenFree && turn.builds >= limit) return false;
    const same = p.city.filter(d => d.name === card.name).length;
    return same < maxSameName(p);
  }

  function canBuildIgnoringGold(state, p, card, turn) {
    const c = charOf(turn.charId);
    if (!c || c.id !== 'bishop' || (c.id === 'navigator' && turn.phase !== 'witch_resume')) return false;
    const limit = buildLimitFor(state, turn);
    if (turn.builds >= limit) return false;
    return p.city.filter(d => d.name === card.name).length < maxSameName(p);
  }

  /* ------------------------- 建造的落定与收尾 ------------------------- */
  // 建造被拆成两段，是为了让「行政官是否发动逮捕令」能在建筑真正落地之前决定：
  // 先由 completeBuild 扣费入手城市，再由 finishBuild 做税务、日志与终局判定。
  function completeBuild(state, t, idx, card) {
    const p = state.players[idx];
    p.gold -= card.cost;
    t.spentOnBuild += card.cost;
    p.hand = p.hand.filter(x => x.uid !== card.uid);
    // 保留 card 上可能附着的 museum 牌（经由墓地回收等路径回到手牌的建筑会带着它们）。
    // 不能无条件 museum: [] —— 那会让这些物理牌从整局中消失。
    const built = Object.assign({}, card, {
      beautified: 0, builtRound: state.round,
      museum: Array.isArray(card.museum) ? card.museum.slice() : []
    });
    p.city.push(built);
    t.builds++;
    return built;
  }

  // confiscateBy >= 0 表示本次建造被该玩家（行政官）没收。
  function finishBuild(state, t, idx, card, built, confiscateBy) {
    const p = state.players[idx];
    const confiscated = confiscateBy >= 0;
    // 税务官的标记跨轮保留；行政官没收时由行政官承担本次税费。
    const taxCollector = state.players.findIndex(player => player.chars.some(cid => cid === 'tax_collector'));
    const taxPayer = confiscated ? state.players[confiscateBy] : p;
    if (state.charDeck.some(cid => cid === 'tax_collector') && taxPayer !== state.players[taxCollector] && taxPayer.gold > 0) {
      taxPayer.gold--; state.effects.taxCollectorGold = (state.effects.taxCollectorGold || 0) + 1;
      log(state, '【税务官】收取 1 枚建筑税。', 'info');
    }
    log(state, p.name + ' 建造了『' + card.name + '』（' + card.cost + ' 金）。', 'build');
    notify(state, 'built', {
      playerIdx: idx, playerId: p.id, playerName: p.name,
      card: { uid: built.uid, name: built.name, en: built.en, desc: built.desc,
        color: built.color, cost: built.cost, scoreValue: built.scoreValue,
        purple: built.purple || null }
    });
    if (p.city.length >= state.config.endDistricts && state.firstToFinish < 0) {
      state.firstToFinish = idx;
      log(state, '* ' + p.name + ' 率先建成第 ' + state.config.endDistricts + ' 栋建筑，本轮结束后游戏结束！', 'sys');
    }
    // 炼金术士的建造花费统一在 endTurn 回收（含女巫接管的情况）
    return ok();
  }

  function resolveBuild(state, t, idx, card, confiscateBy) {
    const built = completeBuild(state, t, idx, card);
    if (confiscateBy >= 0) {
      const p = state.players[idx];
      const magistrate = state.players[confiscateBy];
      // 没收：建筑从目标城市移出、返还建造费，行政官免费获得该建筑。
      // 目标的建造次数仍然照计（t.builds 已在 completeBuild 里 ++）。
      p.city = p.city.filter(d => d.uid !== built.uid);
      p.gold += card.cost;
      notifyGoldGain(state, idx, card.cost, null, '行政官没收退款');
      magistrate.city.push(built);
      log(state, '【行政官】' + magistrate.name + ' 没收了 ' + p.name + ' 建造的『' + card.name + '』。', 'bad');
      notify(state, 'magistrate_confiscate', { byIdx: confiscateBy, byId: magistrate.id, byName: magistrate.name,
        playerIdx: idx, playerId: p.id, playerName: p.name, card: { uid: card.uid, name: card.name, cost: card.cost } });
    }
    return finishBuild(state, t, idx, card, built, confiscateBy);
  }

  // 状态同步/重连时，极少数情况下可能出现「已进入行动阶段，但 turn 为空」的
  // 中间状态。只要本轮还有角色没有叫到，就可以安全地从行动队列恢复当前行动者。
  // 这也兼容旧版本服务进程留下的房间状态，避免客户端永远停留在“等待开始”。
  function ensureActionTurn(state) {
    if (state.phase !== 'action' || state.turn || state.reaction || state.roundConfirm) return;
    if (!Array.isArray(state.callQueue) || state.callIdx == null) {
      buildCallQueue(state);
      return;
    }
    if (state.callIdx < state.callQueue.length) beginNextCall(state);
  }

  // 兼容断线/旧版本房间留下的半成品选角状态。正常流程不会走到这里；
  // 但如果 draft 数据在同步时丢失，而每位玩家已经拿到本轮所需角色，
  // 可以根据玩家手上的角色安全重建行动阶段。
  function repairState(state) {
    // 老存档 / 手工构造的局面没有观测账本，补上空数组让信念层可以无条件读
    if (!Array.isArray(state.observations)) state.observations = [];
    if (state.phase === 'draft') {
      const expected = state.players.length <= 3 ? 2 : 1;
      const allChosen = state.players.length > 0 &&
        state.players.every(p => Array.isArray(p.chars) && p.chars.length >= expected);
      const step = state.draft && state.draft.steps
        ? state.draft.steps[state.draft.stepIdx] : null;
      if (allChosen && (!state.draft || !step)) {
        if (state.draft && Array.isArray(state.draft.pool)) {
          while (state.draft.pool.length) state.draft.faceDown.push(state.draft.pool.shift());
        }
        state.phase = 'action';
        buildCallQueue(state);
      }
    }
    // 勒索者回合结束 / 状态过期后残留的「是否翻开威胁标记」会锁死全场，这里兜底清掉
    if (state.reaction && state.reaction.kind === 'blackmailer' && !state.effects.blackmailer) {
      state.reaction = null;
      if (state.turn) { state.turn.pending = null; state.turn.takenResources = false; }
    }
    if (state.phase === 'action') ensureActionTurn(state);
    return state;
  }

  function getAvailableActions(state, playerId) {
    repairState(state);
    if (state.phase === 'gameover') return { phase: 'gameover', actions: [], prompt: '游戏结束' };
    if (state.phase === 'draft') return draftOptions(state, playerId);
    if (state.phase !== 'action') return { phase: state.phase, actions: [], prompt: '' };

    const idx = playerIdx(state, playerId);

    // 需要其它玩家响应（墓地 / 行政官 / 勒索者）
    if (state.reaction) {
      if (state.reaction.playerIdx !== idx) {
        // 被勒索者威胁的玩家处于冻结状态，提示语要说明在等谁
        if (state.reaction.kind === 'blackmailer' && state.reaction.targetIdx === idx) {
          return { actions: [], prompt: '请等待勒索者翻开威胁标记……' };
        }
        return { actions: [], prompt: '等待其他玩家响应…' };
      }
      const r = state.reaction;
      if (r.kind === 'magistrate') {
        return {
          prompt: r.prompt,
          actions: [
            { type: 'reaction', use: true, label: '发动逮捕令：没收『' + r.card.name + '』，免费建入自己城市' },
            { type: 'reaction', use: false, label: '不发动' }
          ]
        };
      }
      if (r.kind === 'blackmailer') {
        return {
          prompt: r.prompt,
          actions: [
            { type: 'reaction', use: true, label: '是' },
            { type: 'reaction', use: false, label: '否' }
          ]
        };
      }
      return {
        prompt: r.prompt,
        actions: [
          { type: 'reaction', use: true, label: '使用【墓地】：支付 1 金，将「' + r.card.name + '」收入手牌' },
          { type: 'reaction', use: false, label: '不使用' }
        ]
      };
    }

    // 轮末等待所有玩家确认战果
    if (state.roundConfirm) {
      const done = state.roundConfirm.confirmed.filter(Boolean).length;
      if (state.roundConfirm.confirmed[idx]) {
        return { actions: [], prompt: '已确认，等待其他玩家（' + done + '/' + state.players.length + '）…' };
      }
      return {
        prompt: '第 ' + state.roundConfirm.round + ' 轮结束（已确认 ' + done + '/' + state.players.length + '）',
        actions: [{ type: 'confirm_round', label: '确认本轮战果' }]
      };
    }

    const t = state.turn;
    if (!t) return { actions: [], prompt: '' };
    if (t.playerIdx !== idx) {
      return { actions: [], prompt: '等待 ' + state.players[t.playerIdx].name + ' 行动…' };
    }

    // 多步能力等待中。
    // 兜底：有些多步步骤在特定局面下一个候选都列不出来（最典型的是法师选中了手牌为空的
    // 玩家，'wizard_card' 的候选就为空），此时必须给出「放弃使用能力」出口，
    // 否则整个房间会永久卡在这个玩家身上（训练里表现为「没有合法行动」直接报错）。
    if (t.pending) {
      const opts = pendingActions(state, t);
      if (!(opts.actions || []).some(a => !a.disabled)) {
        return { prompt: opts.prompt || '没有可选项',
          actions: [{ type: 'ability_skip', label: '没有可选项，放弃使用能力' }] };
      }
      return opts;
    }

    const p = state.players[idx];
    const c = charOf(t.charId);
    const acts = [];

    if (t.phase === 'bewitched') {
      if (!t.takenResources) {
        acts.push({ type: 'take_gold', label: '领取 2 枚金币' });
        acts.push({ type: 'take_cards', label: '抽 2 张建筑牌，保留 1 张' });
      }
      return { prompt: '你被女巫施咒，只能领取资源。', actions: acts, turn: turnInfo(state, t) };
    }

    if (!t.takenResources) {
      acts.push({ type: 'take_gold', label: '领取 2 枚金币' + (c.goldBonus ? '（+'+c.goldBonus+'）' : '') });
      let dlabel = '抽 2 张建筑牌，保留 1 张';
      if (p.city.some(d => d.purple && d.purple.effect === 'keepBoth')) dlabel = '抽 2 张建筑牌，全部保留（图书馆）';
      else if (p.city.some(d => d.purple && d.purple.effect === 'draw3keep1')) dlabel = '抽 3 张建筑牌，保留 1 张（天文台）';
      acts.push({ type: 'take_cards', label: dlabel });
      return { prompt: '『' + c.name + '』— 先领取资源', actions: acts, turn: turnInfo(state, t) };
    }

    if (t.pending && t.pending.kind === 'blackmailer_threat') return pendingActions(state, t);

    // 角色能力
    if (!t.abilityUsed) {
      const label = abilityLabel(c.id);
      if (label) acts.push({
        type: 'ability',
        label: label,
        // 外交官必须先有一栋自己的建筑，才能进入交换流程。
        disabled: c.id === 'diplomat' && p.city.length === 0
      });
    }

    // 角色收入
    if (!t.incomeTaken) {
      const inc = incomeAmount(state, p, t);
      if (inc != null) acts.push({ type: 'income', label: '领取角色收入（' + inc.text + '）' });
    }
    // 修士：从最富有者拿 1 金
    if (c.id === 'monk' && t.incomeTaken && !t.monkExtraTaken) {
      const richest = richestOther(state, idx);
      if (richest >= 0 && state.players[richest].gold > p.gold) {
        acts.push({ type: 'monk_take', label: '从 ' + state.players[richest].name + '（最富有）处拿 1 枚金币' });
      }
    }

    // 建造
    p.hand.forEach(card => {
      if (canBuildCard(state, p, card, turnSafe(t))) {
        acts.push({ type: 'build', uid: card.uid, label: '建造『' + card.name + '』（' + card.cost + ' 金）',
                    color: card.color });
      } else if (c.id === 'bishop' && card.cost > p.gold && canBuildIgnoringGold(state, p, card, turnSafe(t))) {
        const shortfall = card.cost - p.gold;
        if (p.hand.length - 1 >= shortfall && state.players.some((payer, payerIdx) =>
          payerIdx !== idx && payer.gold >= shortfall)) {
          /* 三段式流程的第一步只选择建筑，代偿玩家在下一步再选。 */
          acts.push({ type: 'build', uid: card.uid,
            label: '建造『' + card.name + '』（先选择代偿玩家，再偿还 ' + shortfall + ' 张手牌）',
            color: card.color });
        }
      }
    });

    // 紫色建筑主动能力
    p.city.forEach(d => {
      if (!d.purple) return;
      if (d.purple.effect === 'lab' && !t.usedLab && p.hand.length > 0) {
        acts.push({ type: 'lab', uid: d.uid, label: '【实验室】弃 1 张手牌换 1 金' });
      }
      if (d.purple.effect === 'smithy' && !t.usedSmithy && p.gold >= 2) {
        acts.push({ type: 'smithy', uid: d.uid, label: '【铁匠铺】付 2 金抽 3 张建筑牌' });
      }
      if (d.purple.effect === 'museum' && !t.usedMuseum && p.hand.length > 0) {
        acts.push({ type: 'museum', uid: d.uid, label: '【博物馆】将 1 张手牌放到博物馆下（计分+1）' });
      }
    });

    if (t.phase === 'witch_resume') {
      acts.push({ type: 'end_turn', label: '结束本回合' });
      return { prompt: '女巫接管『' + c.name + '』的剩余行动', actions: acts, turn: turnInfo(state, t) };
    }

    acts.push({ type: 'end_turn', label: '结束本回合' });
    return { prompt: '『' + c.name + '』— 你的回合', actions: acts, turn: turnInfo(state, t) };
  }
  function turnSafe(t) { return t; }

  function turnInfo(state, t) {
    const c = charOf(t.charId);
    return { charId: t.charId, name: c.name, num: t.num, phase: t.phase,
             builds: t.builds, buildLimit: buildLimitFor(state, t) };
  }

  function abilityLabel(id) {
    switch (id) {
      case 'assassin': return '【刺客】刺杀一个角色';
      case 'witch': return '【女巫】对一个角色施咒';
      case 'thief': return '【盗贼】偷窃一个角色';
      case 'magistrate': return '【行政官】分配逮捕令';
      case 'spy': return '【间谍】查看并调查手牌';
      case 'blackmailer': return '【勒索者】分配威胁标记';
      case 'magician': return '【魔术师】使用能力';
      case 'wizard': return '【法师】查看并取得一张手牌';
      case 'warlord': return '【领主】摧毁一栋建筑';
      case 'diplomat': return '【外交官】交换建筑';
      case 'marshal': return '【元帅】抢夺建筑（费用≤3）';
      case 'artist': return '【艺术家】美化建筑';
      case 'emperor': return '【皇帝】转移皇冠';
      case 'tax_collector': return '【税务官】收取建筑税';
      case 'navigator': return '【航海家】领取额外奖励';
      case 'scholar': return '【学者】抽 7 张选 1 张';
      case 'prophet': return '【预言家】抽取对手手牌';
      default: return null;
    }
  }

  function incomeAmount(state, p, t) {
    const c = charOf(t.charId);
    if (c.id === 'bishop') {
      const n = countColorForIncome(p, 'blue', 'blue');
      return { n: n, color: 'blue', kind: 'cards', text: n + ' 张建筑牌（宗教建筑 ×' + n + '）' };
    }
    let color = c.income;
    if (t.phase === 'witch_resume') color = c.income;
    if (!color) return null;
    const n = countColorForIncome(p, color, color);
    return { n: n, color: color, text: n + ' 金（' + CitCards.COLORS[color].name + ' ×' + n + '）' };
  }

  function richestOther(state, idx) {
    let best = -1, bestGold = -1, tie = false;
    state.players.forEach((p, i) => {
      if (i === idx) return;
      if (p.gold > bestGold) { bestGold = p.gold; best = i; tie = false; }
      else if (p.gold === bestGold) tie = true;
    });
    if (tie) {
      // 平手时取座位最靠前的
      for (let i = 0; i < state.players.length; i++) {
        if (i !== idx && state.players[i].gold === bestGold) return i;
      }
    }
    return best;
  }

  /* ------------------------- 多步能力的选项 ------------------------- */
  function pendingActions(state, t) {
    const pd = t.pending;
    const p = state.players[t.playerIdx];
    switch (pd.kind) {
      case 'assassin':
        return { prompt: '【刺客】选择要刺杀的角色编号', actions: charChoices(state, t, [1], 'choose_char') };
      case 'thief':
        return { prompt: '【盗贼】选择要偷窃的角色编号', actions: charChoices(state, t, [1], 'choose_char') };
      case 'witch_target':
        return { prompt: '【女巫】选择要施咒的角色编号', actions: charChoices(state, t, [1], 'choose_char') };
      case 'magistrate_declare':
        return { prompt: '【行政官】先选择真逮捕令的目标', actions:
          charChoices(state, t, [], 'magistrate_signed').map(a => ({ type: 'magistrate_signed', num: a.num, label: a.label })) };
      case 'magistrate_second':
      case 'magistrate_third': {
        const used = pd.used || [];
        return { prompt: '【行政官】选择第 ' + used.length + ' 个假逮捕令的目标', actions:
          charChoices(state, t, used.concat([t.num]), 'magistrate_char') };
      }
      case 'blackmailer_declare':
        return { prompt: '【勒索者】选择第 1 个威胁角色编号（1 号角色、被刺杀者、被施咒者、已有逮捕令者不可选）',
          actions: charChoices(state, t, blackmailerBlockedNums(state), 'blackmailer_char') };
      case 'blackmailer_second':
        return { prompt: '【勒索者】选择第 2 个威胁角色编号', actions:
          charChoices(state, t, blackmailerBlockedNums(state).concat([t.num, pd.first]), 'blackmailer_char') };
      case 'blackmailer_signed': {
        // 两个目标已暗置，现在由勒索者本人决定哪一个是真（签名）威胁标记
        const nums = pd.nums || [];
        return { prompt: '【勒索者】选择把真威胁标记放在哪个角色身上（另一个为假威胁标记）',
          actions: nums.map(n => ({ type: 'blackmailer_signed', num: n,
            label: n + ' · ' + (charByNum(state, n) ? charByNum(state, n).name : '?') })) };
      }
      case 'blackmailer_threat':
        return { prompt: '【勒索者】你受到威胁，可支付一半金币赎回', actions: [
          { type: 'blackmailer_bribe', label: '支付 ' + Math.floor(p.gold / 2) + ' 金赎回' },
          { type: 'blackmailer_refuse', label: '拒绝支付' }
        ] };
      case 'spy_target':
        return { prompt: '【间谍】选择要查看手牌的玩家', actions: otherPlayers(state, t.playerIdx).map(i => ({
          type: 'spy_target', target: state.players[i].id, label: state.players[i].name })) };
      case 'spy_color':
        return { prompt: '【间谍】选择要调查的建筑类型', actions: [
          ['yellow','皇家'], ['blue','宗教'], ['green','商业'], ['red','军事'], ['purple','独特']
        ].map(([color, name]) => ({ type: 'spy_color', color, label: name + '建筑' })) };
      case 'wizard_target':
        // 只列出「有手牌」的玩家：选中空手玩家会让下一步 wizard_card 无牌可选而卡住。
        return { prompt: '【法师】选择要查看手牌的玩家', actions:
          otherPlayers(state, t.playerIdx).filter(i => state.players[i].hand.length > 0).map(i => ({
            type: 'wizard_target', target: state.players[i].id,
            label: state.players[i].name + '（' + state.players[i].hand.length + ' 张手牌）' })) };
      case 'wizard_card':
        return { prompt: '【法师】选择一张牌', actions: (pd.cards || []).map(c => ({ type: 'wizard_card', uid: c.uid,
          label: c.name + '（' + c.cost + ' 金）', color: c.color })) };
      case 'wizard_choice':
        return { prompt: '【法师】将牌加入手牌或立即建造', actions: [
          { type: 'wizard_take', label: '加入手牌' },
          { type: 'wizard_build', label: '立即建造（不占建造次数）' },
          { type: 'pending_back', to: 'wizard_card', label: '« 返回重新选择手牌' }
        ] };
      case 'bishop_repay':
        return { prompt: '【主教】选择 ' + pd.amount + ' 张手牌，偿还 ' + state.players[pd.payerIdx].name + ' 代付的 ' + pd.amount + ' 金',
          actions: [{ type: 'choose_cards', uids: [], label: '确认交出所选手牌' }],
          selectable: 'hand', multi: true, max: pd.amount };
      case 'bishop_payer': {
        const card = p.hand.find(c => c.uid === pd.uid);
        if (!card) return { prompt: '【主教】建筑牌已不存在', actions: [] };
        const payers = otherPlayers(state, t.playerIdx).filter(i => state.players[i].gold >= pd.amount);
        return { prompt: '【主教】选择为『' + card.name + '』代偿 ' + pd.amount + ' 金的玩家', actions:
          payers.map(i => ({ type: 'choose_player', target: state.players[i].id,
            label: state.players[i].name + '（支付 ' + pd.amount + ' 金）' })) };
      }
      case 'magician_choice':
        return { prompt: '【魔术师】选择一种能力', actions: [
          { type: 'magician_mode', mode: 'swap', label: '与一位玩家交换全部手牌' },
          { type: 'magician_mode', mode: 'redraw', label: '弃掉任意张手牌并重抽' }
        ]};
      case 'magician_swap':
        return { prompt: '【魔术师】选择与谁交换手牌', actions: otherPlayers(state, t.playerIdx).map(i => ({
          type: 'choose_player', target: state.players[i].id,
          label: state.players[i].name + '（' + state.players[i].hand.length + ' 张手牌）'
        })).concat([{ type: 'pending_back', to: 'magician_choice', label: '« 返回上一步', disabled: true }]) };
      case 'magician_redraw':
        return { prompt: '【魔术师】选择要弃掉的手牌（可留空）', actions: [
          { type: 'choose_cards', uids: [], label: '确定（可点选手牌后再确定）' },
          { type: 'pending_back', to: 'magician_choice', label: '« 返回上一步', disabled: true }
        ], selectable: 'hand', multi: true };
      case 'warlord_destroy':
        return { prompt: '【领主】选择要摧毁的建筑', actions: destroyChoices(state, t) };
      case 'marshal_seize':
        return { prompt: '【元帅】选择要抢夺的建筑（费用 ≤ 3）', actions: seizeChoices(state, t) };
      case 'diplomat_mine': {
        // 自己的堡垒（immune）同样不可用于交换 —— 提交时会被 doDiplomatSwap 拒绝，
        // 若玩家手里恰好只有堡垒，列表里唯一的候选必然失败，整步就没有合法动作了。
        const acts = ownDistrictChoices(state, t, false).filter(a => {
          const card = p.city.find(c => c.uid === a.uid);
          return card && canTargetDistrict(state, card);
        });
        if (acts.length === 0) acts.push({ type: 'ability_skip', label: '没有可用于交换的建筑，放弃使用能力' });
        return { prompt: '【外交官】选择你自己的一栋建筑用于交换', actions: acts };
      }
      case 'diplomat_theirs':
        return { prompt: '【外交官】选择要换取的建筑', actions: diplomatTargets(state, t).concat([
          { type: 'pending_back', to: 'diplomat_mine', label: '« 返回上一步', disabled: true }
        ]) };
      case 'artist': {
        const chosen = pd.selected || [];
        // 已达 2 栋上限或金币不足时，不要再给出建筑选项：
        // 这些选项发出去必被引擎拒绝（最多美化 2 栋 / 金币不足），
        // 而前端会把它们渲染成高亮可点的建筑，玩家点了只会得到一句报错。
        const full = chosen.length >= 2;
        const broke = p.gold <= chosen.length;   // 每栋 1 金，已选 N 栋再选就要 N+1 金
        const choices = (full || broke) ? [] : ownDistrictChoices(state, t, true, chosen);
        const prompt = full ? '【艺术家】已选满 2 栋，确认或跳过'
          : broke ? '【艺术家】金币不足，无法继续美化，确认或跳过'
          : '【艺术家】选择要美化的建筑（最多 2 栋，每栋 1 金）';
        return { prompt: prompt, actions:
          choices.concat(
            [{ type: 'artist_done', uids: chosen,
               label: chosen.length ? '确定美化（' + chosen.length + ' 栋）' : '不美化，跳过' }]
          ), selectable: 'city', multi: true, max: 2 };
      }
      case 'navigator_bonus':
        return { prompt: '【航海家】选择额外奖励', actions: [
          { type: 'navigator_bonus', mode: 'gold', label: '额外获得 4 枚金币' },
          { type: 'navigator_bonus', mode: 'cards', label: '额外抽取 4 张建筑牌' }
        ]};
      case 'scholar_pick':
        return { prompt: '【学者】从 7 张中选择 1 张', actions: (pd.cards || []).map(c => ({
          type: 'scholar_pick', uid: c.uid, label: c.name + '（' + CitCards.COLORS[c.color].name + ' ' + c.cost + ' 金）',
          color: c.color
        }))};
      case 'monk_declare': {
        const n = countColorForIncome(p, 'blue', 'blue');
        const opts = [];
        for (let g = 0; g <= n; g++) opts.push({ type: 'monk_resource', gold: g, cards: n - g,
          label: g + ' 金 + ' + (n - g) + ' 张建筑牌' });
        return { prompt: '【修士】宣告要领取的资源组合（共 ' + n + ' 份）', actions: opts };
      }
      case 'abbot_declare': {
        const n = countColorForIncome(p, 'blue', 'blue');
        const opts = [];
        for (let g = 0; g <= n; g++) opts.push({ type: 'abbot_resource', gold: g, cards: n - g,
          label: g + ' 金 + ' + (n - g) + ' 张建筑牌' });
        return { prompt: '【住持】宣告要领取的资源组合（共 ' + n + ' 份）', actions: opts };
      }
      case 'tax_collect':
        return { prompt: '【税务官】收取税务标记上的金币', actions: [
          { type: 'tax_collect', label: '收取 ' + (state.effects.taxCollectorGold || 0) + ' 枚金币' }
        ] };
      case 'emperor_crown':
        return { prompt: '【皇帝】将皇冠交给谁？', actions: otherPlayers(state, t.playerIdx).map(i => ({
          type: 'emperor_crown', target: state.players[i].id, label: state.players[i].name
        }))};
      case 'emperor_take':
        return { prompt: '【皇帝】从 ' + state.players[pd.targetIdx].name + ' 处拿取', actions: [
          { type: 'emperor_take', mode: 'gold', label: '拿 1 枚金币' },
          { type: 'emperor_take', mode: 'card', label: '随机拿 1 张手牌' },
          { type: 'pending_back', to: 'emperor_crown', label: '« 返回上一步（重新选皇冠对象）', disabled: true }
        ]};
      case 'prophet_give':
        return { prompt: '【预言家】还给 ' + state.players[pd.targetIdx].name + ' 一张手牌', actions:
          p.hand.map(c => ({ type: 'prophet_give', uid: c.uid,
            label: c.name + '（' + CitCards.COLORS[c.color].name + ' ' + c.cost + ' 金）', color: c.color })) };
      case 'draw_keep':
        return { prompt: pd.prompt || '选择要保留的建筑牌', actions: (pd.cards || []).map(c => ({
          type: 'draw_keep', uid: c.uid,
          label: c.name + '（' + CitCards.COLORS[c.color].name + ' ' + c.cost + ' 金）', color: c.color
        }))};
    }
    return { prompt: '', actions: [] };
  }

  /** 可选的其它玩家 */
  function otherPlayers(state, idx) {
    const out = [];
    for (let i = 0; i < state.players.length; i++) if (i !== idx) out.push(i);
    return out;
  }

  /**
   * 刺客 / 盗贼 / 女巫 选择目标时的可选角色。
   * 候选 = 本局全部角色（state.charDeck），只剔除：
   *   - 明置移除的角色（draft.faceUp，全场已知其不在场）
   *   - 自己（t.num）
   *   - excludeNums（盗贼固定为 [1] 刺客）
   * 暗置移除 / 被刺杀 / 被施咒 等角色仍可选：规则允许指名，只是命中后可能无效。
   */
  /**
   * 威胁标记的禁用目标（勒索者专用）。
   * 规则上不能把威胁标记塞给：
   *   - 1 号角色（刺客 / 女巫 / 行政官，官方规则即禁止）
   *   - 本轮被刺杀的角色（他根本不会行动，标记毫无意义）
   *   - 本轮被施咒的角色（同上）
   *   - 已经挂上逮捕令标记的角色（一个人不能同时被两套暗置标记盯上）
   * 行政官是 1 号位、勒索者是 2 号位，所以轮到勒索者时逮捕令一定已经分完了。
   */
  function blackmailerBlockedNums(state) {
    const out = [1];
    const push = n => {
      if (n == null || n === false || !Number.isFinite(Number(n))) return;
      const v = Number(n);
      if (out.indexOf(v) < 0) out.push(v);
    };
    push(state.effects.assassinated);
    push(state.effects.bewitched);
    const mg = state.effects.magistrate;
    if (mg && Array.isArray(mg.nums)) mg.nums.forEach(push);
    return out;
  }

  /** 勒索者当前真正能下标记的角色编号（已剔除禁用名单与 exclude）。 */
  function blackmailerValidNums(state, t, exclude) {
    const blocked = blackmailerBlockedNums(state).concat(exclude || []);
    return charChoices(state, t, blocked, 'blackmailer_char')
      .filter(a => a.type === 'blackmailer_char')
      .map(a => a.num);
  }

  /**
   * 落地威胁标记：nums 为被标记的 1~2 个角色编号，signed 为其中唯一真标记。
   * 去向对全场公开，哪个是真的保密。
   */
  function commitBlackmailer(state, idx, t, nums, signed) {
    const p = state.players[idx];
    state.effects.blackmailer = { nums: nums.slice(), signed: signed, playerIdx: idx, done: [], revealed: [] };
    t.abilityUsed = true; t.pending = null;
    const targets = nums.map(num => {
      const cid = (state.charDeck || []).find(id => charOf(id).num === num);
      const c = cid ? charOf(cid) : null;
      return { num: num, charId: cid || '', name: c ? c.name : '未知角色' };
    });
    log(state, '【勒索者】' + p.name + ' 把 ' + nums.length + ' 个威胁标记发给了 ' +
      targets.map(x => x.num + ' 号·' + x.name).join('、') +
      (nums.length > 1 ? '（其中只有一个是真的）。' : '。'), 'magic');
    notify(state, 'blackmailer_declare', {
      byIdx: idx, byId: p.id, byName: p.name, nums: targets.map(x => x.num),
      targets: targets.map(x => ({ num: x.num, name: x.name }))
    });
    return ok();
  }

  function charChoices(state, t, excludeNums, actionType) {
    const faceUpRemoved = {};
    if (state.draft && Array.isArray(state.draft.faceUp)) {
      state.draft.faceUp.forEach(id => { faceUpRemoved[charOf(id).num] = true; });
    }
    const out = [];
    (state.charDeck || []).forEach(id => {
      const c = charOf(id);
      const num = c.num;
      if (faceUpRemoved[num]) return;        // 明置移除：排除
      if (t.num === num) return;             // 不能选自己
      if (excludeNums.indexOf(num) >= 0) return; // 盗贼不能偷刺客
      out.push({ type: actionType, num: num, label: num + ' · ' + c.name });
    });
    out.sort((a, b) => a.num - b.num);
    if (out.length === 0) out.push({ type: 'ability_skip', label: '无可选目标，放弃使用能力' });
    return out;
  }

  /**
   * 住持保护只看公开信息（played 对所有观看者都公开）。
   * 8 号角色一定晚于 5 号被叫到，所以「手握住持」和「已打出住持」在可到达的
   * 局面里是同一件事；用 chars 判断会让候选目标列表少掉一整名玩家，
   * 等于把「谁拿到住持」这个隐藏信息直接告诉行动者。
   */
  function isAbbotProtected(state, pidx) {
    const p = state.players[pidx];
    if (!(p.played || []).some(c => c === 'abbot')) return false;
    return state.effects.assassinated !== 5 && state.effects.bewitched !== 5;
  }
  function destroyCost(state, tpidx, card) {
    const tp = state.players[tpidx];
    let c = card.cost - 1 + beautifiedExtra(card);
    if (tp.city.some(d => d.uid !== card.uid && d.purple && d.purple.effect === 'wallCost')) c += 1;
    return Math.max(0, c);
  }
  function canTargetDistrict(state, card) {
    return !(card.purple && card.purple.effect === 'immune');
  }

  function destroyChoices(state, t) {
    const me = state.players[t.playerIdx];
    const out = [];
    state.players.forEach((tp, i) => {
      if (i === t.playerIdx) {
        // 允许摧毁自己的建筑
      }
      if (tp.city.length >= state.config.endDistricts) return;   // 已达标不可摧毁
      if (i !== t.playerIdx && isAbbotProtected(state, i)) return;
      tp.city.forEach(card => {
        if (!canTargetDistrict(state, card)) return;
        const cost = destroyCost(state, i, card);
        if (cost > me.gold) return;
        out.push({ type: 'choose_district', target: tp.id, uid: card.uid,
          label: tp.name + ' 的『' + card.name + '』— 花费 ' + cost + ' 金', color: card.color });
      });
    });
    if (out.length === 0) out.push({ type: 'ability_skip', label: '没有可摧毁的目标，放弃使用能力' });
    return out;
  }

  function seizeChoices(state, t) {
    const me = state.players[t.playerIdx];
    const out = [];
    state.players.forEach((tp, i) => {
      if (i === t.playerIdx) return;
      if (tp.city.length >= state.config.endDistricts) return;
      if (isAbbotProtected(state, i)) return;
      tp.city.forEach(card => {
        if (card.cost > 3) return;
        if (!canTargetDistrict(state, card)) return;
        if (me.city.filter(d => d.name === card.name).length >= maxSameName(me)) return;
        if (card.cost > me.gold) return;
        out.push({ type: 'choose_district', target: tp.id, uid: card.uid,
          label: tp.name + ' 的『' + card.name + '』— 支付 ' + card.cost + ' 金', color: card.color });
      });
    });
    if (out.length === 0) out.push({ type: 'ability_skip', label: '没有可抢夺的目标，放弃使用能力' });
    return out;
  }

  function ownDistrictChoices(state, t, onlyUnbeautified, excludeUids) {
    const p = state.players[t.playerIdx];
    const ex = excludeUids || [];
    return p.city.filter(c => (onlyUnbeautified ? !c.beautified : true) && ex.indexOf(c.uid) < 0)
      .map(c => ({
        type: 'choose_district', target: p.id, uid: c.uid,
        label: '『' + c.name + '』（' + c.cost + ' 金）', color: c.color
      }));
  }

  function diplomatTargets(state, t) {
    const pd = t.pending;
    const me = state.players[t.playerIdx];
    const mine = me.city.find(c => c.uid === pd.mineUid);
    const out = [];
    state.players.forEach((tp, i) => {
      if (i === t.playerIdx) return;
      if (isAbbotProtected(state, i)) return;
      tp.city.forEach(card => {
        if (!canTargetDistrict(state, card)) return;
        if (me.city.filter(d => d.name === card.name).length >= maxSameName(me)) return;
        const diff = Math.max(0, card.cost - mine.cost);
        if (diff > me.gold) return;
        out.push({ type: 'choose_district', target: tp.id, uid: card.uid,
          label: tp.name + ' 的『' + card.name + '』' + (diff > 0 ? ' — 补差价 ' + diff + ' 金' : ''),
          color: card.color });
      });
    });
    if (out.length === 0) out.push({ type: 'ability_skip', label: '没有可交换的目标，放弃使用能力' });
    return out;
  }

  /* ============================ 应用行动 ============================ */
  function applyAction(state, playerId, action) {
    repairState(state);
    const idx = playerIdx(state, playerId);
    if (idx < 0) return { ok: false, error: '玩家不存在' };

    if (state.phase === 'gameover') return { ok: false, error: '游戏已结束' };

    if (state.phase === 'draft') return applyDraft(state, idx, action);

    // 墓地响应
    if (state.reaction) {
      if (state.reaction.playerIdx !== idx) return { ok: false, error: '不是你的响应时机' };
      return applyReaction(state, idx, action);
    }

    // 轮末确认：所有玩家都确认后才开始下一轮
    if (state.roundConfirm) {
      if (action.type !== 'confirm_round') return { ok: false, error: '请先确认本轮战果' };
      if (state.roundConfirm.confirmed[idx]) return { ok: false, error: '你已确认过' };
      state.roundConfirm.confirmed[idx] = true;
      log(state, state.players[idx].name + ' 已确认本轮战果。', 'info');
      if (state.roundConfirm.confirmed.every(Boolean)) {
        state.roundConfirm = null;
        startRound(state);
      }
      return ok();
    }

    const t = state.turn;
    if (!t) return { ok: false, error: '当前无可执行的行动' };
    if (t.playerIdx !== idx) return { ok: false, error: '不是你的回合' };

    const p = state.players[idx];
    const c = charOf(t.charId);

    switch (action.type) {
      /* ---------- 资源 ---------- */
      case 'take_gold': {
        if (t.takenResources) return err('本回合已领取资源');
        let amt = 2 + (t.phase === 'witch_resume' ? 0 : c.goldBonus || 0);
        p.gold += amt;
        t.takenResources = true;
        log(state, p.name + '（' + c.name + '）领取 ' + amt + ' 枚金币。', 'info');
        notifyGoldGain(state, idx, amt, null, '领取资源');
        if (t.phase === 'bewitched') return finishBewitchedTurn(state);
        afterResources(state, t, p, c);
        return ok();
      }
      case 'take_cards': {
        if (t.takenResources) return err('本回合已领取资源');
        t.takenResources = true;
        const keepBoth = p.city.some(d => d.purple && d.purple.effect === 'keepBoth');
        const draw3 = !keepBoth && p.city.some(d => d.purple && d.purple.effect === 'draw3keep1');
        // 商人：无论选哪种资源都额外 +1 金
        const gb = (t.phase === 'witch_resume' ? 0 : (c.goldBonus || 0));
        if (gb > 0) {
          p.gold += gb;
          log(state, '【' + c.name + '】' + p.name + ' 额外获得 ' + gb + ' 枚金币。', 'good');
          notifyGoldGain(state, idx, gb, null, '角色加成');
        }
        const n = draw3 ? 3 : 2;
        const drawn = drawCards(state, n);
        if (keepBoth) {
          p.hand = p.hand.concat(drawn);
          notifyHandGain(state, idx, drawn.length, null, '图书馆');
          log(state, p.name + '（' + c.name + '）抽了 2 张建筑牌并全部保留（图书馆）。', 'info');
          if (t.phase === 'bewitched') return finishBewitchedTurn(state);
          afterResources(state, t, p, c);
          return ok();
        }
        if (drawn.length === 0) {
          if (t.phase === 'bewitched') return finishBewitchedTurn(state);
          afterResources(state, t, p, c);
          return ok();
        }
        t.pending = { kind: 'draw_keep', cards: drawn, toBottom: true,
          prompt: '抽取了 ' + drawn.length + ' 张，选择 1 张加入手牌' };
        return ok();
      }
      case 'draw_keep': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'draw_keep') return err('当前无需选择');
        const card = pd.cards.find(x => x.uid === action.uid);
        if (!card) return err('无效的卡牌');
        p.hand.push(card);
        notifyHandGain(state, idx, 1, null, '抽牌保留');
        const rest = pd.cards.filter(x => x.uid !== action.uid);
        if (pd.toBottom) toBottom(state, rest);
        // 抽到的牌属于隐藏信息：战报只公开「抽了几张、留了几张」，不暴露具体牌面。
        log(state, p.name + ' 抽取 ' + pd.cards.length + ' 张建筑牌，保留了 1 张' +
          (pd.toBottom ? '（其余放回牌库底）' : '') + '。', 'info');
        t.pending = null;
        if (t.phase === 'bewitched') return finishBewitchedTurn(state);
        afterResources(state, t, p, c);
        return ok();
      }

      /* ---------- 收入 ---------- */
      case 'income': {
        if (t.incomeTaken) return err('本回合已领取收入');
        const inc = incomeAmount(state, p, t);
        if (!inc) return err('该角色没有收入能力');
        t.incomeTaken = true;
        if (inc.kind === 'cards') {
          const cards = drawCards(state, inc.n);
          p.hand = p.hand.concat(cards);
          notifyHandGain(state, idx, cards.length, null, '主教宗教建筑收入');
          log(state, '【主教】' + p.name + ' 因 ' + inc.n + ' 栋宗教建筑抽取 ' + cards.length + ' 张建筑牌。', 'good');
        } else {
          p.gold += inc.n;
        }
        if (inc.kind !== 'cards' && inc.n > 0) {
          log(state, '【' + c.name + '】' + p.name + ' 因 ' + inc.n + ' 栋' +
            CitCards.COLORS[inc.color].name + '建筑获得 ' + inc.n + ' 枚金币。', 'good');
          notifyGoldGain(state, idx, inc.n, null, '角色收入');
        }
        return ok();
      }
      case 'monk_take': {
        const r = richestOther(state, idx);
        if (r < 0 || state.players[r].gold <= p.gold) return err('没有比你更富有的玩家');
        state.players[r].gold -= 1; p.gold += 1;
        t.monkExtraTaken = true;
        log(state, '【修士】' + p.name + ' 从 ' + state.players[r].name + ' 处拿走 1 枚金币。', 'good');
        notify(state, 'monk_take', {
          fromIdx: r, fromId: state.players[r].id, fromName: state.players[r].name,
          toIdx: idx, toId: p.id, toName: p.name, amount: 1
        });
        return ok();
      }

      /* ---------- 建造 ---------- */
      case 'build': {
        const card = p.hand.find(x => x.uid === action.uid);
        if (!card) return err('手牌中没有这张建筑牌');
        if (card.cost > p.gold && c.id === 'bishop') {
          if (!canBuildIgnoringGold(state, p, card, t)) return err('无法建造该建筑（超出建造限额或已有同名建筑）');
          const amount = card.cost - p.gold;
          if (p.hand.length - 1 < amount || !state.players.some((payer, payerIdx) =>
            payerIdx !== idx && payer.gold >= amount)) return err('没有符合条件的代偿玩家或偿还手牌不足');
          t.pending = { kind: 'bishop_payer', uid: card.uid, amount: amount };
          return ok();
        }
        if (!canBuildCard(state, p, card, t)) return err('无法建造该建筑（金币不足、超出建造限额或已有同名建筑）');

        // 行政官的签名（真）逮捕令：目标第一次付费建造时，先冻结全场，
        // 由行政官决定是否发动——发动则没收该建筑并免费建入自己城市。
        // 无论发动与否，签名逮捕令都只针对这一次建造。
        const w = state.effects.magistrate;
        if (w && !w.claimed && w.signed === t.num && idx !== w.playerIdx) {
          w.claimed = true;
          const magistrate = state.players[w.playerIdx];
          if (!magistrate.city.some(d => d.name === card.name)) {
            state.reaction = {
              kind: 'magistrate',
              playerIdx: w.playerIdx,
              queue: [w.playerIdx],
              build: { uid: card.uid, targetIdx: idx },
              card: { uid: card.uid, name: card.name, cost: card.cost },
              prompt: '【行政官】是否发动逮捕令，没收 ' + p.name + ' 即将建造的『' + card.name + '』？'
            };
            return ok();
          }
        }

        return resolveBuild(state, t, idx, card, -1);
      }

      /* ---------- 紫色建筑能力 ---------- */
      case 'lab': {
        if (t.usedLab) return err('本回合已使用过实验室');
        if (!p.city.some(d => d.uid === action.uid && d.purple && d.purple.effect === 'lab')) return err('你没有实验室');
        if (!action.discardUid) return err('需要指定弃掉的卡牌');
        const hc = p.hand.find(x => x.uid === action.discardUid);
        if (!hc) return err('无效的手牌');
        p.hand = p.hand.filter(x => x.uid !== hc.uid);
        state.discard.push(hc);
        p.gold += 1;
        t.usedLab = true;
        log(state, p.name + ' 使用【实验室】弃掉『' + hc.name + '』获得 1 枚金币。', 'good');
        notifyGoldGain(state, idx, 1, null, '实验室换取金币');
        return ok();
      }
      case 'smithy': {
        if (t.usedSmithy) return err('本回合已使用过铁匠铺');
        if (!p.city.some(d => d.uid === action.uid && d.purple && d.purple.effect === 'smithy')) return err('你没有铁匠铺');
        if (p.gold < 2) return err('金币不足');
        p.gold -= 2;
        const cards = drawCards(state, 3);
        p.hand = p.hand.concat(cards);
        notifyHandGain(state, idx, cards.length, null, '铁匠铺');
        t.usedSmithy = true;
        log(state, p.name + ' 使用【铁匠铺】支付 2 金抽取 3 张建筑牌。', 'good');
        return ok();
      }
      case 'museum': {
        if (t.usedMuseum) return err('本回合已使用过博物馆');
        const mus = p.city.find(d => d.uid === action.uid && d.purple && d.purple.effect === 'museum');
        if (!mus) return err('你没有博物馆');
        if (!action.cardUid) return err('需要指定放入的卡牌');
        const hc = p.hand.find(x => x.uid === action.cardUid);
        if (!hc) return err('无效的手牌');
        p.hand = p.hand.filter(x => x.uid !== hc.uid);
        mus.museum.push(hc);
        t.usedMuseum = true;
        log(state, p.name + ' 将一张建筑牌放入【博物馆】。', 'good');
        return ok();
      }

      /* ---------- 角色能力 ---------- */
      case 'ability': return startAbility(state, idx, t, p, c);
      case 'ability_skip': {
        t.pending = null; t.abilityUsed = true;
        log(state, p.name + ' 放弃使用『' + c.name + '』的能力。', 'info');
        return ok();
      }
      case 'choose_char': {
        const pd = t.pending;
        if (!pd) return err('当前无需选择角色');
        const targetId = (state.charDeck || []).find(id => charOf(id).num === action.num);
        const targetChar = targetId ? charOf(targetId) : null;
        const targetName = targetChar ? targetChar.name : '未知角色';
        const targetText = action.num + ' 号角色『' + targetName + '』';
        if (pd.kind === 'assassin') {
          state.effects.assassinated = action.num;
          t.abilityUsed = true; t.pending = null;
          log(state, '【刺客】' + p.name + ' 宣布刺杀 ' + targetText + '。', 'bad');
          notify(state, 'assassin_declare', {
            num: action.num, charId: targetId || '', charName: targetName,
            byIdx: idx, byId: p.id, byName: p.name
          });
        } else if (pd.kind === 'thief') {
          state.effects.thief = action.num;
          state.effects.thiefBy = idx;
          t.abilityUsed = true; t.pending = null;
          log(state, '【盗贼】' + p.name + ' 宣布偷窃 ' + targetText + '。', 'bad');
          notify(state, 'thief_declare', {
            num: action.num, charId: targetId || '', charName: targetName,
            byIdx: idx, byId: p.id, byName: p.name
          });
        } else if (pd.kind === 'witch_target') {
          state.effects.bewitched = action.num;
          state.effects.witchBy = idx;
          t.abilityUsed = true; t.pending = null;
          log(state, '【女巫】' + p.name + ' 对 ' + action.num + ' 号角色施咒，结束自己的回合。', 'magic');
          notify(state, 'witch_declare', { num: action.num, byIdx: idx, byId: p.id, byName: p.name });
          // 女巫获得皇冠的例外：对国王/贵族施咒不获得皇冠
          return endTurn(state);
        } else return err('无效的选择');
        return ok();
      }
      case 'magistrate_signed': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'magistrate_declare') return err('当前无需选择真逮捕令目标');
        const n = Number(action.num);
        const legalNums = charChoices(state, t, [], 'magistrate_signed').map(a => a.num);
        if (!Number.isFinite(n) || !legalNums.includes(n)) return err('真逮捕令目标无效');
        t.pending = { kind: 'magistrate_second', used: [n], signed: n };
        return ok();
      }
      case 'magistrate_char': {
        const pd = t.pending;
        if (!pd || !['magistrate_second', 'magistrate_third'].includes(pd.kind)) return err('当前无需分配假逮捕令');
        const used = pd.used || [];
        const n = Number(action.num);
        const legalNums = charChoices(state, t, used, 'magistrate_char').map(a => a.num);
        if (!Number.isFinite(n) || !legalNums.includes(n)) return err('假逮捕令目标必须与真逮捕令和其他目标不同');
        const nextUsed = used.concat(n);
        if (nextUsed.length < 3) {
          t.pending = { kind: 'magistrate_third', used: nextUsed, signed: pd.signed };
          return ok();
        }
        state.effects.magistrate = { nums: nextUsed, signed: pd.signed, playerIdx: idx, claimed: false };
        t.abilityUsed = true; t.pending = null;
        // 对外只公开三张逮捕令的目标，不区分哪张为真。
        const targets = nextUsed.map(num => {
          const cid = (state.charDeck || []).find(id => charOf(id).num === num);
          const c = cid ? charOf(cid) : null;
          return { num: num, charId: cid || '', name: c ? c.name : '未知角色' };
        });
        log(state, '【行政官】' + p.name + ' 把 3 张逮捕令发给了 ' +
                   targets.map(x => x.num + ' 号·' + x.name).join('、') + '（其中只有一张是真的）。', 'magic');
        notify(state, 'magistrate_declare', {
          byIdx: idx, byId: p.id, byName: p.name, nums: nextUsed,
          targets: targets.map(x => ({ num: x.num, name: x.name }))
        });
        return ok();
      }
      case 'blackmailer_char': {
        const pd = t.pending;
        const n = Number(action.num);
        if (!pd || !['blackmailer_declare', 'blackmailer_second'].includes(pd.kind)) return err('当前无需分配威胁标记');
        if (!Number.isFinite(n) || n === t.num || (pd.first != null && pd.first === n)) return err('威胁目标必须是两个不同角色');
        // 1 号角色、被刺杀者、被施咒者、已有逮捕令者都不能被放威胁标记
        if (blackmailerBlockedNums(state).indexOf(n) >= 0) {
          return err('不能把威胁标记放在 ' + n + ' 号角色身上（1 号角色 / 被刺杀 / 被施咒 / 已有逮捕令者除外）');
        }
        if (pd.kind === 'blackmailer_declare') { t.pending = { kind: 'blackmailer_second', first: n }; return ok(); }
        // 两个目标都选完后，再让勒索者指定哪一个是真威胁标记（原来这里是随机决定的）
        t.pending = { kind: 'blackmailer_signed', nums: [pd.first, n] };
        return ok();
      }
      case 'blackmailer_signed': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'blackmailer_signed') return err('当前无需指定真威胁标记');
        const nums = pd.nums || [];
        const n = Number(action.num);
        if (!Number.isFinite(n) || nums.indexOf(n) < 0) return err('真威胁标记只能放在已选的两个角色之一');
        return commitBlackmailer(state, idx, t, nums, n);
      }
      case 'spy_target': {
        const pd = t.pending;
        const ti = playerIdx(state, action.target);
        if (!pd || pd.kind !== 'spy_target' || ti < 0 || ti === idx) return err('无效的间谍目标');
        t.pending = { kind: 'spy_color', targetIdx: ti };
        return ok();
      }
      case 'spy_color': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'spy_color' || !['yellow','blue','green','red','purple'].includes(action.color)) return err('无效的调查类型');
        const target = state.players[pd.targetIdx];
        const matching = target.hand.filter(card => card.color === action.color).length;
        const stolen = Math.min(target.gold, matching);
        target.gold -= stolen; p.gold += stolen;
        const cards = drawCards(state, matching); p.hand = p.hand.concat(cards);
        t.abilityUsed = true; t.pending = null;
        log(state, '【间谍】' + p.name + ' 调查了 ' + target.name + ' 的手牌，获得 ' + cards.length + ' 张建筑牌并拿走 ' + stolen + ' 金。', 'magic');
        notify(state, 'spy_result', { byIdx: idx, byId: p.id, byName: p.name, targetIdx: pd.targetIdx, targetId: target.id,
          targetName: target.name, color: action.color, matching, gold: stolen, cards: cards.map(c => c.name) });
        return ok();
      }
      case 'wizard_target': {
        const ti = playerIdx(state, action.target);
        if (!t.pending || t.pending.kind !== 'wizard_target' || ti < 0 || ti === idx) return err('无效的法师目标');
        const cards = state.players[ti].hand.slice();
        // 对方没有手牌时能力无事可做：直接结束，而不是进到「无牌可选」的死状态。
        if (!cards.length) {
          t.pending = null; t.abilityUsed = true;
          log(state, '【法师】' + state.players[ti].name + ' 没有手牌，能力无从发动。', 'info');
          return ok();
        }
        t.pending = { kind: 'wizard_card', targetIdx: ti, cards: cards };
        return ok();
      }
      case 'wizard_card': {
        const pd = t.pending;
        const card = pd && pd.kind === 'wizard_card' && pd.cards.find(c => c.uid === action.uid);
        if (!card) return err('无效的法师卡牌');
        t.pending = { kind: 'wizard_choice', targetIdx: pd.targetIdx, card };
        return ok();
      }
      case 'wizard_take': {
        const pd = t.pending; const target = pd && state.players[pd.targetIdx];
        if (!pd || pd.kind !== 'wizard_choice' || !target) return err('当前无需选择');
        const card = target.hand.find(c => c.uid === pd.card.uid);
        if (!card) return err('该卡牌已不在目标手牌中');
        target.hand = target.hand.filter(c => c.uid !== card.uid); p.hand.push(card);
        notifyHandGain(state, idx, 1, pd.targetIdx, '法师获得手牌');
        t.abilityUsed = true; t.pending = null;
        log(state, '【法师】' + p.name + ' 从 ' + target.name + ' 处取得 1 张建筑牌。', 'magic');
        return ok();
      }
      case 'wizard_build': {
        const pd = t.pending; const target = pd && state.players[pd.targetIdx]; const card = pd && pd.card;
        if (!pd || pd.kind !== 'wizard_choice' || !target || !card) return err('当前无需选择');
        const actual = target.hand.find(c => c.uid === card.uid);
        if (!actual) return err('该卡牌已不在目标手牌中');
        if (p.gold < actual.cost) return err('金币不足');
        p.gold -= actual.cost; t.spentOnBuild += actual.cost;
        target.hand = target.hand.filter(c => c.uid !== actual.uid);
        const built = Object.assign({}, actual, { beautified: 0, builtRound: state.round, museum: [] });
        p.city.push(built);
        const taxCollector = state.players.findIndex(player => player.chars.some(cid => cid === 'tax_collector'));
        if (state.charDeck.some(cid => cid === 'tax_collector') && idx !== taxCollector && p.gold > 0) {
          p.gold--; state.effects.taxCollectorGold = (state.effects.taxCollectorGold || 0) + 1;
          notify(state, 'tax_paid', { playerIdx: idx, playerId: p.id, playerName: p.name, amount: 1 });
        }
        if (p.city.length >= state.config.endDistricts && state.firstToFinish < 0) state.firstToFinish = idx;
        t.abilityUsed = true; t.pending = null;
        log(state, '【法师】' + p.name + ' 从 ' + target.name + ' 处取牌并立即建造了『' + actual.name + '』。', 'build');
        return ok();
      }
      case 'blackmailer_bribe': {
        const pd = t.pending; if (!pd || pd.kind !== 'blackmailer_threat') return err('当前没有勒索威胁');
        const bth = state.effects.blackmailer;
        if (!bth) return err('当前没有生效的威胁标记');
        const amount = Math.floor(p.gold / 2); p.gold -= amount;
        bth.nums = bth.nums.filter(n => n !== t.num);
        t.pending = null; t.takenResources = false;
        log(state, '【勒索者】' + p.name + ' 支付 ' + amount + ' 金赎回威胁。', 'magic');
        return ok();
      }
      case 'blackmailer_refuse': {
        const pd = t.pending; if (!pd || pd.kind !== 'blackmailer_threat') return err('当前没有勒索威胁');
        const threat = state.effects.blackmailer;
        if (!threat) return err('当前没有生效的威胁标记');
        const ownerIdx = threat.playerIdx;
        // 勒索者和目标恰好是同一个人时（理论上不会发生），直接当作放弃翻开，避免自锁
        if (ownerIdx === idx) {
          threat.done = (threat.done || []).concat([t.num]);
          t.pending = null; t.takenResources = false;
          log(state, '【勒索者】' + p.name + ' 放弃使用威胁标记。', 'magic');
          return ok();
        }
        const owner = state.players[ownerIdx];
        // 不当场揭示：冻结目标，把「翻不翻开」的决定权交给勒索者
        t.pending = null;
        state.reaction = { kind: 'blackmailer', playerIdx: ownerIdx, targetIdx: idx, num: t.num,
          prompt: '【勒索者】是否翻开 ' + p.name + ' 的威胁标记？' };
        log(state, '【勒索者】' + p.name + ' 拒绝支付赎金，等待 ' + owner.name + ' 决定是否翻开威胁标记。', 'magic');
        notify(state, 'blackmailer_wait', { playerIdx: idx, playerId: p.id, playerName: p.name,
          byIdx: ownerIdx, byId: owner.id, byName: owner.name, num: t.num });
        return ok();
      }
      case 'abbot_resource': {
        const pd = t.pending; const n = countColorForIncome(p, 'blue', 'blue');
        if (!pd || pd.kind !== 'abbot_declare' || action.gold + action.cards !== n) return err('资源组合不正确');
        p.gold += action.gold;
        notifyGoldGain(state, idx, action.gold, null, '住持资源');
        const cards = drawCards(state, action.cards);
        p.hand = p.hand.concat(cards);
        notifyHandGain(state, idx, cards.length, null, '住持资源');
        t.incomeTaken = true; t.abilityUsed = true; t.pending = null;
        const richest = richestOther(state, idx);
        if (richest >= 0 && !state.players.some((o, i) => i !== idx && o.gold === state.players[richest].gold && i !== richest)) {
          if (state.players[richest].gold > p.gold) {
            state.players[richest].gold--; p.gold++;
            notifyGoldGain(state, idx, 1, richest, '住持向最富有者索取');
          }
        }
        log(state, '【住持】' + p.name + ' 领取 ' + action.gold + ' 金 + ' + action.cards + ' 张建筑牌。', 'good');
        return ok();
      }
      case 'tax_collect': {
        if (!t.pending || t.pending.kind !== 'tax_collect') return err('当前无需收税');
        const amount = state.effects.taxCollectorGold || 0; p.gold += amount; state.effects.taxCollectorGold = 0;
        if (amount > 0) notify(state, 'tax_collected', {
          playerIdx: idx, playerId: p.id, playerName: p.name, amount: amount
        });
        t.abilityUsed = true; t.pending = null;
        log(state, '【税务官】' + p.name + ' 收取了 ' + amount + ' 枚建筑税。', 'good');
        return ok();
      }
      case 'magician_mode': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'magician_choice') return err('当前无需选择');
        if (action.mode === 'swap') {
          if (otherPlayers(state, idx).length === 0) { t.pending = null; t.abilityUsed = true; return ok(); }
          t.pending = { kind: 'magician_swap' };
        } else {
          t.pending = { kind: 'magician_redraw', selected: [] };
        }
        return ok();
      }
      case 'choose_player': {
        const pd = t.pending;
        if (pd && pd.kind === 'bishop_payer') {
          const payerIdx = playerIdx(state, action.target);
          if (payerIdx < 0 || payerIdx === idx || state.players[payerIdx].gold < pd.amount) return err('无效的代偿玩家');
          const card = p.hand.find(x => x.uid === pd.uid);
          if (!card || !canBuildIgnoringGold(state, p, card, t)) return err('建筑状态已改变，无法继续代偿建造');
          t.pending = { kind: 'bishop_repay', uid: pd.uid, payerIdx: payerIdx,
            targetIdx: payerIdx, amount: pd.amount };
          return ok();
        }
        if (!pd || pd.kind !== 'magician_swap') return err('当前无需选择玩家');
        const ti = playerIdx(state, action.target);
        if (ti < 0 || ti === idx) return err('无效的目标玩家');
        const a = p.hand, b = state.players[ti].hand;
        p.hand = b; state.players[ti].hand = a;
        t.abilityUsed = true; t.pending = null;
        log(state, '【魔术师】' + p.name + ' 与 ' + state.players[ti].name + ' 交换了全部手牌。', 'magic');
        notify(state, 'magician_swap', {
          byIdx: idx, byId: p.id, byName: p.name,
          playerIdx: ti, playerId: state.players[ti].id, playerName: state.players[ti].name
        });
        return ok();
      }
      case 'choose_cards': {
        const pd = t.pending;
        if (pd && pd.kind === 'bishop_repay') {
          const uids = action.uids || [];
          if (uids.length !== pd.amount || new Set(uids).size !== uids.length) return err('必须选择恰好 ' + pd.amount + ' 张手牌');
          const card = p.hand.find(x => x.uid === pd.uid);
          const payer = state.players[pd.payerIdx];
          if (!card || !payer || payer.gold < pd.amount || uids.some(uid => uid === pd.uid || !p.hand.some(x => x.uid === uid)))
            return err('建筑、代付玩家或偿还手牌状态已改变');
          const repaid = uids.map(uid => p.hand.find(x => x.uid === uid));
        payer.gold -= pd.amount;
        p.gold += pd.amount;
        notifyGoldGain(state, idx, pd.amount, pd.payerIdx, '主教代付');
          p.hand = p.hand.filter(x => !uids.includes(x.uid));
          payer.hand.push(...repaid);
          t.pending = null;
          log(state, '【主教】' + p.name + ' 请 ' + payer.name + ' 代付 ' + pd.amount + ' 金，并交给对方 ' + pd.amount + ' 张手牌。', 'good');
          notifyHandGain(state, pd.payerIdx, repaid.length, idx, '主教偿还代付');
          const warrant = state.effects.magistrate;
          if (warrant && !warrant.claimed && warrant.signed === t.num && idx !== warrant.playerIdx) {
            warrant.claimed = true;
            const magistrate = state.players[warrant.playerIdx];
            if (!magistrate.city.some(d => d.name === card.name)) {
              state.reaction = { kind: 'magistrate', playerIdx: warrant.playerIdx,
                queue: [warrant.playerIdx], build: { uid: card.uid, targetIdx: idx },
                card: { uid: card.uid, name: card.name, cost: card.cost },
                prompt: '【行政官】是否发动逮捕令，没收 ' + p.name + ' 即将建造的『' + card.name + '』？' };
              return ok();
            }
          }
          return resolveBuild(state, t, idx, card, -1);
        }
        if (!pd || pd.kind !== 'magician_redraw') return err('当前无需选择卡牌');
        const uids = action.uids || [];
        const dropped = [];
        uids.forEach(u => {
          const i = p.hand.findIndex(x => x.uid === u);
          if (i >= 0) dropped.push(p.hand.splice(i, 1)[0]);
        });
        toBottom(state, dropped);
        const fresh = drawCards(state, dropped.length);
        p.hand = p.hand.concat(fresh);
        notifyHandGain(state, idx, fresh.length, null, '魔术师重抽');
        t.abilityUsed = true; t.pending = null;
        log(state, '【魔术师】' + p.name + ' 弃掉 ' + dropped.length + ' 张并重抽 ' + fresh.length + ' 张。', 'magic');
        return ok();
      }
      case 'choose_district': {
        const pd = t.pending;
        if (!pd) return err('当前无需选择建筑');
        if (pd.kind === 'warlord_destroy') return doDestroy(state, t, idx, action);
        if (pd.kind === 'marshal_seize') return doSeize(state, t, idx, action);
        if (pd.kind === 'diplomat_mine') {
          const card = p.city.find(x => x.uid === action.uid);
          if (!card) return err('无效的建筑');
          if (card.purple && card.purple.effect === 'immune') return err('堡垒不可被交换');
          t.pending = { kind: 'diplomat_theirs', mineUid: action.uid };
          return ok();
        }
        if (pd.kind === 'diplomat_theirs') return doDiplomatSwap(state, t, idx, action);
        if (pd.kind === 'artist') {
          const card = p.city.find(x => x.uid === action.uid);
          if (!card) return err('无效的建筑');
          pd.selected = pd.selected || [];
          if (pd.selected.indexOf(action.uid) >= 0) return err('该建筑已被选择');
          if (pd.selected.length >= 2) return err('最多美化 2 栋');
          // 每栋 1 金：已选 N 栋就要 N 金，选第 N+1 栋前必须还剩 1 金
          if (p.gold <= pd.selected.length) return err('金币不足');
          pd.selected.push(action.uid);
          return ok();
        }
        return err('无效的选择');
      }
      case 'artist_done': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'artist') return err('当前无需确认');
        const uids = action.uids || [];
        if (uids.length > 2) return err('最多 2 栋');
        if (p.gold < uids.length) return err('金币不足');
        uids.forEach(u => {
          const card = p.city.find(x => x.uid === u);
          if (card) { card.beautified = 1; p.gold -= 1; }
        });
        t.abilityUsed = true; t.pending = null;
        log(state, '【艺术家】' + p.name + ' 美化了 ' + uids.length + ' 栋建筑（各 +1 分）。', 'good');
        return ok();
      }
      case 'navigator_bonus': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'navigator_bonus') return err('当前无需选择');
        if (action.mode === 'gold') {
          p.gold += 4;
          log(state, '【航海家】' + p.name + ' 额外获得 4 枚金币。', 'good');
          notify(state, 'navigator_bonus', { playerIdx: idx, playerId: p.id, playerName: p.name,
            mode: 'gold', amount: 4 });
        } else if (action.mode === 'cards') {
          const cards = drawCards(state, 4);
          p.hand = p.hand.concat(cards);
          log(state, '【航海家】' + p.name + ' 额外抽取 4 张建筑牌。', 'good');
          notify(state, 'navigator_bonus', { playerIdx: idx, playerId: p.id, playerName: p.name,
            mode: 'cards', amount: cards.length });
        } else return err('无效的航海家奖励');
        t.bonusDone = true; t.abilityUsed = true; t.pending = null;
        return ok();
      }
      case 'scholar_pick': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'scholar_pick') return err('当前无需选择');
        const card = (pd.cards || []).find(x => x.uid === action.uid);
        if (!card) return err('无效的卡牌');
        p.hand.push(card);
        notifyHandGain(state, idx, 1, null, '学者选牌');
        const rest = (pd.cards || []).filter(x => x.uid !== action.uid);
        rest.forEach(r => state.deck.push(r));
        state.deck = CitCards.shuffle(state.deck, () => nextRand(state));
        t.abilityUsed = true; t.pending = null;
        // 同上：学者选牌也是隐藏信息，不公开具体牌面。
        log(state, '【学者】' + p.name + ' 从 ' + pd.cards.length + ' 张建筑牌中选择了 1 张，其余洗回牌堆。', 'good');
        return ok();
      }
      case 'monk_resource': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'monk_declare') return err('当前无需宣告');
        const n = countColorForIncome(p, 'blue', 'blue');
        if (action.gold + action.cards !== n) return err('资源组合不正确');
        p.gold += action.gold;
        const cards = drawCards(state, action.cards);
        p.hand = p.hand.concat(cards);
        notifyHandGain(state, idx, cards.length, null, '修士资源');
        notifyGoldGain(state, idx, action.gold, null, '修士资源');
        t.incomeTaken = true; t.pending = null;
        log(state, '【修士】' + p.name + ' 领取 ' + action.gold + ' 金 + ' + action.cards + ' 张建筑牌。', 'good');
        return ok();
      }
      case 'emperor_crown': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'emperor_crown') return err('当前无需选择');
        const ti = playerIdx(state, action.target);
        if (ti < 0 || ti === idx) return err('无效的目标玩家');
        const fromIdx = crownIdx(state);
        const fromPlayer = fromIdx >= 0 ? state.players[fromIdx] : null;
        setCrown(state, ti);
        notify(state, 'crown_transfer', {
          fromIdx: fromIdx, fromId: fromPlayer && fromPlayer.id, fromName: fromPlayer && fromPlayer.name,
          toIdx: ti, toId: state.players[ti].id, toName: state.players[ti].name
        });
        // 记下皇冠原持有者，供「返回上一步」时还回去
        t.pending = { kind: 'emperor_take', targetIdx: ti, _fromCrownIdx: fromIdx };
        return ok();
      }
      case 'emperor_take': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'emperor_take') return err('当前无需选择');
        const tp = state.players[pd.targetIdx];
        if (action.mode === 'gold') {
          const amt = Math.min(1, tp.gold);
          tp.gold -= amt; p.gold += amt;
          log(state, '【皇帝】' + p.name + ' 从 ' + tp.name + ' 处拿取 ' + amt + ' 枚金币。', 'good');
          if (amt > 0) notify(state, 'emperor_gold', {
            fromIdx: pd.targetIdx, fromId: tp.id, fromName: tp.name,
            toIdx: idx, toId: p.id, toName: p.name, amount: amt
          });
        } else {
          if (tp.hand.length > 0) {
            const i = randInt(state, tp.hand.length);
            const card = tp.hand.splice(i, 1)[0];
            p.hand.push(card);
            log(state, '【皇帝】' + p.name + ' 从 ' + tp.name + ' 处随机拿取 1 张手牌。', 'good');
            notify(state, 'emperor_card', {
              fromIdx: pd.targetIdx, fromId: tp.id, fromName: tp.name,
              toIdx: idx, toId: p.id, toName: p.name, amount: 1
            });
          } else {
            log(state, '【皇帝】' + tp.name + ' 没有手牌可拿。', 'info');
          }
        }
        t.abilityUsed = true; t.pending = null;
        return ok();
      }
      case 'prophet_give': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'prophet_give') return err('当前无需选择');
        const card = p.hand.find(x => x.uid === action.uid);
        if (!card) return err('无效的手牌');
        p.hand = p.hand.filter(x => x.uid !== card.uid);
        state.players[pd.targetIdx].hand.push(card);
        log(state, '【预言家】' + p.name + ' 还给 ' + state.players[pd.targetIdx].name + ' 一张建筑牌。', 'magic');
        // 归还同样是一次「手牌易主」，和抽取阶段一样上报，客户端据此播放牌背飞行动画。
        notifyHandGain(state, pd.targetIdx, 1, idx, '预言家归还手牌');
        const rest = (pd.queue || []).slice();
        rest.shift();
        if (rest.length > 0) {
          t.pending = { kind: 'prophet_give', targetIdx: rest[0], queue: rest };
        } else {
          t.abilityUsed = true; t.pending = null;
        }
        return ok();
      }
      case 'reaction': return err('请使用响应接口');

      /* ---------- 退回上一步（仅限安全子步骤） ---------- */
      case 'pending_back': {
        const pd = t.pending;
        if (!pd) return err('当前没有可退回的选择');
        const target = action.to;
        if (!target) return err('此步骤不能退回');
        // 1) 魔术师：swap / redraw → 退回 choice（无副作用，弃牌还没真丢）
        if ((pd.kind === 'magician_swap' || pd.kind === 'magician_redraw') && target === 'magician_choice') {
          t.pending = { kind: 'magician_choice' };
          log(state, p.name + ' 退回到【魔术师】能力选择。', 'info');
          return ok();
        }
        // 2) 法师：已选定牌但尚未取得/建造，重新展示目标玩家当前手牌。
        // 不复用旧的 cards 快照，避免目标手牌在状态修复后与选择列表不一致。
        if (pd.kind === 'wizard_choice' && target === 'wizard_card') {
          const targetPlayer = state.players[pd.targetIdx];
          if (!targetPlayer || !targetPlayer.hand.length) return err('目标玩家已经没有手牌');
          t.pending = { kind: 'wizard_card', targetIdx: pd.targetIdx, cards: targetPlayer.hand.slice() };
          log(state, p.name + ' 退回到【法师】重新选择目标手牌。', 'info');
          return ok();
        }
        // 3) 外交官：theirs → 退回 mine（无副作用，还未真正交换）
        if (pd.kind === 'diplomat_theirs' && target === 'diplomat_mine') {
          t.pending = { kind: 'diplomat_mine' };
          log(state, p.name + ' 退回到【外交官】选择要交出的建筑。', 'info');
          return ok();
        }
        // 4) 皇帝：take → 退回 crown（必须把皇冠还给原持有者）
        if (pd.kind === 'emperor_take' && target === 'emperor_crown') {
          const prev = pd._fromCrownIdx;
          if (prev == null || prev < 0 || prev >= state.players.length) {
            // 没记录原持有者（例如旧存档/老回合遗留）就降级：直接退回步骤但不还皇冠
            log(state, p.name + ' 退回到【皇帝】选择皇冠对象（无法定位原皇冠持有者）。', 'info');
          } else {
            setCrown(state, prev);
            log(state, '【皇帝】' + p.name + ' 收回皇冠，转回 ' + state.players[prev].name + '。', 'info');
          }
          t.pending = { kind: 'emperor_crown' };
          return ok();
        }
        return err('此步骤不能退回');
      }

      /* ---------- 结束回合 ---------- */
      case 'end_turn': {
        if (t.pending) return err('请先完成当前选择');
        return endTurn(state);
      }
    }
    return err('未知的行动：' + action.type);
  }

  function ok() { return { ok: true }; }
  function err(msg) { return { ok: false, error: msg }; }

  /* ---------------------- 领取资源后的后续处理 ---------------------- */
  function afterResources(state, t, p, c) {
    if (c.drawBonus && !t.bonusDone && t.phase !== 'witch_resume') {
      const cards = drawCards(state, c.drawBonus);
      p.hand = p.hand.concat(cards);
      notifyHandGain(state, t.playerIdx, cards.length, null, c.name + '额外抽牌');
      t.bonusDone = true;
      log(state, '【' + c.name + '】' + p.name + ' 额外抽取 ' + c.drawBonus + ' 张建筑牌。', 'good');
    }
    if (c.id === 'navigator' && !t.bonusDone && t.phase !== 'witch_resume') {
      t.pending = { kind: 'navigator_bonus' };
      return;
    }
    if (c.id === 'scholar' && !t.abilityUsed && t.phase !== 'witch_resume') {
      startAbility(state, t.playerIdx, t, p, c);
      return;
    }
    // 女巫：领取资源后必须施咒
    if (c.id === 'witch' && t.phase !== 'witch_resume' && !t.abilityUsed) {
      t.pending = { kind: 'witch_target' };
      return;
    }
    // 修士：领取资源后宣告
    if (c.id === 'monk' && !t.incomeTaken && t.phase !== 'witch_resume') {
      t.pending = { kind: 'monk_declare' };
      return;
    }
    if (c.id === 'prophet' && !t.abilityUsed && t.phase !== 'witch_resume') {
      startAbility(state, t.playerIdx, t, p, c);
    }
  }

  function startAbility(state, idx, t, p, c) {
    if (t.abilityUsed) return err('本回合已使用过能力');
    if (c.id === 'navigator' && t.bonusDone) return err('本回合已领取过航海家奖励');
    if (c.id === 'diplomat' && p.city.length === 0) return err('你还没有建筑，无法使用外交官能力');
    switch (c.id) {
      case 'assassin': t.pending = { kind: 'assassin' }; break;
      case 'thief': t.pending = { kind: 'thief' }; break;
      case 'witch': t.pending = { kind: 'witch_target' }; break;
      case 'magistrate': t.pending = { kind: 'magistrate_declare', used: [] }; break;
      case 'blackmailer': {
        // 合法目标不足时不必走两步选择：0 个直接作废，1 个直接放下唯一的真标记
        const valid = blackmailerValidNums(state, t, []);
        if (valid.length === 0) {
          t.abilityUsed = true;
          log(state, '【勒索者】没有可以放置威胁标记的目标，能力作废。', 'info');
          return ok();
        }
        if (valid.length === 1) return commitBlackmailer(state, idx, t, [valid[0]], valid[0]);
        t.pending = { kind: 'blackmailer_declare' };
        break;
      }
      case 'spy': t.pending = { kind: 'spy_target' }; break;
      case 'magician': t.pending = { kind: 'magician_choice' }; break;
      case 'wizard': t.pending = { kind: 'wizard_target' }; break;
      case 'warlord': t.pending = { kind: 'warlord_destroy' }; break;
      case 'marshal': t.pending = { kind: 'marshal_seize' }; break;
      case 'diplomat': t.pending = { kind: 'diplomat_mine' }; break;
      case 'artist': t.pending = { kind: 'artist', selected: [] }; break;
      case 'emperor': t.pending = { kind: 'emperor_crown' }; break;
      case 'tax_collector': t.pending = { kind: 'tax_collect' }; break;
      case 'navigator': t.pending = { kind: 'navigator_bonus' }; break;
      case 'scholar': {
        const cards = drawCards(state, 7);
        if (!cards.length) { t.abilityUsed = true; return ok(); }
        t.pending = { kind: 'scholar_pick', cards: cards };
        break;
      }
      case 'prophet': {
        const queue = [];
        state.players.forEach((tp, i) => {
          if (i === idx) return;
          if (tp.hand.length === 0) return;
          const j = randInt(state, tp.hand.length);
          const card = tp.hand.splice(j, 1)[0];
          p.hand.push(card);
          notifyHandGain(state, idx, 1, i, '预言家抽取手牌');
          queue.push(i);
        });
        log(state, '【预言家】' + p.name + ' 从 ' + queue.length + ' 位对手处各抽走 1 张建筑牌。', 'magic');
        if (queue.length === 0) { t.abilityUsed = true; return ok(); }
        t.pending = { kind: 'prophet_give', targetIdx: queue[0], queue: queue };
        break;
      }
      default: return err('该角色没有需要主动发动的能力');
    }
    return ok();
  }

  /* ------------------------------ 摧毁 ------------------------------ */
  function doDestroy(state, t, idx, action) {
    const me = state.players[idx];
    const ti = playerIdx(state, action.target);
    if (ti < 0) return err('无效的目标');
    const tp = state.players[ti];
    const card = tp.city.find(x => x.uid === action.uid);
    if (!card) return err('无效的建筑');
    if (tp.city.length >= state.config.endDistricts) return err('该玩家已达标，不可摧毁');
    if (ti !== idx && isAbbotProtected(state, ti)) return err('该玩家的城市受到角色保护，不受8号角色能力影响');
    if (!canTargetDistrict(state, card)) return err('堡垒不可摧毁');
    const cost = destroyCost(state, ti, card);
    if (cost > me.gold) return err('金币不足，摧毁需 ' + cost + ' 金');

    me.gold -= cost;
    tp.city = tp.city.filter(x => x.uid !== card.uid);
    detachMuseum(state, card);
    t.abilityUsed = true; t.pending = null;
    log(state, '【领主】' + me.name + ' 支付 ' + cost + ' 金摧毁了 ' + tp.name + ' 的『' + card.name + '』。', 'bad');
    notify(state, 'destroyed', {
      playerIdx: ti, playerId: tp.id, playerName: tp.name,
      byName: me.name, cardName: card.name, cost: cost, uid: card.uid
    });

    // 墓地响应
    const gy = [];
    state.players.forEach((gp, i) => {
      if (i === idx) return;
      if (gp.city.some(d => d.purple && d.purple.effect === 'graveyard') && gp.gold >= 1) gy.push(i);
    });
    if (gy.length) {
      state.reaction = { kind: 'graveyard', playerIdx: gy[0], queue: gy, card: card, sourceIdx: ti, prompt: '' };
      state.reaction.prompt = '【墓地】是否支付 1 金将『' + card.name + '』收入手牌？';
      state.pendingDestroy = { card: card };
      return ok();
    }
    state.discard.push(card);
    return ok();
  }

  // 行政官的逮捕令响应：先解冻，再按是否发动完成目标那一手建造
  function applyMagistrateWarrant(state, idx, use) {
    const r = state.reaction;
    const t = state.turn;
    const ti = r.build.targetIdx;
    const target = state.players[ti];
    const card = target.hand.find(x => x.uid === r.build.uid);
    state.reaction = null;
    if (!t || t.playerIdx !== ti) return err('当前不是该玩家的建造时机');
    if (!card) return err('待建造的建筑已不在手牌');
    const magistrate = state.players[idx];
    const canTake = use && !magistrate.city.some(d => d.name === card.name);
    return resolveBuild(state, t, ti, card, canTake ? idx : -1);
  }

  // 勒索者的威胁标记响应：use=true 翻开盖牌（真的拿走全部金币，假的什么事都没有），
  // use=false 直接跳过。无论哪种都要把目标解冻，让他继续正常的领资源 / 建造。
  function applyBlackmailerReveal(state, idx, use) {
    const r = state.reaction;
    const t = state.turn;
    const ti = r.targetIdx;
    const target = state.players[ti];
    const owner = state.players[idx];
    const threat = state.effects.blackmailer;
    const num = r.num;
    state.reaction = null;
    if (!t || t.playerIdx !== ti) return err('当前不是该玩家的回合');
    t.pending = null;
    t.takenResources = false;               // 解冻后照常领取资源
    if (!threat) return ok();
    const isReal = threat.signed === num;
    threat.done = (threat.done || []).concat([num]);
    if (!use) {
      log(state, '【勒索者】' + owner.name + ' 选择不翻开，' + target.name + ' 的威胁标记本轮作废。', 'magic');
      notify(state, 'blackmailer_reveal', {
        playerIdx: ti, playerId: target.id, playerName: target.name,
        byIdx: idx, byId: owner.id, byName: owner.name,
        revealed: false, isReal: false, amount: 0
      });
      return ok();
    }
    threat.revealed = (threat.revealed || []).concat([{ num: num, isReal: isReal }]);
    let amount = 0;
    if (isReal) {
      amount = target.gold;
      target.gold = 0;
      owner.gold += amount;
      log(state, '【勒索者】翻开威胁标记：『带血的刀』——' + owner.name +
                 ' 拿走 ' + target.name + ' 的全部 ' + amount + ' 枚金币。', 'bad');
    } else {
      log(state, '【勒索者】翻开威胁标记：『玫瑰花』——虚惊一场，' + target.name + ' 分文未失。', 'good');
    }
    notify(state, 'blackmailer_reveal', {
      playerIdx: ti, playerId: target.id, playerName: target.name,
      byIdx: idx, byId: owner.id, byName: owner.name,
      // fromIdx/toIdx 供客户端播放「全部金币被勒索者拿走」的飞行动画
      fromIdx: amount > 0 ? ti : null, toIdx: amount > 0 ? idx : null,
      revealed: true, isReal: isReal, amount: amount
    });
    return ok();
  }

  function applyReaction(state, idx, action) {
    const r = state.reaction;
    const p = state.players[idx];
    if (action.type !== 'reaction') return err('无效的响应');
    if (r.kind === 'magistrate') return applyMagistrateWarrant(state, idx, !!action.use);
    if (r.kind === 'blackmailer') return applyBlackmailerReveal(state, idx, !!action.use);
    const card = state.pendingDestroy ? state.pendingDestroy.card : r.card;
    if (action.use) {
      if (p.gold < 1) return err('金币不足');
      p.gold -= 1;
      // 该牌已随摧毁从原城市移除；附着其上的博物馆牌在 doDestroy 里已收回弃牌堆。
      p.hand.push(card);
      notifyHandGain(state, idx, 1, r.sourceIdx, '墓地收回建筑');
      log(state, '【墓地】' + p.name + ' 支付 1 金将『' + card.name + '』收入手牌。', 'good');
      r.queue = [];
      state.reaction = null; state.pendingDestroy = null;
      return ok();
    }
    r.queue.shift();
    if (r.queue.length > 0) {
      state.reaction.playerIdx = r.queue[0];
      return ok();
    }
    state.reaction = null;
    state.discard.push(state.pendingDestroy ? state.pendingDestroy.card : card);
    state.pendingDestroy = null;
    log(state, '『' + card.name + '』被放入弃牌堆。', 'info');
    return ok();
  }

  /* ------------------------------ 抢夺 ------------------------------ */
  function doSeize(state, t, idx, action) {
    const me = state.players[idx];
    const ti = playerIdx(state, action.target);
    if (ti < 0) return err('无效的目标');
    const tp = state.players[ti];
    if (isAbbotProtected(state, ti)) return err('该玩家的城市受到角色保护，不受8号角色能力影响');
    const card = tp.city.find(x => x.uid === action.uid);
    if (!card) return err('无效的建筑');
    if (card.cost > 3) return err('只能抢夺费用 3 以下的建筑');
    if (tp.city.length >= state.config.endDistricts) return err('该玩家已达标，不可抢夺');
    if (!canTargetDistrict(state, card)) return err('堡垒不可抢夺');
    if (me.city.filter(d => d.name === card.name).length >= maxSameName(me)) return err('你已有同名建筑');
    if (card.cost > me.gold) return err('金币不足');
    me.gold -= card.cost;
    tp.gold += card.cost;
    notifyGoldGain(state, ti, card.cost, idx, '元帅抢夺付款');
    tp.city = tp.city.filter(x => x.uid !== card.uid);
    detachMuseum(state, card);
    me.city.push(card);
    t.abilityUsed = true; t.pending = null;
    log(state, '【元帅】' + me.name + ' 支付 ' + card.cost + ' 金给 ' + tp.name +
      '，抢夺了『' + card.name + '』。', 'bad');
    notify(state, 'seized', {
      playerIdx: ti, playerId: tp.id, playerName: tp.name,
      byName: me.name, cardName: card.name, cost: card.cost
    });
    return ok();
  }

  /* ---------------------------- 外交官交换 ---------------------------- */
  function doDiplomatSwap(state, t, idx, action) {
    const me = state.players[idx];
    const pd = t.pending;
    const mine = me.city.find(x => x.uid === pd.mineUid);
    const ti = playerIdx(state, action.target);
    if (ti < 0 || ti === idx) return err('无效的目标');
    const tp = state.players[ti];
    if (isAbbotProtected(state, ti)) return err('该玩家的城市受到角色保护，不受8号角色能力影响');
    const theirs = tp.city.find(x => x.uid === action.uid);
    if (!theirs) return err('无效的建筑');
    if (!canTargetDistrict(state, theirs)) return err('堡垒不可交换');
    if (me.city.filter(d => d.name === theirs.name).length >= maxSameName(me)) return err('你已有同名建筑');
    const diff = Math.max(0, theirs.cost - mine.cost);
    if (diff > me.gold) return err('金币不足，需补差价 ' + diff + ' 金');
    me.gold -= diff;
    tp.gold += diff;
    if (diff > 0) notifyGoldGain(state, ti, diff, idx, '外交官补差价');
    tp.city = tp.city.filter(x => x.uid !== theirs.uid);
    me.city = me.city.filter(x => x.uid !== mine.uid);
    detachMuseum(state, theirs);
    detachMuseum(state, mine);
    me.city.push(theirs);
    tp.city.push(mine);
    t.abilityUsed = true; t.pending = null;
    log(state, '【外交官】' + me.name + ' 用『' + mine.name + '』换来了 ' + tp.name +
      ' 的『' + theirs.name + '』' + (diff > 0 ? '，补差价 ' + diff + ' 金' : '') + '。', 'bad');
    notify(state, 'swapped', {
      byIdx: idx, byId: me.id, byName: me.name,
      playerIdx: ti, playerId: tp.id, playerName: tp.name,
      cardName: theirs.name, gotName: mine.name, cost: diff,
      // 建筑本身是公开信息，带上卡牌资料用于客户端播放两张牌的交换动画。
      mineCard: { uid: mine.uid, name: mine.name, en: mine.en, desc: mine.desc,
        color: mine.color, cost: mine.cost, scoreValue: mine.scoreValue },
      theirsCard: { uid: theirs.uid, name: theirs.name, en: theirs.en, desc: theirs.desc,
        color: theirs.color, cost: theirs.cost, scoreValue: theirs.scoreValue }
    });
    return ok();
  }

  /* -------------------------- 施咒回合结束 -------------------------- */
  function finishBewitchedTurn(state) {
    const t = state.turn;
    const witchIdx = state.effects.witchBy;
    if (witchIdx == null) { state.callIdx++; return beginNextCall(state); }
    const entry = state.callQueue[state.callIdx];
    const c = charOf(entry.charId);
    state.turn = {
      charId: entry.charId, num: entry.num, playerIdx: witchIdx,
      phase: 'witch_resume',
      takenResources: true, incomeTaken: false, abilityUsed: false,
      builds: 0, spentOnBuild: 0,
      usedLab: false, usedSmithy: false, usedMuseum: false,
      // 航海家的额外奖励属于资源选择后的剩余行动，女巫接管后仍应可领取。
      // 其他角色没有这个待领取奖励，保持已处理状态，避免错误地重复触发被动收益。
      pending: null, bonusDone: c.id !== 'navigator'
    };
    // 皇冠与贵族抽牌已在叫号瞬间结算给角色持有者（applyNum4TurnStart），
    // 这里不重复发放 —— 女巫接管的是剩余行动，不是已经落定的被动收益。
    log(state, '【女巫】' + state.players[witchIdx].name + ' 接管『' + c.name + '』的剩余行动。', 'magic');
    return ok();
  }

  /* ---------------------------- 回合结束 ---------------------------- */
  /**
   * 信念观测账本：把每位玩家「回合结束时公开可见的事实」记下来，供搜索的信念层
   * （training/belief.js）给对手手牌的猜测加权。
   *
   * 记的是这条人类天天在用、而均匀采样完全丢弃的推理：一个玩家手上还有钱、建造
   * 次数也没用完，却选择不建造 —— 那他手里就没有他买得起的牌。这是从「他没做的
   * 事」反推出来的信息，比任何先验都强。反过来说，下面几种情况这句话不成立，
   * 必须排除，否则会把真世界判成不可能、信念反而变差：
   *   - 航海家：本回合根本不能建造，不建不代表任何事；
   *   - 主教：可以忽略金币建造，没钱也能建，推不出「手里没有便宜牌」；
   *   - 建造次数已用完（普通角色建满 1 栋）：不能再建了，同样推不出；
   *   - 女巫接管（witch_resume）：花的是女巫的钱、进女巫的城区，账记不到角色
   *     持有者头上。
   * 金币取「建造结算后、回合末补贴（炼金术士回收）之前」的数目 —— 那才是他做
   * 建造决策时真正面对的预算，所以本函数必须在退款之前调用。
   *
   * 只写公开量（金币 / 手牌张数 / 建造次数 / 角色），不含任何牌面，因此即使随
   * sanitize 下发也不泄密（当前并未下发，客户端用不到）。
   */
  function recordObservation(state, t, p, c) {
    if (!Array.isArray(state.observations)) state.observations = [];
    if (!t || !p || !c) return;
    if (t.phase === 'witch_resume') return;
    if (c.id === 'navigator' || c.id === 'bishop') return;
    // 已经建满了：不建是因为不能再建，不是因为买不起
    if (t.builds >= buildLimitFor(state, t)) return;
    if (!(p.gold >= 1)) return;
    state.observations[t.playerIdx] = {
      round: state.round,
      gold: p.gold,
      handSize: Array.isArray(p.hand) ? p.hand.length : 0,
      // 生意人的绿色建筑不受建造限额约束，所以他「没建」推不出绿色牌的信息
      freeColors: c.id === 'businessman' ? ['green'] : []
    };
  }

  function endTurn(state) {
    const t = state.turn;
    if (!t) return err('没有进行中的回合');
    const p = state.players[t.playerIdx];
    const c = charOf(t.charId);

    // 必须在炼金术士退款之前：退款会把金币抬回建造前的水平，那不是他的决策预算
    recordObservation(state, t, p, c);

    // 炼金术士回收建造花费。
    // 女巫接管被施咒的炼金术士时，是以炼金术士的身份继续该回合：用女巫自己的金币
    // 建造、建筑进入女巫的城区，因此回合末的建造花费返还同样归女巫所有
    // （官方规则：女巫 resume 该玩家回合，视同自己扮演被施咒角色，享有其能力的收益）。
    // 被施咒者本人此时只能领资源、无法建造（spentOnBuild 恒为 0），自然拿不到退款。
    if (c.id === 'alchemist' && t.spentOnBuild > 0) {
      const viaWitch = t.phase === 'witch_resume';
      p.gold += t.spentOnBuild;
      log(state, '【炼金术士】' + p.name + (viaWitch ? '（女巫接管）' : '') +
        ' 回收了本回合 ' + t.spentOnBuild + ' 枚建造花费。', 'good');
      notify(state, 'alchemist_refund', {
        playerIdx: t.playerIdx,
        playerId: p.id,
        playerName: p.name,
        amount: t.spentOnBuild,
        viaWitch: viaWitch
      });
    }

    p.played.push(t.charId);
    state.callIdx++;
    beginNextCall(state);
    return ok();
  }

  /* ---------------------------- 轮次结束 ---------------------------- */
  function endRound(state) {
    // 公开被刺杀角色
    if (state.effects.assassinated != null) {
      const entry = state.callQueue.find(e => e.num === state.effects.assassinated);
      if (entry) {
        log(state, '刺杀公开：' + state.players[entry.playerIdx].name + ' 本轮是『' +
          charOf(entry.charId).name + '』。', 'sys');
        // 被刺杀的国王/贵族/皇帝仍处理皇冠
        const c = charOf(entry.charId);
        if (entry.num === 4) {
          if (c.id === 'king' || c.id === 'noble') setCrown(state, entry.playerIdx);
          else if (c.id === 'emperor') {
            // 皇帝被刺杀：交出皇冠但不取得资源
            const others = otherPlayers(state, entry.playerIdx);
            if (others.length) {
              const ti = others[randInt(state, others.length)];
              setCrown(state, ti);
              log(state, '被刺杀的皇帝仍须交出皇冠。', 'crown');
            }
          }
        }
        // 皇后（4 号被刺杀时轮末结算）
        if (state.pendingQueen) {
          const q = state.pendingQueen;
          const n = state.players.length;
          const adjacent = (Math.abs(q.playerIdx - entry.playerIdx) === 1) ||
                           (Math.abs(q.playerIdx - entry.playerIdx) === n - 1);
          if (adjacent) {
            state.players[q.playerIdx].gold += 3;
            notifyGoldGain(state, q.playerIdx, 3, null, '皇后相邻奖励（轮末）');
            log(state, '【皇后】座位与 4 号角色相邻，轮末获得 3 枚金币。', 'good');
          }
          state.pendingQueen = null;
        }
      }
    }

    // 是否结束
    const target = state.config.endDistricts;
    const finished = state.players.some(p => p.city.length >= target);
    if (finished) { finishGame(state); return; }
    state.turn = null;
    // 轮末不立即进入下一轮选角，先等所有玩家确认战果
    state.roundConfirm = { round: state.round, confirmed: state.players.map(() => false) };
    log(state, '—— 第 ' + state.round + ' 轮结束，等待所有玩家确认战果 ——', 'round');
    notify(state, 'round_end', { round: state.round });
  }

  /* ---------------------------- 计分 ---------------------------- */
  function computeScores(state) {
    const target = state.config.endDistricts;
    const rows = state.players.map((p, i) => {
      let base = 0;
      const colors = {};
      let museum = 0, beautified = 0, ghostTowns = [];
      p.city.forEach(d => {
        base += districtScoreValue(d);
        colors[d.color] = true;
        if (d.museum) museum += d.museum.length;
        if (d.beautified) beautified += 1;
        if (d.purple && d.purple.effect === 'anyColorScore') ghostTowns.push(d);
      });
      const colorCount = Object.keys(colors).length;
      let bonus = 0;
      const detail = [];
      detail.push({ label: '建筑总分', value: base });
      if (museum) { bonus += museum; detail.push({ label: '博物馆', value: museum }); }
      if (beautified) { bonus += beautified; detail.push({ label: '美化', value: beautified }); }

      // 五色（鬼城可补色，最后一轮建成的不可用）
      const have = {};
      p.city.forEach(d => { have[d.color] = true; });
      const usableGhost = ghostTowns.filter(d => d.builtRound !== state.round).length;
      let miss = 0;
      CitCards.COLOR_ORDER.forEach(col => { if (!have[col]) miss++; });
      const allFive = (miss === 0) || (miss > 0 && miss <= usableGhost);
      if (allFive) { bonus += 3; detail.push({ label: '五色齐全', value: 3 }); }

      if (state.firstToFinish === i) { bonus += 4; detail.push({ label: '率先建成 ' + target + ' 栋', value: 4 }); }
      else if (p.city.length >= target) { bonus += 2; detail.push({ label: '建成 ' + target + ' 栋', value: 2 }); }

      return { playerIdx: i, name: p.name, base: base, bonus: bonus,
               total: base + bonus, detail: detail, cityCount: p.city.length };
    });
    return rows;
  }

  function finishGame(state) {
    state.phase = 'gameover';
    state.turn = null;
    state.scores = computeScores(state);
    let best = state.scores[0];
    let tie = 1;
    state.scores.forEach((r, i) => {
      if (i === 0) return;
      if (r.total > best.total) { best = r; tie = 1; }
      else if (r.total === best.total) tie++;
    });
    state.winner = tie > 1 ? null : best.playerIdx;
    log(state, '=== 游戏结束 ===', 'sys');
    state.scores.forEach(r => {
      log(state, r.name + '：' + r.total + ' 分（建筑 ' + r.base + ' + 奖励 ' + r.bonus + '）', 'score');
    });
    if (state.winner != null) log(state, '胜利者：' + state.players[state.winner].name + '！', 'score');
    else log(state, '平局！', 'score');
  }

  /* ---------------------------- 选角行动 ---------------------------- */
  function applyDraft(state, idx, action) {
    const d = state.draft;
    const step = d.steps[d.stepIdx];
    if (!step) return err('选角已结束');
    if (step.player !== idx) return err('还没轮到你选角');

    if (action.type === 'draft_pick') {
      if (d.sub !== 'pick') return err('当前应弃置角色牌');
      if (!removeFromDraftPool(d, action.charId)) return err('无效的角色牌');
      state.players[idx].chars.push(action.charId);
      log(state, state.players[idx].name + ' 选择了一张角色牌。', 'info');
      advanceDraft(state);
      return ok();
    }
    if (action.type === 'draft_discard') {
      if (d.sub !== 'discard') return err('当前应选择角色牌');
      const c = charOf(action.charId);
      if (c.num === 4) return err('4 号角色不可被弃置');
      if (!removeFromDraftPool(d, action.charId)) return err('无效的角色牌');
      d.faceDown.push(action.charId);
      log(state, state.players[idx].name + ' 暗置弃掉一张角色牌。', 'info');
      advanceDraft(state);
      return ok();
    }
    return err('未知的选角行动');
  }

  /* ---------------------------- 隐藏信息 ---------------------------- */
  /**
   * 事件提示偶尔带着只该发给某一家看的牌面（贵族刚抽到的牌、间谍看到的对手手牌构成）。
   * 客户端拿到的是通知全文，所以裁剪必须发生在服务端：否则人类玩家翻一下网络面板就能读出别人的牌。
   * @param {object} n 原始通知 @param {number} idx 观看者座位（-1 表示观战）
   */
  function noticeForViewer(n, idx) {
    if (idx >= 0) {
      if (n.kind === 'noble_draw' && n.playerIdx === idx) return n;
      if (n.kind === 'spy_result' && n.byIdx === idx) return n;
    }
    if (n.kind !== 'noble_draw' && n.kind !== 'spy_result') return n;
    const copy = {};
    for (const key in n) {
      if (!Object.prototype.hasOwnProperty.call(n, key)) continue;
      if (key === 'cardNames' || key === 'matching' || key === 'cards') continue;
      copy[key] = n[key];
    }
    return copy;
  }

  function sanitize(state, playerId) {
    repairState(state);
    const idx = playerIdx(state, playerId);
    const isSpectator = idx < 0;
    const out = {
      roomId: state.roomId,
      phase: state.phase,
      round: state.round,
      config: state.config,
      you: isSpectator ? null : state.players[idx].id,
      endDistricts: state.config.endDistricts,
      players: state.players.map((p, i) => {
        const o = {
          id: p.id, name: p.name, seat: p.seat, isBot: p.isBot, botType: p.botType,
          gold: p.gold,
          city: p.city.map(c => ({
            uid: c.uid, name: c.name, en: c.en, color: c.color, cost: c.cost,
            scoreValue: districtScoreValue(c),
            beautified: c.beautified || 0,
            museumCount: c.museum ? c.museum.length : 0,
            builtRound: c.builtRound || 0,
            purpleEffect: c.purple && c.purple.effect ? c.purple.effect : '',
            desc: c.desc || ''
          })),
          cityCount: p.city.length,
          handCount: p.hand.length,
          hasCrown: p.hasCrown,
          connected: p.connected,
          played: p.played.slice(),
          threat: blackmailerMark(state, i, idx),
          warrant: magistrateMark(state, i, idx),
          // 选角状态：未完成选角时不显示角色牌背；2~3 人局需要完成两次选取。
          hasChosen: p.chars.length > 0,
          draftComplete: state.phase !== 'draft' ||
            p.chars.length >= (state.players.length <= 3 ? 2 : 1),
          revealedCharId: (i === idx && p.chars.length)
            ? p.chars[0]
            : (state.turn && state.turn.playerIdx === i)
            ? state.turn.charId
            : (p.played && p.played.length ? p.played[0] : null),
          revealedCharNum: (i === idx && p.chars.length)
            ? charOf(p.chars[0]).num
            : (state.turn && state.turn.playerIdx === i)
            ? charOf(state.turn.charId).num
            : (p.played && p.played.length ? charOf(p.played[0]).num : null)
        };
        if (i === idx) {
          o.hand = p.hand.map(c => ({
            uid: c.uid, name: c.name, en: c.en, color: c.color, cost: c.cost,
            scoreValue: districtScoreValue(c),
            purpleEffect: c.purple && c.purple.effect ? c.purple.effect : '',
            desc: c.desc || '', canBuild: state.turn ? canBuildCard(state, p, c, state.turn) : false
          }));
          o.chars = p.chars.map(cid => ({ id: cid, num: charOf(cid).num, name: charOf(cid).name,
                                          desc: charOf(cid).desc, played: p.played.indexOf(cid) >= 0 }));
        } else {
          // 只显示本轮已公开（已行动过或被叫过）的角色
          o.chars = p.played.map(cid => ({ id: cid, num: charOf(cid).num, name: charOf(cid).name,
                                          desc: charOf(cid).desc, played: true }));
        }
        return o;
      }),
      deckCount: state.deck.length,
      discardCount: state.discard.length,
      callIdx: state.callIdx || 0,
      turnsCompleted: state.turnsCompleted || 0,
      charDeck: state.charDeck.map(cid => ({ id: cid, num: charOf(cid).num,
        name: charOf(cid).name, en: charOf(cid).en, desc: charOf(cid).desc })),
      effects: {
        assassinated: state.effects.assassinated,
        thief: state.effects.thief,
        bewitched: state.effects.bewitched,
        taxCollectorGold: state.effects.taxCollectorGold || 0,
        // 威胁标记挂在角色编号上：哪两个角色被威胁是公开信息，哪个是真的仍保密
        blackmailer: state.effects.blackmailer ? {
          nums: (state.effects.blackmailer.nums || []).slice(),
          playerIdx: state.effects.blackmailer.playerIdx,
          revealed: (state.effects.blackmailer.revealed || []).map(r => ({ num: r.num, isReal: !!r.isReal })),
          done: (state.effects.blackmailer.done || []).slice()
        } : null,
        // 逮捕令：公开的是「发给哪三个角色」，哪一张是真的仍然保密
        magistrate: state.effects.magistrate ? {
          nums: (state.effects.magistrate.nums || []).slice(),
          playerIdx: state.effects.magistrate.playerIdx
        } : null
      },
      firstToFinish: state.firstToFinish,
      log: state.log.slice(-120),
      // 关键事件，客户端据此弹提示；带私人牌面的几条按观看者裁剪后再发出
      notices: (state.notices || []).slice(-12).map(n => noticeForViewer(n, idx)),
      // 实时计分（城区是公开信息，任何人都能随时查看各玩家得分与明细）
      scores: computeScores(state),
      winner: state.winner,
      // 本轮被移除的角色：明置移除（公开身份，全场已知）与暗置移除（仅公开数量，身份保密）
      removed: {
        faceUp: state.draft ? state.draft.faceUp.map(cid => ({ id: cid, num: charOf(cid).num, name: charOf(cid).name })) : [],
        faceDownCount: state.draft ? state.draft.faceDown.length : 0
      },
      // 轮末确认：不为 null 时表示本轮已结束，等待所有玩家确认战果后才进入下一轮选角
      roundConfirm: state.roundConfirm
        ? { round: state.roundConfirm.round, confirmed: state.roundConfirm.confirmed.slice() }
        : null
    };

    if (state.phase === 'draft' && state.draft) {
      const d = state.draft;
      const step = d.steps[d.stepIdx];
      out.draft = {
        stepIdx: d.stepIdx,
        totalSteps: d.steps.length,
        currentPlayer: step ? state.players[step.player].id : null,
        sub: d.sub,
        faceUp: d.faceUp.map(cid => ({ id: cid, num: charOf(cid).num, name: charOf(cid).name, desc: charOf(cid).desc })),
        faceDownCount: d.faceDown.length,
        poolCount: d.pool.length,
        // 只有当前选角者可见牌池
        pool: (step && step.player === idx) ? d.pool.map(cid => ({
          id: cid, num: charOf(cid).num, name: charOf(cid).name, desc: charOf(cid).desc
        })) : []
      };
    }

    if (state.turn) {
      const t = state.turn;
      const c = charOf(t.charId);
      out.turn = {
        playerIdx: t.playerIdx,
        playerId: state.players[t.playerIdx].id,
        charId: t.charId, charName: c.name, charNum: t.num,
        phase: t.phase,
        takenResources: t.takenResources,
        incomeTaken: t.incomeTaken,
        monkExtraTaken: t.monkExtraTaken,
        abilityUsed: t.abilityUsed,
        spentOnBuild: t.spentOnBuild,
        usedLab: t.usedLab,
        usedSmithy: t.usedSmithy,
        usedMuseum: t.usedMuseum,
        bonusDone: t.bonusDone,
        buildLimit: buildLimitFor(state, t),
        builds: t.builds,
        // 只有当前行动者本人能拿到 pending 的具体牌面（抽牌/学者选牌属隐藏信息）
        pending: t.pending ? pendingPublic(t.pending, t.playerIdx === idx) : null
      };
    }
    if (state.reaction) {
      out.reaction = { kind: state.reaction.kind || 'graveyard',
                       playerIdx: state.reaction.playerIdx,
                       playerId: state.players[state.reaction.playerIdx].id,
                       targetIdx: state.reaction.targetIdx != null ? state.reaction.targetIdx : null,
                       prompt: state.reaction.prompt };
    }
    return out;
  }

  /**
   * 某个玩家「已公开」的角色编号：自己手上的、正在行动的、本轮已经行动过的。
   * 逮捕令和威胁标记都挂在角色编号上，而角色归属本身是暗置信息，
   * 所以只有这些编号能安全地拿来在玩家面板上画标记。
   */
  function publicCharNums(state, i, idx) {
    const p = state.players[i];
    const known = [];
    if (i === idx) {
      (p.chars || []).forEach(cid => known.push(charOf(cid).num));
    } else {
      if (state.turn && state.turn.playerIdx === i) known.push(charOf(state.turn.charId).num);
      (p.played || []).forEach(cid => known.push(charOf(cid).num));
    }
    return known;
  }

  /**
   * 玩家面板上要不要画威胁标记（盖牌 / 翻开后的刀子或玫瑰）。
   */
  function blackmailerMark(state, i, idx) {
    const th = state.effects.blackmailer;
    if (!th) return null;
    const known = publicCharNums(state, i, idx);
    const rev = (th.revealed || []).filter(r => known.indexOf(r.num) >= 0);
    if (rev.length) {
      const last = rev[rev.length - 1];
      return { num: last.num, revealed: true, isReal: !!last.isReal };
    }
    const nums = th.nums || [];
    for (let k = 0; k < nums.length; k++) {
      const n = nums[k];
      if (known.indexOf(n) >= 0 && (th.done || []).indexOf(n) < 0) {
        return { num: n, revealed: false, isReal: null };
      }
    }
    return null;
  }

  /**
   * 玩家面板上要不要画逮捕令（卷轴）。只在角色牌已经翻开后才画；
   * 三张逮捕令长得一样，不泄露哪一张是真的。
   */
  function magistrateMark(state, i, idx) {
    const w = state.effects.magistrate;
    if (!w) return null;
    const known = publicCharNums(state, i, idx);
    const nums = w.nums || [];
    for (let k = 0; k < nums.length; k++) {
      if (known.indexOf(nums[k]) >= 0) return { num: nums[k] };
    }
    return null;
  }

  function pendingPublic(pd, isActor) {
    switch (pd.kind) {
      case 'draw_keep':
      case 'scholar_pick':
        // 具体牌面只给正在选择的玩家；其他人只知道「正在选牌」和牌的数量。
        return { kind: pd.kind, prompt: pd.prompt, targetIdx: pd.targetIdx ?? null,
          fromCrownIdx: pd._fromCrownIdx ?? null, count: (pd.cards || []).length,
          cards: isActor ? (pd.cards || []).map(c => ({
            uid: c.uid, name: c.name, en: c.en, color: c.color, cost: c.cost, desc: c.desc })) : [] };
      case 'wizard_card':
        return { kind: pd.kind, prompt: pendingPrompt(pd.kind), targetIdx: pd.targetIdx ?? null,
          count: (pd.cards || []).length,
          cards: isActor ? (pd.cards || []).map(c => ({ uid: c.uid, name: c.name, en: c.en,
            color: c.color, cost: c.cost, desc: c.desc })) : [] };
      case 'wizard_choice':
        return { kind: pd.kind, prompt: pendingPrompt(pd.kind), targetIdx: pd.targetIdx ?? null,
          card: isActor && pd.card ? { uid: pd.card.uid, name: pd.card.name, en: pd.card.en,
            color: pd.card.color, cost: pd.card.cost, desc: pd.card.desc } : null };
      case 'artist':
        return { kind: pd.kind, targetIdx: pd.targetIdx ?? null,
          fromCrownIdx: pd._fromCrownIdx ?? null, selected: pd.selected || [] };
      case 'bishop_repay':
        return { kind: pd.kind, targetIdx: isActor ? pd.payerIdx : null,
          amount: isActor ? pd.amount : 0, uid: isActor ? pd.uid : '' };
      case 'bishop_payer':
        return { kind: pd.kind, prompt: pendingPrompt(pd.kind), targetIdx: null,
          amount: isActor ? pd.amount : 0, uid: isActor ? pd.uid : '' };
      default:
        return { kind: pd.kind, prompt: pendingPrompt(pd.kind), targetIdx: pd.targetIdx ?? null,
          fromCrownIdx: pd._fromCrownIdx ?? null };
    }
  }
  function pendingPrompt(kind) {
    const map = {
      assassin: '选择要刺杀的角色', thief: '选择要偷窃的角色', witch_target: '选择要施咒的角色',
      magician_choice: '选择魔术师的能力', magician_swap: '选择交换手牌的对象',
      magician_redraw: '选择要弃掉的手牌', warlord_destroy: '选择要摧毁的建筑',
      marshal_seize: '选择要抢夺的建筑', diplomat_mine: '选择自己的建筑',
      diplomat_theirs: '选择要换取的建筑', artist: '选择要美化的建筑',
      navigator_bonus: '选择额外奖励', monk_declare: '宣告资源组合',
      abbot_declare: '宣告住持资源组合', tax_collect: '收取建筑税',
      magistrate_declare: '分配逮捕令', magistrate_second: '分配逮捕令', magistrate_third: '分配逮捕令',
      magistrate_signed: '指定真逮捕令目标',
      blackmailer_declare: '分配威胁标记', blackmailer_second: '分配威胁标记',
      blackmailer_signed: '指定真威胁标记目标', blackmailer_threat: '处理勒索威胁',
      spy_target: '选择间谍调查对象', spy_color: '选择间谍调查类型',
      wizard_target: '选择法师查看对象', wizard_card: '选择法师取得的牌', wizard_choice: '选择法师牌的去向',
      emperor_crown: '选择皇冠归属', emperor_take: '选择拿取金币或手牌',
      prophet_give: '选择归还的手牌', draw_keep: '选择保留的建筑牌', scholar_pick: '选择 1 张建筑牌',
      bishop_payer: '选择主教建筑的代偿玩家', bishop_repay: '选择偿还代偿的手牌'
    };
    return map[kind] || '';
  }

  return {
    createGame: createGame,
    startGame: startGame,
    repairState: repairState,
    applyAction: applyAction,
    getAvailableActions: getAvailableActions,
    sanitize: sanitize,
    computeScores: computeScores,
    charOf: charOf,
    log: log,
    blackmailerBlockedNums: blackmailerBlockedNums,
    blackmailerValidNums: blackmailerValidNums,
    isAbbotProtected: isAbbotProtected,
    // 导出供信念层的回归测试直接构造场景（train/belief.js 只读它写下的账本）
    recordBeliefObservation: recordObservation
  };
});
