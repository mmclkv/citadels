'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const Engine = require('../src/engine.js');
const HeuristicAI = require('../src/ai.js');
const { PolicyValueNetwork, PROFILES, VALUE_SLOTS, mulberry32 } = require('./neural-policy.js');
const { TorchBridge } = require('./torch-bridge.js');
const { SharedInferenceDaemon } = require('./shared-inference.js');
const { SelfPlayPool } = require('./selfplay-pool.js');
const { cloneTrimmed } = require('./search-state.js');
const { applyRecorded } = require('./undo.js');
const { determinize } = require('./determinize.js');
const { beliefWeights } = require('./belief.js');
const mcts = require('./mcts.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'training-data');
const STATE_SIZE = 672;
const ACTION_SIZE = 256;
const STATE_ENCODING_VERSION = 6;
const ACTION_ENCODING_VERSION = 6;
const ROLE_IDS = ['assassin', 'witch', 'thief', 'magician', 'prophet', 'king', 'emperor', 'noble',
  'bishop', 'monk', 'merchant', 'alchemist', 'businessman', 'architect', 'navigator', 'scholar',
  'warlord', 'diplomat', 'marshal', 'queen', 'artist', 'magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector'];
const PHASE_CODES = { lobby: 0, draft: 1, action: 2, reaction: 3, roundConfirm: 4, gameover: 5 };
const TURN_PHASE_CODES = { main: 0, witch_resume: 1, draw_keep: 2, scholar_pick: 3 };
const PENDING_CODES = {
  assassin: 1, thief: 2, witch_target: 3, magician_choice: 4, magician_swap: 5,
  magician_redraw: 6, warlord_destroy: 7, marshal_seize: 8, artist: 9,
  navigator_bonus: 10, monk_declare: 11, emperor_crown: 12, emperor_take: 13,
  prophet_give: 14, draw_keep: 15, scholar_pick: 16, diplomat_mine: 17,
  diplomat_theirs: 18, magistrate_declare: 19, magistrate_second: 20, magistrate_third: 21,
  blackmailer_declare: 22, blackmailer_second: 23, blackmailer_signed: 24, blackmailer_threat: 25,
  spy_target: 26, spy_color: 27, wizard_target: 28, wizard_card: 29, wizard_choice: 30,
  abbot_declare: 31, tax_collect: 32, bishop_repay: 33
};
const ACTION_TYPES = [
  'ability_skip', 'ability', 'abbot_resource', 'artist_done', 'blackmailer_bribe',
  'blackmailer_refuse', 'blackmailer_signed', 'blackmailer_char', 'build', 'choose_cards', 'choose_char',
  'choose_district', 'choose_player', 'confirm_round', 'draft_discard', 'draft_pick',
  'draw_keep', 'emperor_crown', 'emperor_take', 'end_turn', 'income', 'lab',
  'magician_mode', 'magistrate_signed', 'magistrate_char', 'monk_resource', 'monk_take', 'museum',
  'navigator_bonus', 'pending_back', 'prophet_give', 'reaction', 'scholar_pick',
  'smithy', 'spy_color', 'spy_target', 'take_cards', 'take_gold', 'tax_collect',
  'wizard_build', 'wizard_card', 'wizard_take', 'wizard_target'
];
const IGNORE_KEYS = new Set(['log', 'notices', 'available', 'roomName', 'name', 'label', 'desc', 'resumeToken']);
function nativeMctsSupportsGame(state) {
  return !!state && Array.isArray(state.charDeck) && state.charDeck.every(role => ROLE_IDS.includes(role));
}

function observationContext(view, playerId) {
  const players = view.players || [];
  const meIndex = Math.max(0, players.findIndex(p => p.id === playerId));
  const playerIds = new Map();
  players.forEach((p, i) => playerIds.set(p.id, (i - meIndex + players.length) % players.length));
  const cardIds = new Map();
  const cards = new Map();
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (value.uid) {
      cardIds.set(value.uid, value.id || value.en || value.name || (value.color + ':' + value.cost));
      cards.set(value.uid, value);
    }
    Object.keys(value).forEach(k => { if (!IGNORE_KEYS.has(k)) collect(value[k]); });
  };
  collect(view);
  return { meIndex, playerIds, cardIds, cards };
}

function encodeState(view, playerId) {
  const vector = new Float32Array(STATE_SIZE);
  const context = observationContext(view, playerId);
  const players = view.players || [];
  const count = Math.min(8, players.length);
  const rel = value => value == null || value < 0 || !players.length ? 0 : (value - context.meIndex + players.length) % players.length;
  const phase = PHASE_CODES[view.phase] == null ? 6 : PHASE_CODES[view.phase];
  const turn = view.turn || {};
  const draft = view.draft || {};
  const reaction = view.reaction || {};
  const roundConfirm = view.roundConfirm || {};
  const active = turn.playerIdx != null ? turn.playerIdx :
    reaction.playerIdx != null ? reaction.playerIdx :
    draft.currentPlayer ? players.findIndex(p => p.id === draft.currentPlayer) : -1;
  vector[0] = STATE_ENCODING_VERSION;
  vector[1] = players.length / 8;
  vector[2] = phase / 6;
  vector[3] = (Number(view.round) || 0) / 100;
  vector[4] = rel(active) / 8;
  vector[5] = (Number(view.endDistricts || (view.config && view.config.endDistricts)) || 8) / 12;
  vector[6] = (view.firstToFinish == null || view.firstToFinish < 0) ? 0 : (rel(view.firstToFinish) + 1) / 9;
  vector[7] = (Number(view.deckCount) || 0) / 100;
  vector[8] = (Number(view.discardCount) || 0) / 100;
  vector[9] = (Array.isArray(view.charDeck) ? view.charDeck.length : 0) / 8;
  vector[10] = (Number(view.callIdx) || 0) / 16;
  vector[11] = (Number(draft.stepIdx) || 0) / 32;
  vector[12] = (Number(draft.totalSteps) || 0) / 32;
  vector[13] = draft.currentPlayer ? (rel(players.findIndex(p => p.id === draft.currentPlayer)) + 1) / 9 : 0;
  vector[14] = reaction.playerIdx == null ? 0 : (rel(reaction.playerIdx) + 1) / 9;
  vector[15] = (Array.isArray(roundConfirm.confirmed) ? roundConfirm.confirmed.filter(Boolean).length : 0) / 8;
  vector[16] = turn.pending && turn.pending.targetIdx != null ? (rel(turn.pending.targetIdx) + 1) / 9 : 0;
  vector[17] = turn.pending && turn.pending.fromCrownIdx != null ? (rel(turn.pending.fromCrownIdx) + 1) / 9 : 0;
  vector[18] = turn.pending && PENDING_CODES[turn.pending.kind] ? PENDING_CODES[turn.pending.kind] / 33 : 0;
  vector[19] = (TURN_PHASE_CODES[turn.phase] == null ? 4 : TURN_PHASE_CODES[turn.phase]) / 4;
  vector[20] = (Number(view.turnsCompleted) || 0) / 100;
  vector[21] = turn.takenResources ? 1 : 0;
  vector[22] = turn.incomeTaken ? 1 : 0;
  vector[23] = turn.monkExtraTaken ? 1 : 0;
  vector[24] = turn.abilityUsed ? 1 : 0;
  vector[25] = turn.usedLab ? 1 : 0;
  vector[26] = turn.usedSmithy ? 1 : 0;
  vector[27] = turn.usedMuseum ? 1 : 0;
  vector[28] = turn.bonusDone ? 1 : 0;
  vector[29] = turn.pending && Number(turn.pending.amount || turn.pending.count) ? Number(turn.pending.amount || turn.pending.count) / 8 : 0;
  vector[30] = Number(turn.builds) / 4 || 0;
  vector[31] = Number(turn.spentOnBuild) / 20 || 0;
  // Entity layout: global[0..31], then 8 player slots x 80 dimensions.
  // Every slot is relative to the observing player; missing slots stay zero.
  for (let r = 0; r < 8; r++) {
    const p = r < count ? players[(context.meIndex + r) % players.length] : null;
    const base = 32 + r * 80;
    if (!p) continue;
    const city = p.city || [];
    const colors = new Set(city.map(c => c.color));
    vector[base] = (Number(p.gold) || 0) / 20;
    vector[base + 1] = (Number(p.handCount) || (p.hand || []).length || 0) / 20;
    vector[base + 2] = city.length / Math.max(1, Number(view.endDistricts || (view.config && view.config.endDistricts)) || 8);
    vector[base + 3] = p.hasCrown ? 1 : 0;
    vector[base + 4] = ((context.meIndex + r) % players.length) === active ? 1 : 0;
    vector[base + 5] = p.hasChosen ? 1 : 0;
    vector[base + 6] = p.draftComplete ? 1 : 0;
    vector[base + 7] = p.revealedCharNum == null ? 0 : (Number(p.revealedCharNum) + 1) / 21;
    vector[base + 8] = (p.played || []).length / 3;
    vector[base + 9] = city.reduce((sum, c) => sum + (Number(c.scoreValue) || Number(c.cost) || 0), 0) / 100;
    vector[base + 10] = city.reduce((sum, c) => sum + (Number(c.cost) || 0), 0) / 100;
    vector[base + 11] = colors.size / 5;
    vector[base + 12] = city.filter(c => c.purpleEffect).length / 10;
    vector[base + 13] = city.reduce((sum, c) => sum + (Number(c.museumCount) || 0), 0) / 10;
    vector[base + 14] = city.reduce((sum, c) => sum + (Number(c.beautified) || 0), 0) / 10;
    vector[base + 15] = (p.chars || []).length / 3;
    vector[base + 16] = p.connected === false ? 0 : 1;
    vector[base + 17] = p.isBot ? 1 : 0;
    vector[base + 18] = (Number(p.seat) || 0) / 8;
    vector[base + 19] = ((context.meIndex + r) % players.length) === active && turn.pending && Number(turn.pending.count)
      ? Number(turn.pending.count) / 8 : 0;
    const revealed = Number(p.revealedCharNum);
    if (revealed >= 1 && revealed <= 9) vector[base + 19 + revealed] = 1;
    const exactRoleIndex = ROLE_IDS.indexOf(p.revealedCharId);
    if (exactRoleIndex >= 0) vector[base + 29 + exactRoleIndex] = 1;
    const colorIndex = { yellow: 0, blue: 1, green: 2, red: 3, purple: 4 };
    city.forEach((card, i) => {
      if (i >= 8) return;
      const slot = base + 56 + i * 3;
      vector[slot] = Math.min(1, Math.max(0, Number(card.cost) || 0) / 8);
      vector[slot + 1] = colorIndex[card.color] == null ? 0 : (colorIndex[card.color] + 1) / 5;
      vector[slot + 2] = Math.min(1, Math.max(0, Number(card.scoreValue) || Number(card.cost) || 0) / 10);
    });
  }
  return { vector, context };
}

