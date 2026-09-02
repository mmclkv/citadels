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
    return card.cost;
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
        startingGold: 2
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
      effects: { assassinated: null, thief: null, bewitched: null, witchBy: null, thiefBy: null },
      firstToFinish: -1,
      pendingQueen: null,
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

    state.charDeck = CitCards.pickCharacterSet(playerCount, state.config.charSetMode).map(c => c.id);
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
    state.players[0].hasCrown = true;
    log(state, '游戏开始！每位玩家获得 4 张建筑牌与 2 枚金币。皇冠由 ' + state.players[0].name + ' 持有。', 'sys');
    log(state, '本局使用角色：' + state.charDeck.map(id => CHAR_MAP[id].num + '.' + CHAR_MAP[id].name).join('、'), 'sys');
    startRound(state);
    return { ok: true };
  }

  /* ============================ 回合：选角 ============================ */
  function startRound(state) {
    state.round++;
    state.effects = { assassinated: null, thief: null, bewitched: null, witchBy: null, thiefBy: null };
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

    state.turn = newTurn(state, entry, 'main');

    // 4 号角色立刻获得皇冠
    const c = charOf(entry.charId);
    if (entry.num === 4 && (c.id === 'king' || c.id === 'noble')) {
      setCrown(state, entry.playerIdx);
    }
    if (c.id === 'queen') resolveQueen(state, entry);
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

  function getAvailableActions(state, playerId) {
    if (state.phase === 'gameover') return { phase: 'gameover', actions: [], prompt: '游戏结束' };
    if (state.phase === 'draft') return draftOptions(state, playerId);
    if (state.phase !== 'action') return { phase: state.phase, actions: [], prompt: '' };

    const idx = playerIdx(state, playerId);

    // 需要其它玩家响应（墓地）
    if (state.reaction) {
      if (state.reaction.playerIdx !== idx) return { actions: [], prompt: '等待其他玩家响应…' };
      const r = state.reaction;
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
        actions: [{ type: 'confirm_round', label: '✅ 确认本轮战果' }]
      };
    }

    const t = state.turn;
    if (!t) return { actions: [], prompt: '' };
    if (t.playerIdx !== idx) {
      return { actions: [], prompt: '等待 ' + state.players[t.playerIdx].name + ' 行动…' };
    }

    // 多步能力等待中
    if (t.pending) return pendingActions(state, t);

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

    // 角色能力
    if (!t.abilityUsed) {
      const label = abilityLabel(c.id);
      if (label) acts.push({ type: 'ability', label: label });
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
      case 'magician': return '【魔术师】使用能力';
      case 'warlord': return '【领主】摧毁一栋建筑';
      case 'diplomat': return '【外交官】交换建筑';
      case 'marshal': return '【元帅】抢夺建筑（费用≤3）';
      case 'artist': return '【艺术家】美化建筑';
      case 'emperor': return '【皇帝】转移皇冠';
      case 'navigator': return '【航海家】领取额外奖励';
      case 'scholar': return '【学者】抽 7 张选 1 张';
      case 'prophet': return '【预言家】抽取对手手牌';
      default: return null;
    }
  }

  function incomeAmount(state, p, t) {
    const c = charOf(t.charId);
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
      case 'magician_choice':
        return { prompt: '【魔术师】选择一种能力', actions: [
          { type: 'magician_mode', mode: 'swap', label: '与一位玩家交换全部手牌' },
          { type: 'magician_mode', mode: 'redraw', label: '弃掉任意张手牌并重抽' }
        ]};
      case 'magician_swap':
        return { prompt: '【魔术师】选择与谁交换手牌', actions: otherPlayers(state, t.playerIdx).map(i => ({
          type: 'choose_player', target: state.players[i].id,
          label: state.players[i].name + '（' + state.players[i].hand.length + ' 张手牌）'
        }))};
      case 'magician_redraw':
        return { prompt: '【魔术师】选择要弃掉的手牌（可留空）', actions: [
          { type: 'choose_cards', uids: [], label: '确定（可点选手牌后再确定）' }
        ], selectable: 'hand', multi: true };
      case 'warlord_destroy':
        return { prompt: '【领主】选择要摧毁的建筑', actions: destroyChoices(state, t) };
      case 'marshal_seize':
        return { prompt: '【元帅】选择要抢夺的建筑（费用 ≤ 3）', actions: seizeChoices(state, t) };
      case 'diplomat_mine':
        return { prompt: '【外交官】选择你自己的一栋建筑用于交换', actions: ownDistrictChoices(state, t, false) };
      case 'diplomat_theirs':
        return { prompt: '【外交官】选择要换取的建筑', actions: diplomatTargets(state, t) };
      case 'artist': {
        const chosen = pd.selected || [];
        return { prompt: '【艺术家】选择要美化的建筑（最多 2 栋，每栋 1 金）', actions:
          ownDistrictChoices(state, t, true, chosen).concat(
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
      case 'emperor_crown':
        return { prompt: '【皇帝】将皇冠交给谁？', actions: otherPlayers(state, t.playerIdx).map(i => ({
          type: 'emperor_crown', target: state.players[i].id, label: state.players[i].name
        }))};
      case 'emperor_take':
        return { prompt: '【皇帝】从 ' + state.players[pd.targetIdx].name + ' 处拿取', actions: [
          { type: 'emperor_take', mode: 'gold', label: '拿 1 枚金币' },
          { type: 'emperor_take', mode: 'card', label: '随机拿 1 张手牌' }
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

  function isBishopProtected(state, pidx) {
    const p = state.players[pidx];
    if (!p.chars.some(c => c === 'bishop')) return false;
    if (state.effects.assassinated === 5) return false;
    if (state.effects.bewitched === 5) return false;
    return true;
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
      if (i !== t.playerIdx && isBishopProtected(state, i)) return;
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
        notify(state, 'got_gold', {
          playerIdx: idx, playerId: p.id, playerName: p.name,
          amount: amt, why: '领取资源'
        });
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
          notify(state, 'got_gold', {
            playerIdx: idx, playerId: p.id, playerName: p.name,
            amount: gb, why: '角色加成'
          });
        }
        const n = draw3 ? 3 : 2;
        const drawn = drawCards(state, n);
        if (keepBoth) {
          p.hand = p.hand.concat(drawn);
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
        const rest = pd.cards.filter(x => x.uid !== action.uid);
        if (pd.toBottom) toBottom(state, rest);
        log(state, p.name + ' 抽取建筑牌，保留了『' + card.name + '』。', 'info');
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
        p.gold += inc.n;
        t.incomeTaken = true;
        if (inc.n > 0) {
          log(state, '【' + c.name + '】' + p.name + ' 因 ' + inc.n + ' 栋' +
            CitCards.COLORS[inc.color].name + '建筑获得 ' + inc.n + ' 枚金币。', 'good');
          notify(state, 'got_gold', {
            playerIdx: idx, playerId: p.id, playerName: p.name,
            amount: inc.n, why: '角色收入'
          });
        }
        return ok();
      }
      case 'monk_take': {
        const r = richestOther(state, idx);
        if (r < 0 || state.players[r].gold <= p.gold) return err('没有比你更富有的玩家');
        state.players[r].gold -= 1; p.gold += 1;
        t.monkExtraTaken = true;
        log(state, '【修士】' + p.name + ' 从 ' + state.players[r].name + ' 处拿走 1 枚金币。', 'good');
        return ok();
      }

      /* ---------- 建造 ---------- */
      case 'build': {
        const card = p.hand.find(x => x.uid === action.uid);
        if (!card) return err('手牌中没有这张建筑牌');
        if (!canBuildCard(state, p, card, t)) return err('无法建造该建筑（金币不足、超出建造限额或已有同名建筑）');
        p.gold -= card.cost;
        t.spentOnBuild += card.cost;
        p.hand = p.hand.filter(x => x.uid !== action.uid);
        const built = Object.assign({}, card, { beautified: 0, museum: [], builtRound: state.round });
        p.city.push(built);
        t.builds++;
        log(state, p.name + ' 建造了『' + card.name + '』（' + card.cost + ' 金）。', 'build');
        if (p.city.length >= state.config.endDistricts && state.firstToFinish < 0) {
          state.firstToFinish = idx;
          log(state, '★ ' + p.name + ' 率先建成第 ' + state.config.endDistricts + ' 栋建筑，本轮结束后游戏结束！', 'sys');
        }
        if (c.id === 'alchemist' && t.phase !== 'witch_resume') {
          // 炼金术士在回合结束时统一回收
        }
        return ok();
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
        return ok();
      }
      case 'smithy': {
        if (t.usedSmithy) return err('本回合已使用过铁匠铺');
        if (!p.city.some(d => d.uid === action.uid && d.purple && d.purple.effect === 'smithy')) return err('你没有铁匠铺');
        if (p.gold < 2) return err('金币不足');
        p.gold -= 2;
        const cards = drawCards(state, 3);
        p.hand = p.hand.concat(cards);
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
        if (pd.kind === 'assassin') {
          state.effects.assassinated = action.num;
          t.abilityUsed = true; t.pending = null;
          log(state, '【刺客】' + p.name + ' 宣布刺杀 ' + action.num + ' 号角色。', 'bad');
          notify(state, 'assassin_declare', { num: action.num, byIdx: idx, byId: p.id, byName: p.name });
        } else if (pd.kind === 'thief') {
          state.effects.thief = action.num;
          state.effects.thiefBy = idx;
          t.abilityUsed = true; t.pending = null;
          log(state, '【盗贼】' + p.name + ' 宣布偷窃 ' + action.num + ' 号角色。', 'bad');
          notify(state, 'thief_declare', { num: action.num, byIdx: idx, byId: p.id, byName: p.name });
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
        if (!pd || pd.kind !== 'magician_swap') return err('当前无需选择玩家');
        const ti = playerIdx(state, action.target);
        if (ti < 0 || ti === idx) return err('无效的目标玩家');
        const a = p.hand, b = state.players[ti].hand;
        p.hand = b; state.players[ti].hand = a;
        t.abilityUsed = true; t.pending = null;
        log(state, '【魔术师】' + p.name + ' 与 ' + state.players[ti].name + ' 交换了全部手牌。', 'magic');
        return ok();
      }
      case 'choose_cards': {
        const pd = t.pending;
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
          if (p.gold < 1) return err('金币不足');
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
        if (action.mode === 'gold') { p.gold += 4; log(state, '【航海家】' + p.name + ' 额外获得 4 枚金币。', 'good'); }
        else {
          const cards = drawCards(state, 4);
          p.hand = p.hand.concat(cards);
          log(state, '【航海家】' + p.name + ' 额外抽取 4 张建筑牌。', 'good');
        }
        t.bonusDone = true; t.abilityUsed = true; t.pending = null;
        return ok();
      }
      case 'scholar_pick': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'scholar_pick') return err('当前无需选择');
        const card = (pd.cards || []).find(x => x.uid === action.uid);
        if (!card) return err('无效的卡牌');
        p.hand.push(card);
        const rest = (pd.cards || []).filter(x => x.uid !== action.uid);
        rest.forEach(r => state.deck.push(r));
        state.deck = CitCards.shuffle(state.deck, () => nextRand(state));
        t.abilityUsed = true; t.pending = null;
        log(state, '【学者】' + p.name + ' 从 7 张中选择了『' + card.name + '』，其余洗回牌堆。', 'good');
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
        t.incomeTaken = true; t.pending = null;
        log(state, '【修士】' + p.name + ' 领取 ' + action.gold + ' 金 + ' + action.cards + ' 张建筑牌。', 'good');
        return ok();
      }
      case 'emperor_crown': {
        const pd = t.pending;
        if (!pd || pd.kind !== 'emperor_crown') return err('当前无需选择');
        const ti = playerIdx(state, action.target);
        if (ti < 0 || ti === idx) return err('无效的目标玩家');
        setCrown(state, ti);
        t.pending = { kind: 'emperor_take', targetIdx: ti };
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
        } else {
          if (tp.hand.length > 0) {
            const i = randInt(state, tp.hand.length);
            const card = tp.hand.splice(i, 1)[0];
            p.hand.push(card);
            log(state, '【皇帝】' + p.name + ' 从 ' + tp.name + ' 处随机拿取 1 张手牌。', 'good');
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
    switch (c.id) {
      case 'assassin': t.pending = { kind: 'assassin' }; break;
      case 'thief': t.pending = { kind: 'thief' }; break;
      case 'witch': t.pending = { kind: 'witch_target' }; break;
      case 'magician': t.pending = { kind: 'magician_choice' }; break;
      case 'warlord': t.pending = { kind: 'warlord_destroy' }; break;
      case 'marshal': t.pending = { kind: 'marshal_seize' }; break;
      case 'diplomat': t.pending = { kind: 'diplomat_mine' }; break;
      case 'artist': t.pending = { kind: 'artist', selected: [] }; break;
      case 'emperor': t.pending = { kind: 'emperor_crown' }; break;
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
    if (ti !== idx && isBishopProtected(state, ti)) return err('主教的城市不可摧毁');
    if (!canTargetDistrict(state, card)) return err('堡垒不可摧毁');
    const cost = destroyCost(state, ti, card);
    if (cost > me.gold) return err('金币不足，摧毁需 ' + cost + ' 金');

    me.gold -= cost;
    tp.city = tp.city.filter(x => x.uid !== card.uid);
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
      state.reaction = { kind: 'graveyard', playerIdx: gy[0], queue: gy, card: card, prompt: '' };
      state.reaction.prompt = '【墓地】是否支付 1 金将『' + card.name + '』收入手牌？';
      state.pendingDestroy = { card: card };
      return ok();
    }
    state.discard.push(card);
    return ok();
  }

  function applyReaction(state, idx, action) {
    const r = state.reaction;
    const p = state.players[idx];
    const card = state.pendingDestroy ? state.pendingDestroy.card : r.card;
    if (action.type !== 'reaction') return err('无效的响应');
    if (action.use) {
      if (p.gold < 1) return err('金币不足');
      p.gold -= 1;
      p.hand.push(card);
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
    const card = tp.city.find(x => x.uid === action.uid);
    if (!card) return err('无效的建筑');
    if (card.cost > 3) return err('只能抢夺费用 3 以下的建筑');
    if (tp.city.length >= state.config.endDistricts) return err('该玩家已达标，不可抢夺');
    if (!canTargetDistrict(state, card)) return err('堡垒不可抢夺');
    if (me.city.filter(d => d.name === card.name).length >= maxSameName(me)) return err('你已有同名建筑');
    if (card.cost > me.gold) return err('金币不足');
    me.gold -= card.cost;
    tp.gold += card.cost;
    tp.city = tp.city.filter(x => x.uid !== card.uid);
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
    const theirs = tp.city.find(x => x.uid === action.uid);
    if (!theirs) return err('无效的建筑');
    if (!canTargetDistrict(state, theirs)) return err('堡垒不可交换');
    if (me.city.filter(d => d.name === theirs.name).length >= maxSameName(me)) return err('你已有同名建筑');
    const diff = Math.max(0, theirs.cost - mine.cost);
    if (diff > me.gold) return err('金币不足，需补差价 ' + diff + ' 金');
    me.gold -= diff;
    tp.gold += diff;
    tp.city = tp.city.filter(x => x.uid !== theirs.uid);
    me.city = me.city.filter(x => x.uid !== mine.uid);
    me.city.push(theirs);
    tp.city.push(mine);
    t.abilityUsed = true; t.pending = null;
    log(state, '【外交官】' + me.name + ' 用『' + mine.name + '』换来了 ' + tp.name +
      ' 的『' + theirs.name + '』' + (diff > 0 ? '，补差价 ' + diff + ' 金' : '') + '。', 'bad');
    notify(state, 'swapped', {
      playerIdx: ti, playerId: tp.id, playerName: tp.name,
      byName: me.name, cardName: theirs.name, gotName: mine.name, cost: diff
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
      pending: null, bonusDone: true
    };
    // 若被施咒者是 4 号（国王/贵族），女巫不获得皇冠，但国王仍获得皇冠
    if (entry.num === 4 && (c.id === 'king' || c.id === 'noble')) {
      setCrown(state, entry.playerIdx);
      log(state, '被施咒的国王/贵族仍然获得皇冠（女巫无法取得）。', 'crown');
    }
    if (c.id === 'noble') doNobleIncome(state);
    log(state, '【女巫】' + state.players[witchIdx].name + ' 接管『' + c.name + '』的剩余行动。', 'magic');
    return ok();
  }

  /* ---------------------------- 回合结束 ---------------------------- */
  function endTurn(state) {
    const t = state.turn;
    if (!t) return err('没有进行中的回合');
    const p = state.players[t.playerIdx];
    const c = charOf(t.charId);

    // 炼金术士回收建造花费
    if (c.id === 'alchemist' && t.phase !== 'witch_resume' && t.spentOnBuild > 0) {
      p.gold += t.spentOnBuild;
      log(state, '【炼金术士】' + p.name + ' 回收了本回合 ' + t.spentOnBuild + ' 枚建造花费。', 'good');
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
    if (state.winner != null) log(state, '🏆 胜利者：' + state.players[state.winner].name + '！', 'score');
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
  function sanitize(state, playerId) {
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
          id: p.id, name: p.name, seat: p.seat, isBot: p.isBot,
          gold: p.gold,
          city: p.city.map(c => ({
            uid: c.uid, name: c.name, en: c.en, color: c.color, cost: c.cost,
            scoreValue: districtScoreValue(c),
            beautified: c.beautified || 0,
            museumCount: c.museum ? c.museum.length : 0,
            desc: c.desc || ''
          })),
          cityCount: p.city.length,
          handCount: p.hand.length,
          hasCrown: p.hasCrown,
          connected: p.connected,
          played: p.played.slice(),
          // 选角状态：hasChosen=已选（盖牌），revealedCharNum=已公开（翻面）。
          // 仅在该角色被叫到/已行动时暴露编号（公开信息），其余情况为 null，不泄露身份。
          hasChosen: p.chars.length > 0,
          revealedCharNum: (state.turn && state.turn.playerIdx === i)
            ? charOf(state.turn.charId).num
            : (p.played && p.played.length ? charOf(p.played[0]).num : null)
        };
        if (i === idx) {
          o.hand = p.hand.map(c => ({
            uid: c.uid, name: c.name, en: c.en, color: c.color, cost: c.cost,
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
      charDeck: state.charDeck.map(cid => ({ id: cid, num: charOf(cid).num,
        name: charOf(cid).name, en: charOf(cid).en, desc: charOf(cid).desc })),
      effects: {
        assassinated: state.effects.assassinated,
        thief: state.effects.thief,
        bewitched: state.effects.bewitched
      },
      firstToFinish: state.firstToFinish,
      log: state.log.slice(-120),
      // 关键事件（公开信息），客户端据此弹提示
      notices: (state.notices || []).slice(-12),
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
        buildLimit: buildLimitFor(state, t),
        builds: t.builds,
        pending: t.pending ? pendingPublic(t.pending) : null
      };
    }
    if (state.reaction) {
      out.reaction = { playerIdx: state.reaction.playerIdx,
                       playerId: state.players[state.reaction.playerIdx].id,
                       prompt: state.reaction.prompt };
    }
    return out;
  }

  function pendingPublic(pd) {
    switch (pd.kind) {
      case 'draw_keep':
        return { kind: pd.kind, prompt: pd.prompt, cards: (pd.cards || []).map(c => ({
          uid: c.uid, name: c.name, color: c.color, cost: c.cost, desc: c.desc })) };
      case 'scholar_pick':
        return { kind: pd.kind, prompt: pd.prompt, cards: (pd.cards || []).map(c => ({
          uid: c.uid, name: c.name, color: c.color, cost: c.cost, desc: c.desc })) };
      case 'artist':
        return { kind: pd.kind, selected: pd.selected || [] };
      default:
        return { kind: pd.kind, prompt: pendingPrompt(pd.kind) };
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
      emperor_crown: '选择皇冠归属', emperor_take: '选择拿取金币或手牌',
      prophet_give: '选择归还的手牌', draw_keep: '选择保留的建筑牌', scholar_pick: '选择 1 张建筑牌'
    };
    return map[kind] || '';
  }

  return {
    createGame: createGame,
    startGame: startGame,
    applyAction: applyAction,
    getAvailableActions: getAvailableActions,
    sanitize: sanitize,
    computeScores: computeScores,
    charOf: charOf,
    log: log
  };
});
