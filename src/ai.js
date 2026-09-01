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

  /* --------------------------- 选角决策 --------------------------- */
  function draftDecision(state, idx) {
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
      v += (Math.random() - 0.5) * (level === 0 ? 4.0 : level === 1 ? 1.2 : 0.25);
      if (v > bv) { bv = v; best = id; }
    });
    return { type: 'draft_pick', charId: best || pool[0] };
  }

  /* --------------------------- 主决策 --------------------------- */
  function decide(state, playerId) {
    const idx = state.players.findIndex(p => p.id === playerId);
    if (idx < 0) return null;
    const p = state.players[idx];
    const level = LEVEL[p.botLevel] != null ? LEVEL[p.botLevel] : 1;

    if (state.phase === 'gameover') return null;
    // 轮末确认战果：电脑确认后等待其他人
    if (state.roundConfirm) {
      return state.roundConfirm.confirmed[idx] ? null : { type: 'confirm_round' };
    }
    if (state.phase === 'draft') return draftDecision(state, idx);

    if (state.reaction) {
      if (state.reaction.playerIdx !== idx) return null;
      const card = state.pendingDestroy ? state.pendingDestroy.card : state.reaction.card;
      const worth = card.cost >= 3 && p.gold >= 2;
      return { type: 'reaction', use: worth };
    }

    const t = state.turn;
    if (!t || t.playerIdx !== idx) return null;

    // ---- 多步能力 ----
    if (t.pending) return pendingDecision(state, idx, t, level);

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
      case 'assassin': case 'thief': case 'witch': case 'magician': return true;
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

  /* ------------------------ 多步能力决策 ------------------------ */
  function pendingDecision(state, idx, t, level) {
    const pd = t.pending;
    const p = state.players[idx];
    const c = CHAR_MAP[t.charId];

    switch (pd.kind) {
      case 'assassin': {
        const pref = { 7: 3.2, 4: 2.6, 6: 2.2, 5: 2.0, 8: 2.4, 3: 1.8, 2: 1.6, 9: 0.8 };
        const leader = leaderIdx(state);
        let best = null, bv = -1;
        state.callQueue.forEach(e => {
          if (e.num === 1 || e.num === t.num) return;
          let v = pref[e.num] != null ? pref[e.num] : 1;
          if (e.playerIdx === leader) v += 1.6;
          if (e.num === 8 && state.players[idx].city.length >= 5) v += 1.0;
          if (e.num === 2 && p.gold >= 5) v += 1.2;
          v += (Math.random() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = e.num; }
        });
        return { type: 'choose_char', num: best != null ? best : 1 };
      }
      case 'thief': {
        let best = null, bv = -1;
        state.callQueue.forEach(e => {
          if (e.num === 1 || e.num === t.num) return;
          if (state.effects.assassinated === e.num) return;
          if (state.effects.bewitched === e.num) return;
          const cc = CHAR_MAP[e.charId];
          let v = 0.6;
          // 收入型角色往往是富人的选择
          if (cc.income) {
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
          v += (Math.random() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = e.num; }
        });
        return { type: 'choose_char', num: best != null ? best : 3 };
      }
      case 'witch_target': {
        const pref = { 7: 3.0, 6: 2.6, 5: 2.4, 4: 2.0, 8: 2.2, 3: 1.6, 2: 1.4, 9: 1.0 };
        let best = null, bv = -1;
        state.callQueue.forEach(e => {
          if (e.num === 1 || e.num === t.num) return;
          let v = pref[e.num] != null ? pref[e.num] : 1;
          v += (Math.random() - 0.5) * (level === 0 ? 2 : 0.5);
          if (v > bv) { bv = v; best = e.num; }
        });
        return { type: 'choose_char', num: best != null ? best : 2 };
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
        let best = null, bv = -1, bestTarget = null;
        state.players.forEach((tp, i) => {
          if (tp.city.length >= state.config.endDistricts) return;
          if (i !== idx && tp.chars.some(x => x === 'bishop') &&
              state.effects.assassinated !== 5 && state.effects.bewitched !== 5) return;
          tp.city.forEach(card => {
            if (card.purple && card.purple.effect === 'immune') return;
            let cost = card.cost - 1 + (card.beautified ? 1 : 0);
            if (tp.city.some(d => d.uid !== card.uid && d.purple && d.purple.effect === 'wallCost')) cost += 1;
            cost = Math.max(0, cost);
            if (cost > p.gold) return;
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
        let best = null, bt = null, bv = -1;
        state.players.forEach((tp, i) => {
          if (i === idx) return;
          if (tp.city.length >= state.config.endDistricts) return;
          tp.city.forEach(card => {
            if (card.cost > 3) return;
            if (card.purple && card.purple.effect === 'immune') return;
            if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name)) return;
            if (card.cost > p.gold) return;
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
        let best = null, bt = null, bv = -1;
        state.players.forEach((tp, i) => {
          if (i === idx) return;
          tp.city.forEach(card => {
            if (card.purple && card.purple.effect === 'immune') return;
            if (p.city.filter(d => d.name === card.name).length >= maxSame(p, card.name)) return;
            const diff = Math.max(0, card.cost - mine.cost);
            if (diff > p.gold) return;
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
      case 'monk_declare': {
        const n = p.city.filter(d => d.color === 'blue').length +
                  p.city.filter(d => d.purple && d.purple.effect === 'anyColorIncome').length;
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
    return { type: 'end_turn' };
  }

  return { decide: decide, draftDecision: draftDecision, charValue: charValue, bestBuildCard: bestBuildCard };
});