function encodeAction(action, context) {
  const vector = new Float32Array(ACTION_SIZE);
  vector[0] = ACTION_ENCODING_VERSION;
  const type = String(action && action.type || '');
  const typeIndex = ACTION_TYPES.indexOf(type);
  if (typeIndex >= 0) vector[1 + typeIndex] = 1;
  const targetRel = context && context.playerIds ? context.playerIds.get(action && action.target) : null;
  if (targetRel != null && targetRel >= 0 && targetRel < 8) vector[42 + targetRel] = 1;
  const role = String(action && (action.charId != null ? action.charId : action.name) || '');
  const roleNum = Number(action && action.num) || { assassin: 1, witch: 1, thief: 2, magician: 3, prophet: 3, king: 4, emperor: 4,
    noble: 4, bishop: 5, monk: 5, abbot: 5, merchant: 6, alchemist: 6, businessman: 6,
    architect: 7, navigator: 7, scholar: 7, warlord: 8, diplomat: 8, marshal: 8,
    queen: 9, artist: 9, magistrate: 1, spy: 2, blackmailer: 2, wizard: 3, tax_collector: 9 }[role];
  if (roleNum) vector[50 + roleNum - 1] = 1;
  const exactRoleIndex = ROLE_IDS.indexOf(role);
  if (exactRoleIndex >= 0) vector[68 + exactRoleIndex] = 1;
  const mode = String(action && (action.mode != null ? action.mode : action.effect != null ? action.effect : action.use != null ? (action.use ? 'use' : 'skip') : '') || '');
  const modes = ['gold', 'cards', 'card', 'swap', 'redraw', 'use', 'skip', 'take', 'destroy'];
  const modeIndex = modes.indexOf(mode);
  if (modeIndex >= 0) vector[59 + modeIndex] = 1;
  const card = context && context.cards ? context.cards.get(action && action.uid) : null;
  const cost = card ? Number(card.cost) : NaN;
  if (Number.isFinite(cost)) vector[105] = Math.min(1, Math.max(0, cost / 8));
  const colorIndex = { yellow: 0, blue: 1, green: 2, red: 3, purple: 4 };
  if (action && colorIndex[action.color] != null) vector[95 + colorIndex[action.color]] = 1;
  if (card && colorIndex[card.color] != null) vector[100 + colorIndex[card.color]] = 1;
  if (card) vector[106] = Math.min(1, Math.max(0, (Number(card.scoreValue) || Number(card.cost) || 0) / 10));
  if (Number.isFinite(Number(action && action.num))) vector[107] = Math.max(0, Math.min(1, Number(action.num) / 9));
  if (Number.isFinite(Number(action && action.gold))) vector[108] = Math.max(0, Math.min(1, Number(action.gold) / 20));
  if (Number.isFinite(Number(action && action.cards))) vector[109] = Math.max(0, Math.min(1, Number(action.cards) / 8));
  if (action && action.use != null) vector[110] = action.use ? 1 : 0;
  const selected = Array.isArray(action && action.uids) ? action.uids : [];
  vector[111] = action && action.uid ? 1 : 0;
  vector[112] = action && (action.secondaryUid || action.discardUid || action.cardUid) ? 1 : 0;
  vector[113] = Math.min(1, selected.length / 8);
  // Stable entity-reference slots preserve card identity without hashing arbitrary JSON.
  const uidNumber = uid => {
    const match = String(uid || '').match(/(\d+)$/);
    return match ? Math.min(1, Number(match[1]) / 64) : 0;
  };
  vector[114] = uidNumber(action && action.uid);
  vector[115] = uidNumber(action && (action.secondaryUid || action.discardUid || action.cardUid));
  selected.slice(0, 8).forEach((uid, i) => { vector[116 + i] = uidNumber(uid); });
  normalizeVector(vector);
  return vector;
}

function normalizeVector(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 1) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function redrawCandidates(action, hand) {
  const cards = (hand || []).slice();
  const byCost = cards.slice().sort((a, b) => a.cost - b.cost || String(a.uid).localeCompare(String(b.uid)));
  const out = [{ ...action, uids: [] }];
  if (cards.length) out.push({ ...action, uids: cards.map(c => c.uid) });
  for (let n = 1; n <= Math.min(4, cards.length); n++) {
    out.push({ ...action, uids: byCost.slice(0, n).map(c => c.uid) });
    out.push({ ...action, uids: byCost.slice(-n).map(c => c.uid) });
  }
  return out;
}

function exactCardCandidates(action, hand, count, excludedUid) {
  const cards = (hand || []).filter(card => card.uid !== excludedUid);
  const result = [];
  const selected = [];
  const visit = start => {
    if (selected.length === count) { result.push({ ...action, uids: selected.slice() }); return; }
    for (let i = start; i < cards.length; i++) {
      selected.push(cards[i].uid); visit(i + 1); selected.pop();
    }
  };
  if (count >= 0 && count <= cards.length) visit(0);
  return result;
}

function enumerateLegalActions(state, playerId) {
  const available = Engine.getAvailableActions(state, playerId);
  const player = state.players.find(p => p.id === playerId);
  let candidates = [];
  for (const action of available.actions || []) {
    if (action.disabled) continue;
    if (action.type === 'lab') {
      for (const card of player.hand) candidates.push({ ...action, discardUid: card.uid });
    } else if (action.type === 'museum') {
      for (const card of player.hand) candidates.push({ ...action, cardUid: card.uid });
    } else if (action.type === 'choose_cards' && state.turn && state.turn.pending && state.turn.pending.kind === 'bishop_repay') {
      candidates.push(...exactCardCandidates(action, player.hand, state.turn.pending.amount, state.turn.pending.uid));
    } else if (action.type === 'choose_cards') candidates.push(...redrawCandidates(action, player.hand));
    else candidates.push(clone(action));
  }
  // 增量落子 + 撤销：只拷贝一份 base（掐掉 UI 字段），每个候选在 base 上 apply 后立刻
  // 撤销还原，而不是每个候选都做一次完整深拷贝。分支数越高省得越多（详见 training/undo.js）。
  // base 是 cloneTrimmed 出来的独立副本，applyRecorded 原地修改它、undo 再精确还原，
  // 因此循环结束后 base 与原始 state 逐字节等价（log/notices 始终为空）。
  const base = cloneTrimmed(state);
  candidates = uniqueActions(candidates).filter(action => {
    const { ok, undo } = applyRecorded(base, playerId, action);
    undo();
    return ok;
  });
  if (!candidates.length) {
    try {
      const fallback = HeuristicAI.decide(state, playerId);
      if (fallback) {
        const { ok, undo } = applyRecorded(base, playerId, fallback);
        undo();
        if (ok) candidates.push(fallback);
      }
    } catch (_) { /* surfaced below */ }
  }
  return candidates;
}

