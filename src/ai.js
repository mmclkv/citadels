/* =========================================================================
 * 富饶之城 — NPC 决策（启发式 AI）
 * 三档难度：easy / normal / hard
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cards.js'), require('./engine.js'));
  } else {
    root.CitAI = factory(root.CitCards, root.CitEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (CitCards, Engine) {
  'use strict';

  const CHAR_MAP = CitCards.CHAR_MAP;
  const LEVEL = { easy: 0, normal: 1, hard: 2 };

  /* --------------------------- 通用估值 --------------------------- */
  function colorCount(player, color) {
    return player.city.filter(d => d.color === color).length;
  }
  function maxSame(player, name) {
    const q = player.city.filter(d => d.purple && d.purple.effect === 'quarry').length;
    return 1 + q;
  }
  function affordable(player) {
    return player.hand.filter(c => c.cost <= player.gold);
  }
  function buildValue(state, player, card) {
    const have = {};
    player.city.forEach(d => { have[d.color] = true; });
    let v = card.cost;
    const colorsOwned = Object.keys(have).length;
    if (!have[card.color]) {
      v += 2.2;
      if (colorsOwned === 4) v += 3.5;          // 补满五色
    }
    if (card.color === 'purple') v += 1.2;
    if (card.purple) {
      const e = card.purple.effect;
      if (e === 'scoreAs') v += 0.8;
      if (e === 'keepBoth' || e === 'draw3keep1') v += 1.0;
      if (e === 'smithy' || e === 'lab') v += 0.8;
      if (e === 'immune') v += 1.0;
    }
    // 越接近结束，越偏好高分建筑
    const left = Math.max(0, state.config.endDistricts - player.city.length);
    if (left <= 2) v += card.cost * 0.35;
    return v;
  }
  function bestBuildCard(state, player) {
    let best = null, bestV = -1;
    player.hand.forEach(c => {
      if (c.cost > player.gold) return;
      if (player.city.filter(d => d.name === c.name).length >= maxSame(player, c.name)) return;
      const v = buildValue(state, player, c);
      if (v > bestV) { bestV = v; best = c; }
    });
    return best;
  }

  /* ------------------------ 角色价值评估 ------------------------ */
  function charValue(state, idx, charId, level) {
    const c = CHAR_MAP[charId];
    const p = state.players[idx];
    const target = state.config.endDistricts;
    let v = 0;
    // 收入
    if (c.income) v += colorCount(p, c.income) * 1.3;
    v += (c.goldBonus || 0) * 1.4;
    v += (c.drawBonus || 0) * 0.9;
    v += (c.buildLimit - 1) * 1.6;
    if (c.noBuild) v -= 0.5;
    // 手牌状况：手牌少时更需要抽牌角色
    const handQ = p.hand.reduce((s, c2) => s + c2.cost, 0);
    if (p.hand.length <= 1) v += (c.drawBonus || 0) * 1.2 + (c.id === 'scholar' ? 2 : 0);
    if (p.gold >= 5 && handQ >= 5) v += (c.buildLimit - 1) * 1.2;

    // 情境
    const leader = leaderIdx(state);
    const behind = leader >= 0 && state.players[leader].city.length - p.city.length;
    switch (c.id) {
      case 'architect': v += 1.2; break;
      case 'merchant': v += 0.6; break;
      case 'bishop': v += 0.8 + colorCount(p, 'blue') * 0.2; break;
      case 'warlord':
        v += colorCount(p, 'red') * 0.3;
        if (behind >= 2) v += 2.0;              // 落后时拆家拖延
        if (p.gold >= 4) v += 0.8;
        break;
      case 'diplomat':
        if (behind >= 2) v += 1.2;
        v += colorCount(p, 'red') * 0.3;
        break;
      case 'marshal':
        if (behind >= 2) v += 1.4;
        v += colorCount(p, 'red') * 0.3;
        break;
      case 'thief': {
        let maxGold = 0;
        state.players.forEach((o, i) => { if (i !== idx) maxGold = Math.max(maxGold, o.gold); });
        v += Math.min(3, maxGold * 0.45);
        break;
      }
      case 'assassin': v += 1.0; break;
      case 'magician':
        v += p.hand.length <= 1 ? 1.6 : 0.2;
        break;
      case 'king': v += 0.7 + (p.hasCrown ? 0 : 0.5); break;
      case 'noble': v += colorCount(p, 'yellow') * 0.9; break;
      case 'navigator': v += 1.0; break;
      case 'scholar': v += 1.2; break;
      case 'alchemist': v += (p.gold >= 6 ? 1.5 : 0.1); break;
      case 'businessman': v += colorCount(p, 'green') * 0.3 + (p.hand.filter(x => x.color === 'green').length * 0.9); break;
      case 'monk': v += colorCount(p, 'blue') * 0.8; break;
      case 'artist': v += (p.gold >= 4 ? 1.4 : 0); break;
      case 'queen': v += 0.5; break;
      case 'witch': v += 0.9; break;
      case 'emperor': v += 0.4; break;
      case 'prophet': v += 0.9; break;
    }
    // 即将结束游戏时，优先能立刻多盖房子的角色
    if (p.city.length >= target - 2) v += (c.buildLimit - 1) * 1.4;
    return v;
  }

  function leaderIdx(state) {
    let best = -1, bv = -1;
    state.players.forEach((p, i) => {
      const v = p.city.reduce((s, d) => s + d.cost, 0) + p.city.length * 2;
      if (v > bv) { bv = v; best = i; }
    });
    return best;
  }

  /**
   * 电脑和人类看同一份行动清单：需要「有哪些可选目标」时问引擎要。
   * 直接翻 state.callQueue（谁握着哪个还没叫到的号）、别人手里的 chars 或手牌，
   * 都是人类玩家看不到的隐藏信息，那样赢来的不是棋力而是作弊。
   */
  function choicesOf(state, playerId, type) {
    const res = Engine.getAvailableActions(state, playerId) || {};
    return (res.actions || []).filter(a => a.type === type && !a.disabled);
  }
  function charByNum(state, num) {
    const id = (state.charDeck || []).find(cid => {
      const c = Engine.charOf(cid);
      return c && c.num === num;
    });
    return id ? Engine.charOf(id) : null;
  }
  /** 某玩家城里最多的建筑颜色：手牌看不到，城区是公开的，只能这样猜。 */
  function topCityColor(player, fallback) {
    const counts = {};
    player.city.forEach(d => { counts[d.color] = (counts[d.color] || 0) + 1; });
    let best = null, bv = 0;
    Object.keys(counts).forEach(color => { if (counts[color] > bv) { bv = counts[color]; best = color; } });
    return bv > 0 ? best : fallback;
  }

  /* --------------------------- 选角决策 --------------------------- */
  // rnd: 可选的 [0,1) 随机源。默认 Math.random()，保持既有行为；
  //     传入确定性函数（如基于 seed）即可让同一局的 AI 决策完全可复现。
  function draftDecision(state, idx, rnd) {
    const rand = typeof rnd === 'function' ? rnd : Math.random;
    const d = state.draft;
    const step = d.steps[d.stepIdx];
    if (!step || step.player !== idx) return null;
    const p = state.players[idx];
    const level = LEVEL[p.botLevel] != null ? LEVEL[p.botLevel] : 1;

    if (d.sub === 'discard') {
      // 弃掉对自己最没用的（4 号不可弃）
      let worst = null, wv = 1e9;
      d.pool.filter(id => CHAR_MAP[id].num !== 4).forEach(id => {
        const v = charValue(state, idx, id, level);
        if (v < wv) { wv = v; worst = id; }
      });
      return { type: 'draft_discard', charId: worst || d.pool[0] };
    }

    // 7~8 人末位可从暗置牌中选； otherwise 只从明面牌池选
    const pool = (step.fromFaceDown && d.sub === 'pick') ? d.pool.concat(d.faceDown) : d.pool;
    let best = null, bv = -1e9;
    pool.forEach(id => {
      let v = charValue(state, idx, id, level);
      v += (rand() - 0.5) * (level === 0 ? 4.0 : level === 1 ? 1.2 : 0.25);
      if (v > bv) { bv = v; best = id; }
    });
    return { type: 'draft_pick', charId: best || pool[0] };
  }

  /* --------------------------- 主决策 --------------------------- */
  // rnd: 可选随机源，见 draftDecision。默认 Math.random()。
  function decide(state, playerId, rnd) {
    const rand = typeof rnd === 'function' ? rnd : Math.random;
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx < 0) return null;
    const p = state.players[idx];
    const level = LEVEL[p.botLevel] != null ? LEVEL[p.botLevel] : 1;

    if (state.phase === 'gameover') return null;
    // 轮末确认战果：电脑确认后等待其他人
    if (state.roundConfirm) {
      return state.roundConfirm.confirmed[idx] ? null : { type: 'confirm_round' };
    }
    if (state.phase === 'draft') return draftDecision(state, idx, rand);

    if (state.reaction) {
      if (state.reaction.playerIdx !== idx) return null;
      // 行政官的逮捕令：白拿一栋建筑，几乎总是值得发动
      if (state.reaction.kind === 'magistrate') return { type: 'reaction', use: true };
      // 勒索者的威胁标记：翻开没有成本，最多白拿对方全部金币
      if (state.reaction.kind === 'blackmailer') return { type: 'reaction', use: true };
      const card = state.pendingDestroy ? state.pendingDestroy.card : state.reaction.card;
      const worth = card.cost >= 3 && p.gold >= 2;
      return { type: 'reaction', use: worth };
    }

    const t = state.turn;
    if (!t || t.playerIdx !== idx) return null;

    // ---- 多步能力 ----
    if (t.pending) return pendingDecision(state, idx, t, level, rand);

    const c = CHAR_MAP[t.charId];

    // 被施咒：只能领资源
    if (t.phase === 'bewitched') {
      return { type: 'take_gold' };
    }

    // 1) 领取资源
    if (!t.takenResources) {
      return chooseResource(state, idx, c, level);
    }

    // 2) 角色能力
    if (!t.abilityUsed && shouldUseAbility(state, idx, t, c, level)) {
      return { type: 'ability' };
    }

    // 3) 收入（建筑师/商人等先拿收入再盖房）
    if (!t.incomeTaken && hasIncome(state, idx, t)) {
      return { type: 'income' };
    }
    if (c.id === 'monk' && t.incomeTaken && !t.monkExtraTaken) {
      let richest = -1, rg = p.gold;
      state.players.forEach((o, i) => { if (i !== idx && o.gold > rg) { rg = o.gold; richest = i; } });
      if (richest >= 0) return { type: 'monk_take' };
    }

    // 4) 建造
    const build = bestBuildCard(state, p);
    if (build && t.builds < buildLimit(state, t)) {
      return { type: 'build', uid: build.uid };
    }

    // 5) 紫色建筑主动能力
    const purple = purpleAbility(state, idx, t, p);
    if (purple) return purple;

    return { type: 'end_turn' };
  }

  function buildLimit(state, t) {
    return CHAR_MAP[t.charId].buildLimit;
  }
  function hasIncome(state, idx, t) {
    const c = CHAR_MAP[t.charId];
    if (!c.income) return false;
    return colorCount(state.players[idx], c.income) > 0 ||
           state.players[idx].city.some(d => d.purple && d.purple.effect === 'anyColorIncome');
  }

  function chooseResource(state, idx, c, level) {
    const p = state.players[idx];
    const target = state.config.endDistricts;
    // 手牌里能盖得起的最高价值
    let goldScore = 0;
    p.hand.forEach(card => {
      if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name)) return;
      if (card.cost <= p.gold + 2 + (c.goldBonus || 0)) {
        goldScore = Math.max(goldScore, buildValue(state, p, card));
      }
    });
    const handPoor = p.hand.length <= 1;
    const goldHungry = p.gold < 3;
    if (c.id === 'navigator') {
      // 本回合不能建造，倾向于攒钱
      return (p.gold < 6) ? { type: 'take_gold' } : { type: 'take_cards' };
    }
    if (handPoor) return { type: 'take_cards' };
    if (goldScore >= 3.2 && !goldHungry) return { type: 'take_gold' };
    if (p.city.length >= target - 2 && goldScore > 0) return { type: 'take_gold' };
    if (p.hand.length <= 2) return { type: 'take_cards' };
    if (goldScore >= 2.4) return { type: 'take_gold' };
    return { type: 'take_cards' };
  }

  function shouldUseAbility(state, idx, t, c, level) {
    switch (c.id) {
      case 'assassin': case 'thief': case 'witch': case 'magician':
      case 'magistrate': case 'spy': case 'blackmailer': case 'wizard': return true;
      case 'tax_collector': return true;
      case 'warlord': {
        const p = state.players[idx];
        if (p.gold < 1) return false;
        const leader = leaderIdx(state);
        if (leader === idx) return false;
        if (state.players[leader].city.length >= state.config.endDistricts) return false;
        return p.city.length <= state.players[leader].city.length;
      }
      case 'marshal': {
        const p = state.players[idx];
        if (p.gold < 2) return false;
        const leader = leaderIdx(state);
        if (leader === idx) return false;
        return state.players[leader].city.length > p.city.length;
      }
      case 'diplomat': {
        const p = state.players[idx];
        if (p.gold < 1) return false;
        // 有比自己贵的建筑可换
        const mine = p.city.filter(x => !(x.purple && x.purple.effect === 'immune'));
        if (!mine.length) return false;
        const leader = leaderIdx(state);
        return leader !== idx;
      }
      case 'artist': {
        const p = state.players[idx];
        return p.gold >= 3 && p.city.length >= 2;
      }
      case 'emperor': return true;
      case 'navigator': return !t.bonusDone;
      case 'scholar': return true;
      case 'prophet': return true;
      default: return false;
    }
  }

  function purpleAbility(state, idx, t, p) {
    if (!t.usedSmithy && p.gold >= 6 && p.city.some(d => d.purple && d.purple.effect === 'smithy')) {
      const s = p.city.find(d => d.purple && d.purple.effect === 'smithy');
      return { type: 'smithy', uid: s.uid };
    }
    if (!t.usedLab && p.hand.length >= 3 && p.city.some(d => d.purple && d.purple.effect === 'lab')) {
      // 弃掉最没用的牌
      let worst = null, wv = 1e9;
      p.hand.forEach(c => {
        let v = c.cost;
        if (p.city.filter(d => d.name === c.name).length >= maxSame(p, c.name)) v = -5;
        if (v < wv) { wv = v; worst = c; }
      });
      if (worst) {
        const lab = p.city.find(d => d.purple && d.purple.effect === 'lab');
        return { type: 'lab', uid: lab.uid, discardUid: worst.uid };
      }
    }
    if (!t.usedMuseum && p.hand.length >= 4 && p.city.some(d => d.purple && d.purple.effect === 'museum')) {
      let worst = null, wv = 1e9;
      p.hand.forEach(c => {
        let v = c.cost + (c.color === 'purple' ? 3 : 0);
        if (p.city.filter(d => d.name === c.name).length >= maxSame(p, c.name)) v += 2;
        if (v < wv) { wv = v; worst = c; }
      });
      if (worst) {
        const mus = p.city.find(d => d.purple && d.purple.effect === 'museum');
        return { type: 'museum', uid: mus.uid, cardUid: worst.uid };
      }
    }
    return null;
  }

  // 宗教线的资源份数：与引擎 countColorForIncome(p,'blue','blue') 同口径
  // （宗教建筑数 + 「可当任意颜色」的加成建筑）。
  function countReligiousBuildings(state, p) {
    return p.city.filter(d => d.color === 'blue').length +
      p.city.filter(d => d.purple && d.purple.effect === 'anyColorIncome').length;
  }

  /* ------------------------ 多步能力决策 ------------------------ */
  function pendingDecision(state, idx, t, level, rnd) {
    const rand = typeof rnd === 'function' ? rnd : Math.random;
    const pd = t.pending;
    const p = state.players[idx];
    const c = CHAR_MAP[t.charId];

    switch (pd.kind) {
      case 'magistrate_declare': {
        const nums = choicesOf(state, p.id, 'magistrate_signed').map(a => a.num);
        return { type: 'magistrate_signed', num: nums[0] || 1 };
      }
      case 'magistrate_second': case 'magistrate_third': {
        const nums = choicesOf(state, p.id, 'magistrate_char').map(a => a.num);
        return { type: 'magistrate_char', num: nums[0] || 1 };
      }
      case 'blackmailer_declare': case 'blackmailer_second': {
        // 1 号角色 / 被刺杀 / 被施咒 / 已有逮捕令者都不能当威胁目标，必须走引擎同一套过滤
        const exclude = pd.kind === 'blackmailer_second' ? [pd.first] : [];
        const choices = Engine.blackmailerValidNums(state, t, exclude);
        if (choices.length === 0) return { type: 'ability_skip' };
        return { type: 'blackmailer_char', num: choices[0] };
      }
      case 'blackmailer_signed': {
        // 哪个人握哪个号是隐藏的，勒索者看不出被标的是穷人还是富人；
        // 真标记只能在这两个公开编号里随机指定，猜错才是要害。
        const nums = choicesOf(state, p.id, 'blackmailer_signed').map(a => a.num);
        return { type: 'blackmailer_signed', num: nums[Math.floor(rand() * nums.length)] || nums[0] || 1 };
      }
      case 'blackmailer_threat':
        // 赎金是一半金币，被真标记命中是全没了 —— 期望上两者相当，
        // 金币多时花钱买确定性，金币少时干脆赌一把让勒索者去翻
        return { type: p.gold >= 4 ? 'blackmailer_bribe' : 'blackmailer_refuse' };
      case 'spy_target': {
        const target = state.players.filter((_, i) => i !== idx).sort((a, b) => b.hand.length - a.hand.length)[0];
        return { type: 'spy_target', target: target && target.id };
      }
      case 'spy_color': {
        // 对手手牌看不到：只能按公开信息猜他最可能攒着哪种颜色。
        const target = state.players[pd.targetIdx];
        const guess = target ? topCityColor(target, null) : null;
        const options = choicesOf(state, p.id, 'spy_color').map(a => a.color);
        const color = options.indexOf(guess) >= 0 ? guess : (options[0] || 'blue');
        return { type: 'spy_color', color };
      }
      case 'wizard_target': {
        const target = state.players.filter((_, i) => i !== idx).sort((a, b) => b.hand.length - a.hand.length)[0];
        return { type: 'wizard_target', target: target && target.id };
      }
      case 'wizard_card': {
        const card = (pd.cards || []).slice().sort((a, b) => b.cost - a.cost)[0];
        return { type: 'wizard_card', uid: card && card.uid };
      }
      case 'wizard_choice':
        return { type: p.gold >= (pd.card && pd.card.cost || 0) ? 'wizard_build' : 'wizard_take' };
      case 'tax_collect':
        return { type: 'tax_collect' };
      case 'assassin': {
        const pref = { 7: 3.2, 4: 2.6, 6: 2.2, 5: 2.0, 8: 2.4, 3: 1.8, 2: 1.6, 9: 0.8 };
        const opts = choicesOf(state, p.id, 'choose_char');
        if (!opts.length) return { type: 'ability_skip' };
        let best = null, bv = -1;
        // 「几号在谁手上」是隐藏的，所以只能按角色本身的价值挑，不能挑 leader 那张。
        opts.forEach(a => {
          let v = pref[a.num] != null ? pref[a.num] : 1;
          if (a.num === 8 && p.city.length >= 5) v += 1.0;
          if (a.num === 2 && p.gold >= 5) v += 1.2;
          v += (rand() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = a.num; }
        });
        return { type: 'choose_char', num: best != null ? best : opts[0].num };
      }
      case 'thief': {
        const opts = choicesOf(state, p.id, 'choose_char');
        if (!opts.length) return { type: 'ability_skip' };
        let best = null, bv = -1;
        opts.forEach(a => {
          const cc = charByNum(state, a.num);
          let v = 0.6;
          // 收入型角色往往是富人的选择
          if (cc && cc.income) {
            let mx = 0;
            state.players.forEach((o, i) => {
              if (i === idx) return;
              if (o.gold < 2) return;
              const n = colorCount(o, cc.income) + o.city.filter(d => d.purple && d.purple.effect === 'anyColorIncome').length;
              mx = Math.max(mx, n * 0.5 + o.gold * 0.35);
            });
            v += mx;
          } else {
            let mx = 0;
            state.players.forEach((o, i) => { if (i !== idx) mx = Math.max(mx, o.gold); });
            v += mx * 0.25;
          }
          v += (rand() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = a.num; }
        });
        return { type: 'choose_char', num: best != null ? best : opts[0].num };
      }
      case 'witch_target': {
        const pref = { 7: 3.0, 6: 2.6, 5: 2.4, 4: 2.0, 8: 2.2, 3: 1.6, 2: 1.4, 9: 1.0 };
        const opts = choicesOf(state, p.id, 'choose_char');
        if (!opts.length) return { type: 'ability_skip' };
        let best = null, bv = -1;
        opts.forEach(a => {
          let v = pref[a.num] != null ? pref[a.num] : 1;
          v += (rand() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = a.num; }
        });
        return { type: 'choose_char', num: best != null ? best : opts[0].num };
      }
      case 'magician_choice': {
        let mostCards = -1, mi = -1;
        state.players.forEach((o, i) => { if (i !== idx && o.hand.length > mostCards) { mostCards = o.hand.length; mi = i; } });
        if (p.hand.length <= 1 && mostCards >= 2) return { type: 'magician_mode', mode: 'swap' };
        if (p.hand.length >= 3 && mostCards >= 4) return { type: 'magician_mode', mode: 'swap' };
        return { type: 'magician_mode', mode: 'redraw' };
      }
      case 'magician_swap': {
        let mi = -1, mc = -1;
        state.players.forEach((o, i) => { if (i !== idx && o.hand.length > mc) { mc = o.hand.length; mi = i; } });
        if (mi < 0) mi = (idx + 1) % state.players.length;
        return { type: 'choose_player', target: state.players[mi].id };
      }
      case 'magician_redraw': {
        const drop = [];
        p.hand.forEach(card => {
          if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name) && card.color !== 'purple') drop.push(card.uid);
          else if (card.cost > p.gold + 4) drop.push(card.uid);
        });
        return { type: 'choose_cards', uids: drop };
      }
      case 'warlord_destroy': {
        const leader = leaderIdx(state);
        // 目标清单以引擎发布的为准：住持保护这类判定要用到手牌里的角色牌，电脑不该自己查。
        const allowed = new Set(choicesOf(state, p.id, 'choose_district').map(a => a.uid));
        let best = null, bv = -1, bestTarget = null;
        state.players.forEach((tp, i) => {
          tp.city.forEach(card => {
            if (!allowed.has(card.uid)) return;
            let cost = card.cost - 1 + (card.beautified ? 1 : 0);
            if (tp.city.some(d => d.uid !== card.uid && d.purple && d.purple.effect === 'wallCost')) cost += 1;
            cost = Math.max(0, cost);
            let v = card.cost * 1.2 - cost * 0.4;
            if (i === leader) v += 2.0;
            if (i === idx) v -= 6;                       // 一般不拆自己的
            if (v > bv) { bv = v; best = card; bestTarget = tp.id; }
          });
        });
        if (!best) return { type: 'ability_skip' };
        return { type: 'choose_district', target: bestTarget, uid: best.uid };
      }
      case 'marshal_seize': {
        const allowed = new Set(choicesOf(state, p.id, 'choose_district').map(a => a.uid));
        let best = null, bt = null, bv = -1;
        state.players.forEach((tp, i) => {
          if (i === idx) return;
          tp.city.forEach(card => {
            if (!allowed.has(card.uid)) return;
            if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name)) return;
            const v = card.cost * 1.5 - card.cost * 0.3 + (i === leaderIdx(state) ? 1.5 : 0);
            if (v > bv) { bv = v; best = card; bt = tp.id; }
          });
        });
        if (!best) return { type: 'ability_skip' };
        return { type: 'choose_district', target: bt, uid: best.uid };
      }
      case 'diplomat_mine': {
        let worst = null, wv = 1e9;
        p.city.forEach(card => {
          if (card.purple && card.purple.effect === 'immune') return;
          if (card.purple && card.purple.effect === 'scoreAs') return;
          const v = card.cost + (card.color === 'purple' ? 4 : 0);
          if (v < wv) { wv = v; worst = card; }
        });
        if (!worst) return { type: 'ability_skip' };
        return { type: 'choose_district', target: p.id, uid: worst.uid };
      }
      case 'diplomat_theirs': {
        const mine = p.city.find(x => x.uid === pd.mineUid);
        const allowed = new Set(choicesOf(state, p.id, 'choose_district').map(a => a.uid));
        let best = null, bt = null, bv = -1;
        state.players.forEach((tp, i) => {
          if (i === idx) return;
          tp.city.forEach(card => {
            if (!allowed.has(card.uid)) return;
            if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name)) return;
            const diff = Math.max(0, card.cost - mine.cost);
            const v = card.cost - mine.cost - diff * 0.5 + (i === leaderIdx(state) ? 1.0 : 0);
            if (v > bv) { bv = v; best = card; bt = tp.id; }
          });
        });
        if (!best || bv <= 0.2) return { type: 'ability_skip' };
        return { type: 'choose_district', target: bt, uid: best.uid };
      }
      case 'artist': {
        const sel = (pd.selected || []).slice();
        if (sel.length >= 2 || p.gold <= 1 || sel.length >= p.city.length) {
          return { type: 'artist_done', uids: sel };
        }
        // 选最贵的建筑美化（注意不要修改 pd.selected，由引擎负责记录）
        const cand = p.city.filter(x => !x.beautified && sel.indexOf(x.uid) < 0)
                           .sort((a, b) => b.cost - a.cost);
        if (!cand.length) return { type: 'artist_done', uids: sel };
        return { type: 'choose_district', target: p.id, uid: cand[0].uid };
      }
      case 'navigator_bonus': {
        const needGold = p.hand.some(h => h.cost > p.gold + 4);
        return { type: 'navigator_bonus', mode: (p.gold < 6 || needGold) ? 'gold' : 'cards' };
      }
      case 'scholar_pick': {
        if (!pd.cards || !pd.cards.length) return { type: 'ability_skip' };
        let best = null, bv = -1e9;
        pd.cards.forEach(card => {
          const v = buildValue(state, p, card);
          if (v > bv) { bv = v; best = card; }
        });
        return { type: 'scholar_pick', uid: (best || pd.cards[0]).uid };
      }
      case 'bishop_repay': {
        // 别人代付了建造费，要交出等量的手牌偿还：挑对建造最没用的那几张，且不能用那栋建筑本身
        const need = Math.max(0, pd.amount || 0);
        const pool = p.hand.filter(card => card.uid !== pd.uid)
          .slice().sort((a, b) => buildValue(state, p, a) - buildValue(state, p, b));
        return { type: 'choose_cards', uids: pool.slice(0, need).map(c => c.uid) };
      }
      case 'abbot_declare': {
        // 与修士同构：宗教建筑数决定可领的资源份数，金币够就直接全取金币
        const n = countReligiousBuildings(state, p);
        const cards = (p.gold >= 6 || p.hand.length <= 1) ? Math.min(n, 2) : 0;
        return { type: 'abbot_resource', gold: n - cards, cards: cards };
      }
      case 'monk_declare': {
        const n = countReligiousBuildings(state, p);
        const cards = (p.gold >= 6 || p.hand.length <= 1) ? Math.min(n, 2) : 0;
        return { type: 'monk_resource', gold: n - cards, cards: cards };
      }
      case 'emperor_crown': {
        // 交给建筑最少的对手
        let worst = -1, wv = 1e9;
        state.players.forEach((o, i) => {
          if (i === idx) return;
          const v = o.city.length * 2 + o.gold * 0.3;
          if (v < wv) { wv = v; worst = i; }
        });
        if (worst < 0) worst = (idx + 1) % state.players.length;
        return { type: 'emperor_crown', target: state.players[worst].id };
      }
      case 'emperor_take': {
        const tp = state.players[pd.targetIdx];
        return { type: 'emperor_take', mode: tp.gold >= 2 ? 'gold' : 'card' };
      }
      case 'prophet_give': {
        if (!p.hand.length) return { type: 'ability_skip' };
        let worst = null, wv = 1e9;
        p.hand.forEach(card => {
          const v = buildValue(state, p, card);
          if (v < wv) { wv = v; worst = card; }
        });
        return { type: 'prophet_give', uid: (worst || p.hand[0]).uid };
      }
      case 'draw_keep': {
        if (!pd.cards || !pd.cards.length) return { type: 'ability_skip' };
        let best = null, bv = -1e9;
        pd.cards.forEach(card => {
          const v = buildValue(state, p, card);
          if (v > bv) { bv = v; best = card; }
        });
        return { type: 'draw_keep', uid: (best || pd.cards[0]).uid };
      }
    }
    // 兜底：未知的多步步骤不能返回 end_turn（pending 还在，会被引擎拒绝，
    // 训练里就直接演化成「没有合法行动」报错）。放弃该能力总是安全的。
    return { type: 'ability_skip' };
  }

  return { decide: decide, draftDecision: draftDecision, charValue: charValue, bestBuildCard: bestBuildCard };
});
