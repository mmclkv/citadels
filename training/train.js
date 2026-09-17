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

async function runSelfPlayGame(model, config, gameIndex, rng, shouldStop, evaluator = null, nativeSearch = null) {
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
  const startedAt = Date.now();
  while (state.phase !== 'gameover' && steps < config.maxSteps) {
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
    } else if (useNativeMcts) {
      const nativeResult = await nativeSearch.search(state, actor.id, legal, config.modelVersion || 0);
      piVector = nativeResult.policy;
      mctsValueVector = normalizeValueVector(nativeResult.valueVector, nativeResult.value);
      mctsValue = mctsValueVector[0];
      let r = rng();
      let chosen = Math.max(0, piVector.length - 1);
      for (let i = 0; i < piVector.length; i++) { r -= piVector[i]; if (r <= 0) { chosen = i; break; } }
      decision = { chosen, probability: piVector[chosen], valueVector: mctsValueVector, value: mctsValue,
        entropy: 0, mctsVisits: nativeResult.visits || 0, mctsExpansions: nativeResult.expansions || 0 };
    } else if (config.mctsSimulations > 0) {
      const jsFallbackEvaluator = config.mctsEngine === 'cpp' && config.neuralNetworkFramework === 'libtorch'
        ? null : evaluator;
      const mctsResult = await mcts.search({
        rootState: state,
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
    } else {
      decision = model.choose(encoded.vector, actionVectors, temperature);
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
  return {
    transitions, steps, rounds: state.round, durationMs: Date.now() - startedAt,
    avgInferenceMs: inferenceMs / Math.max(1, steps), fallbackCount, playerCount, charSet,
    networkPlayerCount,
    mctsEngineUsed: config.mctsSimulations > 0 ? (useNativeMcts ? 'cpp' : 'js') : 'none',
    rewards: Array.from(rewards.values()), scores: state.scores.map(s => s.total), winners: winning
  };
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
    batchGames: Math.max(1, Math.min(32, Number(input.batchGames) || 4)),
    ppoEpochs: Math.max(1, Math.min(6, Number(input.ppoEpochs) || 2)),
    miniBatch: Math.max(32, Math.min(2048, Number(input.miniBatch) || 256)),
    workers: Math.max(1, Math.min(6, Number(input.workers) || Math.max(1, Math.min(4, os.cpus().length - 2)))),
    checkpointEvery: Math.max(1, Math.min(10000, Number(input.checkpointEvery) || 100)),
    seed: Math.floor(Number(input.seed) || 20260913),
    maxSteps: Math.max(1000, Math.min(100000, Number(input.maxSteps) || 60000)),
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
  if (config.mctsSimulations > 0) {
    log('MCTS 已启用：每步 ' + config.mctsSimulations + ' 模拟 · c_puct=' + config.mctsC_puct +
      ' · α=' + config.mctsDirichletAlpha + ' · ε=' + config.mctsDirichletEpsilon +
      ' · maxDepth=' + config.mctsMaxDepth +
      ' · 评估器=' + config.mctsEvaluator + '（' +
      (config.mctsEvaluator === 'gpu'
        ? 'GPU 批量 forward 走 PyTorch 桥，批 ' + config.mctsBatchSize + ' · 等待 ' + config.mctsMaxWaitMs + 'ms'
        : 'worker 内 JS 网络同步 forward') + '）');
  } else {
    log('MCTS 未启用，自对弈按网络 softmax 采样');
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
    if (nativeGpuSearch) {
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
    }
    const poolOpts = { root: ROOT, config,
      size: Math.min(config.workers, config.batchGames), onLog: text => log(text) };
    if (config.mctsSimulations > 0 && config.mctsEvaluator === 'gpu') {
      // 若某局未创建原生 worker，JS MCTS 仍通过主进程 PyTorch 桥批量评估。
      poolOpts.batchForward = (stateVectors, actionVectorsList) =>
        torch.batchForward({ stateVectors, actionVectorsList });
      if (!nativeGpuSearch) {
        log('MCTS 评估：worker → torch.batchForward（PyTorch）');
      } else {
        log('MCTS 评估：C++ 规则/MCTS worker 走共享内存 GPU daemon（含新增暗版角色）');
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
  while (completedGames < config.targetGames && !shouldStop()) {
    let results;
    if (pool) {
      const count = Math.min(config.batchGames, config.targetGames - completedGames);
      const indices = Array.from({ length: count }, (_, i) => completedGames + i + 1);
      results = await pool.run(indices, torch.modelPath, completedGames);
    } else {
      const result = await runSelfPlayGame(model, config, completedGames + 1, rng, shouldStop);
      results = (!result || result.stopped) ? [] : [{ gameIndex: completedGames + 1, ...result }];
    }
    if (!results.length) {
      // 收到停止信号就真的停下；否则说明这一批/这一局跑不通（无合法行动、超步数），
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
      recentGames.push(result);
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
    const checkpointDue = completedGames % config.checkpointEvery === 0 || completedGames === config.targetGames;
    let checkpoint = '';
    const elapsedMs = Date.now() - startedAt;
    const recentDuration = recentGames.reduce((sum, g) => sum + g.durationMs, 0) / recentGames.length;
    const recentScore = recentGames.reduce((sum, g) => sum + g.scores.reduce((a, b) => a + b, 0) / g.scores.length, 0) / recentGames.length;
    const recentReward = recentGames.reduce((sum, g) => sum + g.rewards.reduce((a, b) => a + b, 0) / g.rewards.length, 0) / recentGames.length;
    const point = {
      game: completedGames, elapsedMs, steps: totalSteps, policyLoss: losses.policyLoss,
      valueLoss: losses.valueLoss, totalLoss: losses.totalLoss, entropy: losses.entropy,
      clipFraction: losses.clipFraction, approxKl: losses.approxKl || 0, gradientNorm: losses.gradientNorm || 0,
      gpuMemoryMB: losses.gpuMemoryMB || 0,
      gamesPerMinute: (completedGames - initialCompletedGames) / Math.max(1e-6, elapsedMs / 60000),
      avgGameMs: recentDuration, avgInferenceMs: totalInferenceMs / Math.max(1, totalSteps),
      avgScore: recentScore, avgReward: recentReward, fallbacks: totalFallbacks,
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
        ' · avg_reward=' + point.avgReward.toFixed(2) + ' · rounds=' + point.avgRounds.toFixed(1) +
        etaStr);
    }
    if (checkpointDue) {
      checkpoint = saveCheckpoint(model, config, completedGames, history);
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
  resolveNetworkPlayerCount, heuristicLevelFor, nativeMctsSupportsGame,
  sampleHistory, redrawCandidates,
  cloneTrimmed, STATE_SIZE, ACTION_SIZE, VALUE_SLOTS, DATA_DIR
};