/**
 * 搜索用的根局面粒子池：把隐藏信息换成若干份随机猜测（./determinize.js），并要求每份
 * 猜测都复现真局面的合法动作列表 —— π 是按列表下标写进训练样本的，下标错位比不搜索更糟。
 *
 * 所有粒子进同一棵搜索树（ISMCTS）：每条模拟随机挑一份往下走，树按信息集聚合。于是
 * 「猜」不再发生在搜索之前，也不再是「每个世界各建一棵树再平均根访问分布」（PIMC
 * 的 strategy fusion：在每个世界里各自最优、平均出来的那一手在真实世界里可能全线次优）。
 *
 * 每份猜测都必须是「同一个信息集」—— 合法动作列表与真局面逐字一致，否则它描述的根本
 * 不是当前这个公开局面，混进同一棵树会让节点对应上不同的动作下标。所以返回的数组可以
 * 比 count 短，也可以为空：一个粒子都对不上时宁可用纯策略网络走子，也不能把真 state
 * 交给 MCTS（那就是让电脑偷看对手的手牌和牌库）。
 */
function alignedParticlePool(state, playerId, legal, rng, count = 1, attempts = 4) {
  const baseline = JSON.stringify(legal);
  const want = Math.max(1, Number(count) || 1);
  const pool = [];
  for (let i = 0; i < attempts * want && pool.length < want; i++) {
    const guess = determinize(state, playerId, rng);
    const actions = enumerateLegalActions(guess, playerId);
    if (actions.length === legal.length && JSON.stringify(actions) === baseline) {
      pool.push({ state: guess, legal: actions });
    }
  }
  return pool;
}

/** 只要一份猜测的旧接口，供评测脚本与回归测试使用。 */
function alignedDeterminization(state, playerId, legal, rng, attempts = 4) {
  return alignedParticlePool(state, playerId, legal, rng, 1, attempts)[0] || null;
}

/**
 * 粒子池的信念权重。
 *
 * 均匀重洗出来的每个世界在边际上都合法 —— 看不见的牌确实只在对手手里 / 牌库 /
 * 弃牌堆里。但它完全不看对手做了什么：一个玩家攥着 6 块钱却没建任何东西，这种
 * 世界里「他手里恰好有一张 1 费牌」的可能性就该被压下去。见 ./belief.js。
 *
 * 池里只有一份时权重没有意义（单粒子无论权重多少都必被抽中），返回 null。
 */
function particleBeliefWeights(pool, playerId, decay) {
  if (!pool || pool.length < 2) return null;
  return beliefWeights(pool.map(entry => entry.state), playerId, { decay });
}

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    return step ? state.players[step.player] : null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  if (state.roundConfirm) {
    const index = (state.roundConfirm.confirmed || []).findIndex(v => !v);
    return index >= 0 ? state.players[index] : null;
  }
  return state.turn ? state.players[state.turn.playerIdx] : null;
}

function gameRewards(state) {
  const scores = (state.scores || []).slice();
  const rewards = new Map();
  scores.forEach(row => {
    // Competition ranking: tied totals share a rank and the next rank skips
    // the tied places. This is the rank-only terminal protocol used by C++.
    const rank = scores.reduce((count, other) => count + (other.total > row.total ? 1 : 0), 0);
    const rankTerm = scores.length === 1 ? 1 : 1 - 2 * rank / (scores.length - 1);
    rewards.set(state.players[row.playerIdx].id, rankTerm);
  });
  return rewards;
}

function relativeRewardVector(state, perspectiveId, rewards) {
  const out = new Float32Array(VALUE_SLOTS);
  const mask = new Float32Array(VALUE_SLOTS);
  const players = state.players || [];
  const me = players.findIndex(player => player.id === perspectiveId);
  if (me < 0 || !players.length) return { values: out, mask };
  const count = Math.min(VALUE_SLOTS, players.length);
  for (let rel = 0; rel < count; rel++) {
    const player = players[(me + rel) % players.length];
    const value = typeof rewards.get === 'function' ? rewards.get(player.id) : rewards[player.id];
    out[rel] = Number.isFinite(Number(value)) ? Number(value) : 0;
    mask[rel] = 1;
  }
  return { values: out, mask };
}

function normalizeValueVector(valueVector, scalar = 0) {
  const out = new Float32Array(VALUE_SLOTS);
  if (valueVector && typeof valueVector.length === 'number') {
    for (let i = 0; i < Math.min(VALUE_SLOTS, valueVector.length); i++) out[i] = Number(valueVector[i]) || 0;
  } else out[0] = Number(scalar) || 0;
  return out;
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function resolveNetworkPlayerCount(config, gameIndex, playerCount) {
  if (config.selfPlayMode === 'all-network') return playerCount;
  if (config.selfPlayMode === 'network-vs-heuristic') {
    return Math.max(1, Math.min(playerCount, config.networkPlayerCount || 1));
  }
  const start = Math.max(1, Math.min(playerCount, config.curriculumStartPlayers || 1));
  const end = Math.max(start, Math.min(playerCount, config.curriculumEndPlayers || playerCount));
  const stepGames = Math.max(1, config.curriculumStepGames || 1000);
  const stage = Math.floor(Math.max(0, gameIndex - 1) / stepGames);
  return Math.min(end, start + stage);
}

function heuristicLevelFor(config, seatIndex, gameIndex) {
  if (config.heuristicDifficulty !== 'random') return config.heuristicDifficulty;
  const levels = ['easy', 'normal', 'hard'];
  return levels[(Math.abs((config.seed || 0) + gameIndex * 17 + seatIndex * 31) % levels.length)];
}

// 单局回合数上限的默认值；正常自对弈局平均十几到二十几回合结束，留足余量。
const DEFAULT_MAX_ROUNDS = 100;

async function runSelfPlayGame(model, config, gameIndex, rng, shouldStop, evaluator = null, nativeSearch = null) {
  // 超长局几乎都出自规则死循环（实测过 rounds=929 · 31301 步 · 100s 的局），
  // 既吃训练吞吐又抬高内存峰值，到上限就中断这一局并丢弃数据，不等它自己结束。
  const maxRounds = config.maxRounds || DEFAULT_MAX_ROUNDS;
  const playerCount = config.minPlayers + Math.floor(rng() * (config.maxPlayers - config.minPlayers + 1));
  const charSets = config.charSet === 'random' ? ['base', 'dark', 'mixed'] : [config.charSet];
  const charSet = charSets[Math.floor(rng() * charSets.length)];
  const networkPlayerCount = resolveNetworkPlayerCount(config, gameIndex, playerCount);
  const seats = Array.from({ length: playerCount }, (_, i) => {
    const neural = i < networkPlayerCount;
    return { id: (neural ? 'nn-' : 'heuristic-') + gameIndex + '-' + i,
      name: neural ? '神经网络 ' + (i + 1) : '启发式 ' + (i + 1), isBot: true,
      botType: neural ? 'neural' : 'heuristic',
      botLevel: neural ? undefined : heuristicLevelFor(config, i, gameIndex) };
  });
  const state = Engine.createGame({
    roomId: 'training-' + gameIndex, endDistricts: config.endDistricts,
    charSetMode: charSet, seed: config.seed + gameIndex * 7919, seats
  });
  Engine.startGame(state);
  const useNativeMcts = !!nativeSearch && (config.mctsEngine === 'cpp' || config.backend === 'native') &&
    nativeMctsSupportsGame(state);
  const transitions = [];
  let steps = 0, inferenceMs = 0, fallbackCount = 0;
  // 搜索失败（最常见的是 CUDA OOM：6GB 显卡还要和桌面合成器共享显存）不该掀翻
  // 整轮训练 —— 一次失败就丢掉上万局样本太亏（2026-09-19 实测：跑到 6326 局被
  // 一次 OOM 打断，且因为没有存档路径，1h46m 全部作废）。偶发失败降级成均匀
  // 策略继续走；连续失败说明搜索通道真的坏了，才丢弃这一局交给上层判死。
  const SEARCH_FAILURE_LIMIT = 8;
  let searchFailures = 0;
  const handleSearchFailure = error => {
    searchFailures++;
    fallbackCount++;
    console.warn('[train] 第 ' + gameIndex + ' 局：' + steps + ' 步搜索失败，本步改用均匀策略（' +
      String((error && error.message) || error).split('\n')[0] + '）');
    if (searchFailures >= SEARCH_FAILURE_LIMIT) {
      console.warn('[train] 丢弃第 ' + gameIndex + ' 局：连续 ' + searchFailures + ' 步搜索失败');
      return false;
    }
    return true;
  };
  const startedAt = Date.now();
  while (state.phase !== 'gameover' && steps < config.maxSteps && state.round <= maxRounds) {
    if (shouldStop()) break;
    const actor = currentActor(state);
    // 「某一步没有合法行动」是引擎不应出现的死角。以前这里直接抛异常，一次偶发
    // 就把整轮训练打断；现在改成跳过这一局（返回 null），上层会把局数不计、
    // 只打一条警告日志——既不丢整个训练任务，也不至于把这口井完全静音。
    if (!actor) {
      console.warn('[train] 跳过第 ' + gameIndex + ' 局：没有行动玩家（阶段 ' + state.phase + '）');
      return null;
    }
    const legal = enumerateLegalActions(state, actor.id);
    if (!legal.length) {
      console.warn('[train] 跳过第 ' + gameIndex + ' 局：' + actor.name + ' 没有合法行动，' +
        'pending=' + JSON.stringify(state.turn && state.turn.pending) +
        ' reaction=' + JSON.stringify(state.reaction));
      return null;
    }
    const view = Engine.sanitize(state, actor.id);
    const encoded = encodeState(view, actor.id);
    const actionVectors = legal.map(action => encodeAction(action, encoded.context));
    // 搜索只能看人类玩家看得到的信息：把根局面的隐藏部分换成若干份随机猜测（确定化）。
    // 直接把真 state 交给 MCTS（无论 JS 还是 native）等于让电脑看着对手的手牌和牌库
    // 顺序做决策，学到的不是策略而是偷看。详见 ./determinize.js。
    // 粒子是「池」不是「几棵树」：整池交给一次搜索，每条模拟抽一份，共用一棵树。
    const willSearch = actor.botType !== 'heuristic' && (useNativeMcts || config.mctsSimulations > 0);
    const searchPool = willSearch
      ? alignedParticlePool(state, actor.id, legal, rng, config.mctsParticles) : [];
    const searchRoot = searchPool.length ? searchPool[0] : null;
    const searchWeights = config.mctsBelief
      ? particleBeliefWeights(searchPool, actor.id, BELIEF_DECAY) : null;
    if (willSearch && !searchRoot) {
      console.warn('[train] 第 ' + gameIndex + ' 局：' + steps + ' 步的确定化猜测无法复现合法动作列表，' +
        '本步不搜索（阶段 ' + state.phase + ' · 待定 ' +
        JSON.stringify(state.turn && state.turn.pending && state.turn.pending.kind) + '）');
    }
    const t0 = performance.now();
    const temperatureProgress = Math.min(1, gameIndex / Math.max(1, config.targetGames * 0.7));
    const temperature = config.temperatureStart + (config.temperatureEnd - config.temperatureStart) * temperatureProgress;
    let decision;
    let piVector = null;
    let mctsValue = null;
    let mctsValueVector = null;
    if (actor.botType === 'heuristic') {
      const heuristicAction = HeuristicAI.decide(state, actor.id, rng);
      const heuristicKey = heuristicAction && JSON.stringify(heuristicAction);
      let chosen = heuristicKey ? legal.findIndex(action => JSON.stringify(action) === heuristicKey) : -1;
      if (chosen < 0) chosen = 0;
      decision = { chosen, probability: 1 / legal.length, value: 0, entropy: 0 };
    } else if (useNativeMcts && searchRoot) {
      // 整池一起交给 native：那边同样是一条模拟抽一个粒子、共用一棵树。
      let nativeResult = null;
      try {
        nativeResult = await nativeSearch.search(searchPool.map(p => p.state), actor.id,
          searchRoot.legal, config.modelVersion || 0, searchWeights);
      } catch (error) {
        if (!handleSearchFailure(error)) return null;
      }
      if (nativeResult) {
        piVector = nativeResult.policy;
        mctsValueVector = normalizeValueVector(nativeResult.valueVector, nativeResult.value);
        mctsValue = mctsValueVector[0];
        let r = rng();
        let chosen = Math.max(0, piVector.length - 1);
        for (let i = 0; i < piVector.length; i++) { r -= piVector[i]; if (r <= 0) { chosen = i; break; } }
        decision = { chosen, probability: piVector[chosen], valueVector: mctsValueVector, value: mctsValue,
          entropy: 0, mctsVisits: nativeResult.visits || 0, mctsExpansions: nativeResult.expansions || 0 };
      }
    } else if (config.mctsSimulations > 0 && searchRoot) {
      const jsFallbackEvaluator = config.mctsEngine === 'cpp' && config.neuralNetworkFramework === 'libtorch'
        ? null : evaluator;
      let mctsResult = null;
      try {
        mctsResult = await mcts.search({
        // 整池进同一棵树；池里只有一份时与旧的单 rootState 完全等价
        rootStates: searchPool.map(entry => entry.state),
        // 信念权重：与公开事实矛盾的世界少被抽到（null = 均匀采样）
        particleWeights: searchWeights || undefined,
        rootPlayerId: actor.id,
        model,
        Engine,
        sanitize: Engine.sanitize,
        legalFn: enumerateLegalActions,
        rewardFn: gameRewards,
        encodeState,
        encodeAction,
        simulate: config.mctsSimulations,
        cPuct: config.mctsC_puct,
        dirichletAlpha: config.mctsDirichletAlpha,
        dirichletEpsilon: config.mctsDirichletEpsilon != null ? config.mctsDirichletEpsilon : 0.03,
        maxDepth: config.mctsMaxDepth,
        rng,
        evaluator: jsFallbackEvaluator
        });
      } catch (error) {
        if (!handleSearchFailure(error)) return null;
      }
      if (mctsResult) {
        piVector = mctsResult.pi;
        mctsValueVector = normalizeValueVector(mctsResult.valueVector, mctsResult.value);
        mctsValue = mctsValueVector[0];
        // 按访问分布比例抽样；既然分布已含 Dirichlet 噪声，这里不再额外加 temperature
        let r = rng();
        let chosen = Math.max(0, piVector.length - 1);
        for (let i = 0; i < piVector.length; i++) {
          r -= piVector[i];
          if (r <= 0) { chosen = i; break; }
        }
        decision = { chosen, probability: piVector[chosen], valueVector: mctsValueVector, value: mctsValue, entropy: 0,
          mctsVisits: mctsResult.visits, mctsExpansions: mctsResult.expansions };
      }
    } else {
      decision = model.choose(encoded.vector, actionVectors, temperature);
    }
    // 搜索这一步没拿到结果（失败降级）：均匀随机走一步，不写 π 目标 —— 拿假的
    // 访问分布当监督信号比没有更糟。
    if (!decision) {
      const chosen = Math.min(legal.length - 1, Math.floor(rng() * legal.length));
      decision = { chosen, probability: 1 / legal.length, value: 0,
        entropy: Math.log(Math.max(2, legal.length)) };
    }
    inferenceMs += performance.now() - t0;
    if (legal.length > 1 && (actor.botType === 'neural' || !config.trainNetworkOnly)) {
      const transition = {
        playerId: actor.id, state: encoded.vector, actions: actionVectors, chosen: decision.chosen,
        oldProb: decision.probability, oldValue: decision.value,
        oldValueVector: Array.from(normalizeValueVector(decision.valueVector, decision.value)), temperature
      };
      if (piVector) {
        // 序列化为普通数组以便后续 JSON 序列化（MCTS 模式向 GPU 训练侧暴露 π 目标）
        transition.pi = Array.from(piVector);
        transition.mctsValue = mctsValue;
        transition.mctsValueVector = Array.from(normalizeValueVector(mctsValueVector, mctsValue));
      }
      transitions.push(transition);
    }
    let result = Engine.applyAction(state, actor.id, legal[decision.chosen]);
    if (!result.ok) {
      fallbackCount++;
      const fallback = legal.find(action => Engine.applyAction(cloneTrimmed(state), actor.id, action).ok);
      if (!fallback) throw new Error('神经网络选择无法执行且没有兜底行动：' + result.error);
      result = Engine.applyAction(state, actor.id, fallback);
    }
    steps++;
    // Yield periodically so the child process can receive a stop command even
    // during unusually long games instead of waiting for the whole game to end.
    if (steps % 16 === 0) await immediate();
  }
  if (state.phase !== 'gameover') {
    if (shouldStop()) return { stopped: true, transitions: [] };
    if (state.round > maxRounds)
      return { dropped: true, reason: '回合数 ' + state.round + ' 超过上限 ' + maxRounds,
        rounds: state.round, steps, durationMs: Date.now() - startedAt };
    console.warn('[train] 跳过第 ' + gameIndex + ' 局：超过最大步数 ' + config.maxSteps);
    return null;
  }
  const rewards = gameRewards(state);
  transitions.forEach(tr => {
    const target = relativeRewardVector(state, tr.playerId, rewards);
    tr.rewardVector = Array.from(target.values);
    tr.valueMask = Array.from(target.mask);
    tr.reward = target.values[0];
  });
  const winning = state.winner == null ? [] : [state.winner];
  // avg_reward 把同桌所有人的名次分取平均，按构造≈0，看不出课程早期那一名网络
  // 玩家的强弱；这里单独统计网络座位自己的名次分、得分和是否（并列）第一。
  const networkIds = new Set(seats.slice(0, networkPlayerCount).map(seat => seat.id));
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const networkRows = state.scores.filter(row =>
    networkIds.has(state.players[row.playerIdx] && state.players[row.playerIdx].id));
  const rewardOf = row => rewards.get(state.players[row.playerIdx].id) || 0;
  return {
    transitions, steps, rounds: state.round, durationMs: Date.now() - startedAt,
    avgInferenceMs: inferenceMs / Math.max(1, steps), fallbackCount, playerCount, charSet,
    networkPlayerCount,
    networkReward: mean(networkRows.map(rewardOf)),
    networkScore: mean(networkRows.map(row => row.total)),
    // 名次第一的奖励恒为 +1（并列第一同样拿 +1），据此判断是否夺冠
    networkWin: networkRows.some(row => rewardOf(row) >= 1) ? 1 : 0,
    mctsEngineUsed: config.mctsSimulations > 0 ? (useNativeMcts ? 'cpp' : 'js') : 'none',
    rewards: Array.from(rewards.values()), scores: state.scores.map(s => s.total), winners: winning
  };
}

// 每批对局的上限：该值决定单次 PPO 更新的样本量与训练进程的内存峰值。
// 256 局一批约合 12 万条 transition，是这台 8GB 机器上仍安全的量级；
// 超过它的配置会在清洗时被夹到该上限，并由启动横幅显式告知（不再静默改写）。
const MAX_BATCH_GAMES = 256;

// 隐藏信息粒子数上限。粒子共用一棵树、每条模拟抽一份，所以加粒子的代价是「每步多几次
// 深拷贝 + 重洗」，不是「模拟预算被切成几份」—— 这正是 ISMCTS 相对 PIMC 的关键差别。
// 超过 16 之后边际收益很小（同一信息集的统计量已经够密），而确定化开销是线性的。
const MAX_MCTS_PARTICLES = 16;
// 信念强度：粒子每违反一张「他有钱却没建」的牌，权重乘一次这个数。
// 1 = 关掉信念（退回均匀采样）；越小越相信「对手是理性的」。
const BELIEF_DECAY = 0.15;

// 会被 sanitizeConfig 夹逼、且值得在启动时回报给用户的数值配置项。
const ADJUSTED_CONFIG_FIELDS = [
  ['targetGames', '目标局数'], ['batchGames', '每批对局'], ['ppoEpochs', 'PPO 轮数'],
  ['miniBatch', 'GPU 小批量'], ['workers', '并行自对弈进程'], ['maxSteps', '单步上限'],
  ['maxRounds', '单局回合上限'],
  ['checkpointEvery', '每隔多少局存档'], ['learningRate', '学习率'],
  ['temperatureStart', '起始温度'], ['temperatureEnd', '结束温度'],
  ['mctsSimulations', 'MCTS 模拟数'], ['mctsBatchSize', 'MCTS 批量'],
  ['mctsMaxWaitMs', 'MCTS 等待毫秒'], ['mctsMaxDepth', 'MCTS 最大深度'],
  ['mctsCacheSize', 'MCTS 缓存'], ['mctsParticles', 'MCTS 粒子数'],
];

// 列出「用户填了但被 sanitizeConfig 改写过」的数值项，供启动日志回报。
// 纯函数，便于测试：raw 缺省/非数字的项不算改写。
function adjustedConfigFields(rawConfig, config) {
  const changed = [];
  for (const [key, label] of ADJUSTED_CONFIG_FIELDS) {
    const raw = Number(rawConfig ? rawConfig[key] : undefined);
    if (Number.isFinite(raw) && raw !== config[key]) {
      changed.push({ key, label, from: raw, to: config[key] });
    }
  }
  return changed;
}

function sanitizeConfig(input = {}) {
  if (input.rulesEngine === 'cpp') {
    throw new Error('C++ 规则引擎尚未实现完整对局规则；请使用 JS 规则引擎。');
  }
  const minPlayers = Math.max(2, Math.min(8, Number(input.minPlayers) || 4));
  const maxPlayers = Math.max(minPlayers, Math.min(8, Number(input.maxPlayers) || minPlayers));
  const mctsSimulations = Math.max(0, Math.min(10000, Number(input.mctsSimulations) || 0));
  const hasSplitEngines = input.rulesEngine != null || input.mctsEngine != null || input.neuralNetworkFramework != null;
  const rulesEngine = ['js', 'cpp'].includes(input.rulesEngine) ? input.rulesEngine : 'js';
  const mctsEngine = ['js', 'cpp'].includes(input.mctsEngine)
    ? input.mctsEngine : (input.backend === 'native' ? 'cpp' : 'js');
  const neuralNetworkFramework = ['pytorch', 'libtorch'].includes(input.neuralNetworkFramework)
    ? input.neuralNetworkFramework : (input.nativeInferenceBackend === 'libtorch' ? 'libtorch' : 'pytorch');
  const effectiveBackend = hasSplitEngines
    ? (mctsEngine === 'cpp' ? 'native' : 'gpu')
    : (['gpu', 'cpu', 'js', 'native'].includes(input.backend) ? input.backend : 'gpu');
  return {
    targetGames: Math.max(1, Math.min(1000000, Number(input.targetGames) || 10000)),
    minPlayers, maxPlayers,
    charSet: ['base', 'dark', 'mixed', 'random'].includes(input.charSet) ? input.charSet : 'random',
    endDistricts: [7, 8].includes(Number(input.endDistricts)) ? Number(input.endDistricts) : 8,
    profile: PROFILES[input.profile] ? input.profile : 'balanced',
    rulesEngine, mctsEngine, neuralNetworkFramework,
    backend: effectiveBackend,
    device: ['cuda', 'cpu'].includes(input.device)
      ? input.device : (input.backend === 'cpu' ? 'cpu' : 'cuda'),
    nativeSearchWorker: input.nativeSearchWorker ? String(input.nativeSearchWorker) : '',
    nativeInferenceBackend: hasSplitEngines
      ? (neuralNetworkFramework === 'libtorch' ? 'libtorch' : 'python-binary')
      : (['python-binary', 'libtorch'].includes(input.nativeInferenceBackend) ? input.nativeInferenceBackend : 'python-binary'),
    learningRate: Math.max(1e-6, Math.min(0.01, Number(input.learningRate) || 0.0003)),
    batchGames: Math.max(1, Math.min(MAX_BATCH_GAMES, Number(input.batchGames) || 4)),
    ppoEpochs: Math.max(1, Math.min(6, Number(input.ppoEpochs) || 2)),
    miniBatch: Math.max(32, Math.min(2048, Number(input.miniBatch) || 256)),
    workers: Math.max(1, Math.min(6, Number(input.workers) || Math.max(1, Math.min(4, os.cpus().length - 2)))),
    checkpointEvery: Math.max(1, Math.min(10000, Number(input.checkpointEvery) || 100)),
    seed: Math.floor(Number(input.seed) || 20260913),
    maxSteps: Math.max(1000, Math.min(100000, Number(input.maxSteps) || 60000)),
    maxRounds: Math.max(1, Math.min(10000, Number(input.maxRounds) || DEFAULT_MAX_ROUNDS)),
    temperatureStart: Math.max(0.2, Math.min(2, Number(input.temperatureStart) || 1.1)),
    temperatureEnd: Math.max(0.15, Math.min(1.5, Number(input.temperatureEnd) || 0.65)),
    resumeCheckpoint: input.resumeCheckpoint ? path.basename(String(input.resumeCheckpoint)) : '',
    mctsSimulations,
    mctsC_puct: Math.max(0, Math.min(10, Number(input.mctsC_puct) || 1.0)),
    mctsDirichletAlpha: Math.max(0, Math.min(1, Number(input.mctsDirichletAlpha) || 0.3)),
    mctsDirichletEpsilon: Math.max(0.001, Math.min(1, Number(input.mctsDirichletEpsilon) || 0.03)),
    mctsMaxDepth: Math.max(10, Math.min(2000, Number(input.mctsMaxDepth) || 200)),
    mctsEvaluator: hasSplitEngines
      ? (mctsEngine === 'cpp' || neuralNetworkFramework === 'pytorch' ? 'gpu' : 'js')
      : (['js', 'gpu'].includes(input.mctsEvaluator) ? input.mctsEvaluator : 'js'),
    mctsBatchSize: Math.max(1, Math.min(256, Number(input.mctsBatchSize) || 32)),
    // 0 是合法值，表示"不限制等待"（等满批或显式 flush 才发）；仅 undefined/NaN 取默认 1
    mctsMaxWaitMs: Math.max(0, Math.min(50, Number.isFinite(Number(input.mctsMaxWaitMs)) ? Number(input.mctsMaxWaitMs) : 1)),
    mctsCacheSize: Math.max(0, Math.min(1048576, Number(input.mctsCacheSize) || 65536)),
    // 隐藏信息粒子数：整池进同一棵树，每条模拟随机抽一份往下走（ISMCTS）。
    // 1 份 = 退化为改造前的「猜一次钉死一棵树」。
    mctsParticles: clampInteger(input.mctsParticles, 1, MAX_MCTS_PARTICLES, 4),
    // 信念：按公开事实（谁有钱却没建）给粒子加权。关掉就是均匀采样。
    mctsBelief: input.mctsBelief !== false,
    policyLossMode: ['auto', 'ppo', 'mcts_ce'].includes(input.policyLossMode) ? input.policyLossMode : 'auto',
    // 自对弈阵容：默认保持历史行为（所有座位均由策略网络控制）。
    selfPlayMode: ['all-network', 'network-vs-heuristic', 'curriculum'].includes(input.selfPlayMode)
      ? input.selfPlayMode : 'all-network',
    // 0 表示在全网络模式下自动使用所有玩家；固定混合模式下 0 退化为 1。
    networkPlayerCount: clampInteger(input.networkPlayerCount, 0, maxPlayers, 0),
    heuristicDifficulty: ['easy', 'normal', 'hard', 'random'].includes(input.heuristicDifficulty)
      ? input.heuristicDifficulty : 'normal',
    curriculumStartPlayers: clampInteger(input.curriculumStartPlayers, 1, maxPlayers, 1),
    curriculumEndPlayers: clampInteger(input.curriculumEndPlayers, 0, maxPlayers, 0),
    curriculumStepGames: clampInteger(input.curriculumStepGames, 1, 1000000, 1000),
    trainNetworkOnly: input.trainNetworkOnly !== false
  };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}

function sampleHistory(history, limit = 400) {
  if (history.length <= limit) return history.slice();
  const sampled = [];
  for (let i = 0; i < limit; i++) sampled.push(history[Math.round(i * (history.length - 1) / (limit - 1))]);
  return sampled;
}

// 把训练配置里「会影响模型走向」的几个维度拼成可读、ASCII 安全、不带歧义的
// checkpoint 后缀。训练者一眼就能从文件名区分出不同配置的产物：
//   p<profile>    fast / balanced / large，决定网络层宽与深度
//   m<mctsSims>   每步 MCTS 模拟数（0 = 未启用），决定训练目标分布的平滑度
//   e<evaluator>  js / gpu，js 是 worker 内本地网络；gpu 是 PyTorch 批量 forward
//   c<charSet>    random / base / dark / mixed，决定训练分布
//   s<seed>       随机种子，决定初始权重与采样路径
function configTag(config) {
  const profile = PROFILES[config.profile] ? config.profile : 'balanced';
  const mcts = Math.max(0, Math.min(10000, Math.round(Number(config.mctsSimulations) || 0)));
  const evaluator = (config.mctsEvaluator === 'gpu') ? 'gpu' : 'js';
  const charSet = ['base', 'dark', 'mixed', 'random'].includes(config.charSet) ? config.charSet : 'random';
  const seed = Math.floor(Number(config.seed) || 0);
  return ['p' + profile, 'm' + mcts, 'e' + evaluator, 'c' + charSet, 's' + seed].join('-');
}

function saveCheckpoint(model, config, game, history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const name = 'checkpoint-' + String(game).padStart(6, '0') + '-' + configTag(config) + '.json.gz';
  const payload = JSON.stringify({ createdAt: new Date().toISOString(), game, config, model: model.export(), history: sampleHistory(history) });
  atomicWrite(path.join(DATA_DIR, name), zlib.gzipSync(payload, { level: 6 }));
  return name;
}

function loadCheckpoint(model, name) {
  if (!name) return { game: 0, history: [] };
  const file = path.join(DATA_DIR, path.basename(name));
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  model.import(payload.model);
  return { game: Number(payload.game) || 0, history: Array.isArray(payload.history) ? payload.history : [] };
}

function send(message) { if (process.send) process.send(message); else console.log(JSON.stringify(message)); }
// 训练过程中各阶段产出的人读日志。事件流：
//   启动横幅 / 设备 / resume / worker 池 / 进度点 / 策略更新 / 存档 / 异常 / 收尾
// 通过 {type:'log'} 推到 training-manager → UI 右下「事件与错误」面板，
// 同时附加在父进程 stdout 上，方便命令行直接看。
function log(text) {
  const line = '[train] ' + String(text || '');
  send({ type: 'log', text: line });
  if (!process.send) console.log(line);
}
function immediate() { return new Promise(resolve => setImmediate(resolve)); }

async function train(rawConfig, hooks = {}) {
  const config = sanitizeConfig(rawConfig);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const model = new PolicyValueNetwork({ profile: config.profile, stateSize: STATE_SIZE, actionSize: ACTION_SIZE, seed: config.seed });
  const restored = loadCheckpoint(model, config.resumeCheckpoint);
  let completedGames = restored.game;
  const initialCompletedGames = completedGames;
  let stopping = false, pool = null, sharedInference = null;
  process.on('message', msg => {
    if (msg && msg.type === 'stop') { stopping = true; if (pool) pool.stop(); }
  });
  let torch = null, accelerator = { device: 'JavaScript CPU', torch: '', cuda: '', gpu: '' };
  // 启动横幅：让用户在事件日志里一眼确认配置与设备
  log('启动训练：profile=' + config.profile + ' · 玩家 ' + config.minPlayers + '-' + config.maxPlayers +
    ' · 目标 ' + config.targetGames + ' 局 · 每批 ' + config.batchGames + ' 局 · ' +
    'workers=' + config.workers + ' · 策略损失=' + (config.policyLossMode === 'auto' && config.mctsSimulations > 0 ? 'MCTS 交叉熵' : config.policyLossMode.toUpperCase()) +
    ' · epochs=' + config.ppoEpochs + ' · miniBatch=' + config.miniBatch +
    ' · lr=' + config.learningRate + ' · seed=' + config.seed);
  const composition = config.selfPlayMode === 'all-network' ? '全策略网络' :
    config.selfPlayMode === 'network-vs-heuristic'
      ? ('策略网络 ' + (config.networkPlayerCount || 1) + ' 人 + 启发式')
      : ('课程：' + config.curriculumStartPlayers + '→' + (config.curriculumEndPlayers || '全员') +
        '，每 ' + config.curriculumStepGames + ' 局增加 1 人');
  log('自对弈阵容：' + composition + ' · 启发式难度=' + config.heuristicDifficulty +
    ' · 训练样本=' + (config.trainNetworkOnly ? '仅策略网络玩家' : '全部玩家'));
  log('指标说明：avg_reward 是同桌所有人名次奖励的均值，零和所以长期≈0，与网络强弱无关；' +
    '看进步请用「策略网络战力」曲线的 networkReward / 第一率');
  if (config.mctsSimulations > 0) {
    log('MCTS 已启用：每步 ' + config.mctsSimulations + ' 模拟 · c_puct=' + config.mctsC_puct +
      ' · α=' + config.mctsDirichletAlpha + ' · ε=' + config.mctsDirichletEpsilon +
      ' · maxDepth=' + config.mctsMaxDepth +
      ' · 根局面已确定化（搜索看不到对手手牌/牌库顺序）' +
      ' · 粒子=' + config.mctsParticles + '（同一棵树，每条模拟抽一份）' +
      (config.mctsBelief ? ' · 信念加权（按公开事实压低矛盾世界）' : ' · 信念关闭（均匀采样）') +
      ' · 评估器=' + config.mctsEvaluator + '（' +
      (config.mctsEvaluator === 'gpu'
        ? 'GPU 批量 forward 走 PyTorch 桥，批 ' + config.mctsBatchSize + ' · 等待 ' + config.mctsMaxWaitMs + 'ms'
        : 'worker 内 JS 网络同步 forward') + '）');
  } else {
    log('MCTS 未启用，自对弈按网络 softmax 采样');
  }
  // sanitizeConfig 会把越界值夹到合法区间，而且是静默的。用户看到自己填的数
  // 被丢掉会以为「参数根本没生效」（例：每批对局填 64/128 都会被压到上限）。
  // 这里逐项对比原始输入，把被改写的数值项显式写进事件日志。
  for (const item of adjustedConfigFields(rawConfig, config)) {
    log('配置调整：' + item.label + ' ' + item.from + ' 超出可用范围，已按 ' + item.to + ' 执行');
  }
  if (config.resumeCheckpoint) {
    log('从存档继续：' + config.resumeCheckpoint + '（已训 ' + restored.game + ' 局，历史 ' + restored.history.length + ' 帧）');
  }
  if (config.backend !== 'js') {
    torch = new TorchBridge({ root: ROOT, model, config, onLog: text => log('PyTorch: ' + text) });
    accelerator = await torch.start(config.resumeCheckpoint);
    log('训练器已启动：设备=' + accelerator.device + (accelerator.gpu ? ' · 显卡=' + accelerator.gpu : '') +
      (accelerator.torch ? ' · PyTorch ' + accelerator.torch : '') +
      (accelerator.cuda ? ' · CUDA ' + accelerator.cuda : ''));
  } else {
    log('训练器：JavaScript CPU（无 PyTorch 桥）');
  }
  const startedAt = Date.now();
  const rng = mulberry32(config.seed ^ 0xA53C9E11);
  let history = restored.history.slice();
  const recentGames = [];
  const winSeats = Array(8).fill(0);
  let totalSteps = 0, totalInferenceMs = 0, totalFallbacks = 0;
  let rollout = [];
  // 训练批次按“完成的对局数”计数，而不是按 worker 池是否存在计数。
  // worker 一次返回多少局属于并行调度细节，不应覆盖控制台里的 batchGames 配置。
  let gamesSinceUpdate = 0;
  let loggedDarkNativeFallback = false;
  if (torch && !stopping) {
    const nativeGpuSearch = config.mctsEngine === 'cpp' && config.mctsSimulations > 0 && config.mctsEvaluator === 'gpu';
    // LibTorch 直连的 C++ worker 不会收到 sharedMemoryName（native-search.js 显式跳过下发），
    // 起了 daemon 也没人消费，白白多一份 Python+PyTorch 进程和一份 CUDA context。
    // 8GB 内存的机器上这份死重量就是 bad allocation 崩溃现场的一部分。
    const useSharedMemoryDaemon = nativeGpuSearch && config.nativeInferenceBackend !== 'libtorch';
    if (useSharedMemoryDaemon) {
      sharedInference = new SharedInferenceDaemon({
        root: ROOT, modelPath: torch.modelPath, profile: config.profile,
        device: config.device || 'cuda', onLog: log
      });
      try {
        const info = await sharedInference.start();
        config.sharedMemoryName = info.name;
        config.sharedMemorySlots = info.slots;
        config.sharedMemorySlotBytes = info.slotBytes;
      } catch (error) {
        await torch.close();
        throw error;
      }
      log('原生 GPU MCTS：' + config.workers + ' 个 C++ worker → 1 个共享内存 GPU 推理进程');
    } else if (nativeGpuSearch) {
      log('原生 GPU MCTS：' + config.workers + ' 个 C++ worker 走 LibTorch 直连推理，未启动共享内存 daemon');
    }
    const poolOpts = { root: ROOT, config,
      size: Math.min(config.workers, config.batchGames), onLog: text => log(text) };
    if (config.mctsSimulations > 0 && config.mctsEvaluator === 'gpu') {
      // 若某局未创建原生 worker，JS MCTS 仍通过主进程 PyTorch 桥批量评估。
      poolOpts.batchForward = (stateVectors, actionVectorsList) =>
        torch.batchForward({ stateVectors, actionVectorsList });
      if (!nativeGpuSearch) {
        log('MCTS 评估：worker → torch.batchForward（PyTorch）');
      } else if (useSharedMemoryDaemon) {
        log('MCTS 评估：C++ 规则/MCTS worker 走共享内存 GPU daemon（含新增暗版角色）');
      } else {
        log('MCTS 评估：C++ 规则/MCTS worker 走 LibTorch 直连（含新增暗版角色）');
      }
    } else if (config.mctsSimulations > 0) {
      log('MCTS 评估：worker 内本地 JS 网络 forward（mctsEvaluator=js）');
    }
    pool = new SelfPlayPool(poolOpts);
  }
  if (pool) log('Worker 池已起：' + pool.size + ' 个并行自对弈 worker（每批并发跑 ' + config.batchGames + ' 局）');
  const shouldStop = () => stopping || (hooks.shouldStop && hooks.shouldStop());
  send({ type: 'started', config, parameterCount: model.parameterCount, completedGames,
    hardware: { cpu: os.cpus()[0] && os.cpus()[0].model, logicalCores: os.cpus().length,
      memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1), runtime: process.version,
      device: accelerator.device, torch: accelerator.torch, cuda: accelerator.cuda, gpu: accelerator.gpu } });

  try {
  // 连续「一局都跑不出来」的次数：偶发死角跳过就好，连续卡住说明引擎有问题，提前收尾。
  let emptyBatches = 0;
  // 整批自对弈失败（worker 异常退出 / GPU 故障）的连续次数。单批偶发失败跳过即可，
  // 连着几批都不行就是通道坏了，不能再闷头跑下去。
  const MAX_BATCH_FAILURES = 3;
  let batchFailures = 0;
  // 存档不能写成「局数能被 checkpointEvery 整除」：每批 64 局时局数只会落在 64 的
  // 倍数上，100 这样的间隔永远命中不了 —— 2026-09-19 那次跑到 6326 局、1h46m，
  // 一次 OOM 中断后一个存档都没有。改成「距上次存档够 N 局就存」。
  let lastCheckpointGame = completedGames;
  while (completedGames < config.targetGames && !shouldStop()) {
    let results;
    if (pool) {
      const count = Math.min(config.batchGames, config.targetGames - completedGames);
      const indices = Array.from({ length: count }, (_, i) => completedGames + i + 1);
      try {
        results = await pool.run(indices, torch.modelPath, completedGames);
      } catch (error) {
        // 整批失败（worker 崩了、显存被打满）也不该静默：连着几批都跑不出来就
        // 认定通道坏了，把错误抛给下面（那里会先存档再抛）。
        batchFailures++;
        log('第 ' + (completedGames + 1) + ' 批自对弈失败（连续 ' + batchFailures + ' 次）：' +
          String((error && error.message) || error).split('\n')[0]);
        if (batchFailures >= MAX_BATCH_FAILURES) throw error;
        continue;
      }
      batchFailures = 0;
    } else {
      const result = await runSelfPlayGame(model, config, completedGames + 1, rng, shouldStop);
      if (result && result.dropped) log('游戏 #' + (completedGames + 1) + ' ' + result.reason +
        '，已丢弃该局（未计入数据）· ' + result.steps + ' 步 · ' +
        ((result.durationMs || 0) / 1000).toFixed(1) + 's');
      results = (!result || result.stopped || result.dropped) ? [] : [{ gameIndex: completedGames + 1, ...result }];
    }
    if (!results.length) {
      // 收到停止信号就真的停下；否则说明这一批/这一局跑不通（无合法行动、超步数、超回合上限），
      // 记一次数后继续下一局，别让偶发死角把整次训练打断。
      if (shouldStop() || ++emptyBatches > 20) {
        if (emptyBatches > 20) log('连续多局无法跑完，训练提前结束（详见 worker 警告日志）');
        break;
      }
      if (!pool) completedGames++;
      continue;
    }
    emptyBatches = 0;
    for (const result of results) {
      if (!loggedDarkNativeFallback && config.mctsEngine === 'cpp' && result.mctsEngineUsed === 'js') {
        log('本局未启用原生 MCTS worker，已使用 JS MCTS 回退');
        loggedDarkNativeFallback = true;
      }
      completedGames++;
      gamesSinceUpdate++;
      rollout.push(...result.transitions);
      totalSteps += result.steps;
      totalInferenceMs += result.avgInferenceMs * result.steps;
      totalFallbacks += result.fallbackCount;
      result.winners.forEach(seat => { if (seat >= 0 && seat < winSeats.length) winSeats[seat]++; });
      // recentGames 只用来算近期耗时/分数/轮数，必须只留统计量：一局约 300 条
      // 样本（每条 ~6 KB），窗口 50 局就是 ~100 MB —— 旧实现把整个 result（含
      // transitions）塞进来，导致整批训练结束后这 100 MB 仍然常驻。
      recentGames.push({
        gameIndex: result.gameIndex, durationMs: result.durationMs, steps: result.steps,
        playerCount: result.playerCount, rounds: result.rounds,
        scores: result.scores, rewards: result.rewards,
        networkPlayers: result.networkPlayerCount,
        networkReward: result.networkReward, networkScore: result.networkScore,
        networkWin: result.networkWin
      });
      if (recentGames.length > 50) recentGames.shift();
      // 异常局：单局时间显著高于近期均值时打印一次，便于训练者定位慢局
      const SLOW_GAME_FACTOR = 5;
      const slowThreshold = recentGames.length > 1
        ? (recentGames.slice(0, -1).reduce((sum, g) => sum + g.durationMs, 0) / (recentGames.length - 1)) * SLOW_GAME_FACTOR
        : Infinity;
      if (result.durationMs > slowThreshold) {
        log('游戏 #' + result.gameIndex + ' 异常耗时 ' + (result.durationMs / 1000).toFixed(1) + 's · ' +
          result.steps + ' 步 · ' + result.playerCount + ' 人 · rounds=' + result.rounds);
      }
    }
    let losses = history.length ? history[history.length - 1] :
      { policyLoss: 0, valueLoss: 0, totalLoss: 0, entropy: 0, clipFraction: 0, approxKl: 0, gradientNorm: 0 };
    let justTrained = false;
    if (gamesSinceUpdate >= config.batchGames && rollout.length) {
      losses = torch ? await torch.train(rollout) :
        model.trainPPO(rollout, { learningRate: config.learningRate, epochs: config.ppoEpochs, policyLossMode: config.policyLossMode });
      justTrained = true;
      // 打印最近一次策略更新的指标摘要（每批一次），方便在事件日志里看趋势
      log('策略更新（' + (config.policyLossMode === 'auto' && config.mctsSimulations > 0 ? 'MCTS 交叉熵' : config.policyLossMode.toUpperCase()) + '）：策略损失 ' + losses.policyLoss.toExponential(2) +
        ' · 价值损失 ' + Number(losses.valueLoss).toFixed(4) +
        ' · 熵 ' + Number(losses.entropy).toFixed(3) +
        ' · KL ' + Number(losses.approxKl || 0).toFixed(4) +
        ' · 梯度 ' + Number(losses.gradientNorm || 0).toFixed(3) +
        (losses.gpuMemoryMB ? ' · 显存 ' + losses.gpuMemoryMB + ' MB' : ''));
      rollout = [];
      gamesSinceUpdate = 0;
    } else if (gamesSinceUpdate >= config.batchGames) {
      // 本批没有可训练样本时也要消费掉批次数，避免下一批被错误合并。
      gamesSinceUpdate = 0;
    }
    const checkpointDue = completedGames - lastCheckpointGame >= config.checkpointEvery ||
      completedGames === config.targetGames;
    let checkpoint = '';
    const elapsedMs = Date.now() - startedAt;
    const recentDuration = recentGames.reduce((sum, g) => sum + g.durationMs, 0) / recentGames.length;
    const recentScore = recentGames.reduce((sum, g) => sum + g.scores.reduce((a, b) => a + b, 0) / g.scores.length, 0) / recentGames.length;
    const recentReward = recentGames.reduce((sum, g) => sum + g.rewards.reduce((a, b) => a + b, 0) / g.rewards.length, 0) / recentGames.length;
    // 只统计策略网络座位（课程早期是一名人）：avg_reward 是同桌零和均值，掩盖了
    // 网络自身的强弱，networkReward / networkWinRate 才是「有没有变强」的信号。
    const networkGames = recentGames.filter(g => Number.isFinite(g.networkReward));
    const networkMean = key => networkGames.length
      ? networkGames.reduce((sum, g) => sum + (g[key] || 0), 0) / networkGames.length : 0;
    const point = {
      game: completedGames, elapsedMs, steps: totalSteps, policyLoss: losses.policyLoss,
      valueLoss: losses.valueLoss, totalLoss: losses.totalLoss, entropy: losses.entropy,
      clipFraction: losses.clipFraction, approxKl: losses.approxKl || 0, gradientNorm: losses.gradientNorm || 0,
      gpuMemoryMB: losses.gpuMemoryMB || 0,
      gamesPerMinute: (completedGames - initialCompletedGames) / Math.max(1e-6, elapsedMs / 60000),
      avgGameMs: recentDuration, avgInferenceMs: totalInferenceMs / Math.max(1, totalSteps),
      avgScore: recentScore, avgReward: recentReward, fallbacks: totalFallbacks,
      networkReward: networkMean('networkReward'), networkScore: networkMean('networkScore'),
      networkWinRate: networkMean('networkWin'), networkPlayers: Math.round(networkMean('networkPlayers')),
      avgRounds: recentGames.reduce((sum, g) => sum + g.rounds, 0) / recentGames.length,
      winSeats: winSeats.slice(0, config.maxPlayers),
      mctsSimulations: config.mctsSimulations,
      mctsC_puct: config.mctsC_puct,
      mctsDirichletAlpha: config.mctsDirichletAlpha
    };
    history.push(point);
    if (history.length > 800) history = sampleHistory(history, 400);
    // 进度点：每 batch 一次打印一行总览，训练者不用打开 UI 也能看到节奏
    if (justTrained || results.some(r => r.gameIndex % Math.max(1, config.batchGames) === 0)) {
      const pct = (completedGames / config.targetGames * 100).toFixed(1);
      const etaMs = point.gamesPerMinute > 0 ? (config.targetGames - completedGames) / point.gamesPerMinute * 60000 : NaN;
      const etaStr = Number.isFinite(etaMs) ? ' · 预计剩余 ' + Math.round(etaMs / 60000) + ' 分钟' : '';
      log('进度 ' + completedGames + '/' + config.targetGames + ' 局（' + pct + '%）· ' +
        '整局 ' + (point.avgGameMs / 1000).toFixed(2) + 's · 单步 ' + point.avgInferenceMs.toFixed(2) + 'ms · ' +
        point.gamesPerMinute.toFixed(1) + ' 局/分 · avg_score=' + point.avgScore.toFixed(1) +
        ' · avg_reward=' + point.avgReward.toFixed(2) +
        ' · 网络玩家 名次分=' + point.networkReward.toFixed(2) +
        ' 得分=' + point.networkScore.toFixed(1) + ' 第一率=' + Math.round(point.networkWinRate * 100) + '%' +
        ' · rounds=' + point.avgRounds.toFixed(1) +
        etaStr);
    }
    if (checkpointDue) {
      checkpoint = saveCheckpoint(model, config, completedGames, history);
      lastCheckpointGame = completedGames;
      if (torch) await torch.checkpoint(checkpoint);
      const sizeKB = (fs.statSync(path.join(DATA_DIR, checkpoint)).size / 1024).toFixed(0);
      log('存档：' + checkpoint + '（' + sizeKB + ' KB）');
    }
    send({ type: 'progress', point, history: sampleHistory(history), checkpoint });
    if (hooks.onProgress) hooks.onProgress(point);
    await immediate();
  }

  if (rollout.length && !shouldStop()) {
    if (torch) await torch.train(rollout);
    else model.trainPPO(rollout, { learningRate: config.learningRate, epochs: 1, policyLossMode: config.policyLossMode });
  }
  const finalCheckpoint = completedGames > 0 ? saveCheckpoint(model, config, completedGames, history) : '';
  if (torch && finalCheckpoint) await torch.checkpoint(finalCheckpoint);
  const final = { type: shouldStop() ? 'stopped' : 'completed', completedGames,
    targetGames: config.targetGames, elapsedMs: Date.now() - startedAt, checkpoint: finalCheckpoint };
  send(final);
  const elapsedMin = (final.elapsedMs / 60000).toFixed(1);
  const reason = shouldStop() ? '被停止' : '完成';
  log('训练' + reason + '：共 ' + completedGames + ' / ' + config.targetGames + ' 局 · 用时 ' + elapsedMin + ' 分钟 · ' +
    'checkpoint=' + (finalCheckpoint || '(无)'));
  return final;
  } catch (error) {
    // 异常中断也要留档：一次搜索 OOM 打断 1h46m、6000+ 局样本全丢太亏
    // （2026-09-19 实测）。能存就存，存不下也不掩盖真正的错误。
    if (completedGames > 0) {
      try {
        const emergency = saveCheckpoint(model, config, completedGames, history);
        if (torch) await torch.checkpoint(emergency);
        log('训练异常中断，已保存存档：' + emergency + '（共 ' + completedGames + ' 局）');
      } catch (saveError) {
        log('训练异常中断，存档失败：' + String((saveError && saveError.message) || saveError));
      }
    }
    throw error;
  } finally {
    if (pool) await pool.close();
    if (sharedInference) await sharedInference.close();
    if (torch) await torch.close();
  }
}

if (require.main === module) {
  let config = {};
  try { config = JSON.parse(process.env.CITADELS_TRAIN_CONFIG || '{}'); }
  catch (e) { console.error('训练配置不是有效 JSON'); process.exit(2); }
  train(config)
    .then(() => { if (process.disconnect) process.disconnect(); })
    .catch(error => {
      send({ type: 'error', message: error.message, stack: error.stack });
      process.exitCode = 1;
      if (process.disconnect) process.disconnect();
    });
}

module.exports = {
  train, runSelfPlayGame, sanitizeConfig, encodeState, encodeAction,
  STATE_ENCODING_VERSION, ACTION_ENCODING_VERSION, ROLE_IDS, PHASE_CODES, TURN_PHASE_CODES, PENDING_CODES, ACTION_TYPES,
  enumerateLegalActions, currentActor, gameRewards, relativeRewardVector, normalizeValueVector,
  alignedDeterminization, alignedParticlePool, particleBeliefWeights,
  resolveNetworkPlayerCount, heuristicLevelFor, nativeMctsSupportsGame,
  sampleHistory, redrawCandidates,
  cloneTrimmed, STATE_SIZE, ACTION_SIZE, VALUE_SLOTS, DATA_DIR,
  MAX_BATCH_GAMES, MAX_MCTS_PARTICLES, BELIEF_DECAY, adjustedConfigFields
};
