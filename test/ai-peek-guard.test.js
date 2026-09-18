'use strict';

// 偷看守卫：把真实局面套上一层「只有人类看得到的字段」的代理，再让启发式电脑在上面走完整局。
// 电脑一旦读到手牌内容、牌库顺序、叫号归属这类隐藏信息，代理就抛错并记下路径。
// 这个测试保证的是「决策代码拿不到隐藏信息」这件事本身，而不只是某一版启发式刚好没用到。

const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { currentActor } = require('../training/train.js');

const DENY = message => ({ deny: true, message });
const OPAQUE = { opaque: true };
const OPEN = { deny: false };

const rawOf = new WeakMap();

function join(path) { return path.length ? path.join('.') : 'state'; }

/** 某个路径的可见性策略：人类玩家看不到的东西，电脑也看不到。 */
function policy(state, meIdx, path) {
  const [head, second, third] = path;
  if (head === 'callQueue' || head === 'deck' || head === 'discard' || head === 'rngState') {
    return DENY('隐藏牌堆与叫号队列（未叫到的号握在谁手上）');
  }
  if (head === 'players' && second !== meIdx) {
    if (third === 'hand') return OPAQUE;                          // 只许看张数
    if (third === 'chars') return DENY('对手手里还没打出的角色牌');
    if (third === 'city' && path[4] === 'museum') return OPAQUE;   // 博物馆只许看数量
  }
  if (head === 'draft' && (second === 'faceDown' || second === 'pool')) {
    const step = state.draft && state.draft.steps && state.draft.steps[state.draft.stepIdx];
    return step && step.player === meIdx ? OPEN : OPAQUE;
  }
  if (head === 'effects' && (third === 'signed' || third === 'claimed')) {
    return DENY('逮捕令 / 威胁标记里哪一张是真的');
  }
  if (head === 'turn' && second === 'pending') {
    if (third === 'signed') return DENY('真威胁标记（连受害者都不知道中没中）');
    if ((third === 'card' || third === 'cards') && state.turn.playerIdx !== meIdx) {
      return DENY('只发给行动者的牌面');
    }
  }
  return OPEN;
}

function opaqueView(value, path, notes) {
  const size = Array.isArray(value) ? value.length : Object.keys(value).length;
  return new Proxy({}, {
    get(_target, key) {
      // 只许数数量；读内容就记一笔，但仍返回真值，好让一次跑完能列出全部偷看点
      if (key === 'length' || key === 'size' || key === 'count') return size;
      if (typeof key === 'symbol') return undefined;
      notes.add(join(path) + '.<' + String(key) + '>');
      return value[key];
    },
    has(target, key) { return key in value; },
    ownKeys() { notes.add(join(path) + '.<枚举>'); return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(target, key) { return Reflect.getOwnPropertyDescriptor(value, key); }
  });
}

function wrap(value, state, meIdx, path, notes) {
  if (!value || typeof value !== 'object') return value;
  const rule = policy(state, meIdx, path);
  if (rule.deny) {
    notes.add(join(path) + ' —— ' + rule.message);
    return value;
  }
  if (rule.opaque) return opaqueView(value, path, notes);
  const proxy = new Proxy(value, {
    get(target, key) {
      const child = target[key];
      if (!child || typeof child !== 'object') return child;
      // 属性键是字符串，玩家下标要还原成数字，否则「自己」都会被当成对手
      const step = typeof key === 'string' && /^[0-9]+$/.test(key) ? Number(key) : key;
      return wrap(child, state, meIdx, path.concat(step), notes);
    }
  });
  rawOf.set(proxy, value);
  return proxy;
}

function unwrap(value) {
  if (!value || typeof value !== 'object') return value;
  const target = rawOf.get(value);
  return target === undefined ? value : unwrap(target);
}

/**
 * 引擎自己的辅助函数当然要看得到真状态 —— 合法动作清单本来就是它按规则算出来的，
 * 人类玩家看到的也正是这份清单。所以先把代理解包再调用，这样「偷看」只可能出在决策代码里。
 */
function unwrapEngines() {
  const names = ['getAvailableActions', 'sanitize', 'blackmailerValidNums',
    'blackmailerBlockedNums', 'isAbbotProtected', 'computeScores'];
  const originals = {};
  names.forEach(name => {
    originals[name] = Engine[name];
    Engine[name] = function patched() {
      return originals[name].apply(Engine, Array.prototype.slice.call(arguments).map(unwrap));
    };
  });
  return function restore() { names.forEach(name => { Engine[name] = originals[name]; }); };
}

function playGame(seed, seats, notes) {
  const players = [];
  for (let i = 0; i < seats; i++) players.push({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'npc' });
  const state = Engine.createGame({ roomId: 'peek-' + seed, seats: players, endDistricts: 6,
    charSetMode: ['base', 'dark', 'mixed'][seed % 3], seed });
  Engine.startGame(state);
  let guard = 0;
  const kinds = new Set();
  while (state.phase !== 'gameover' && guard++ < 4000) {
    const actor = currentActor(state);
    if (!actor) break;
    const meIdx = state.players.findIndex(p => p.id === actor.id);
    const view = wrap(state, state, meIdx, [], notes);
    const action = AI.decide(view, actor.id);
    if (!action) break;
    kinds.add(action.type);
    const res = Engine.applyAction(state, actor.id, action);
    assert(res.ok, '只用公开信息的电脑仍然要走出合法动作：' + action.type + ' · ' + res.error);
  }
  assert.equal(state.phase, 'gameover', '对局应在限定步数内打完');
  return kinds;
}

function main() {
  const restore = unwrapEngines();
  const notes = new Set();
  let all;
  try {
    all = new Set();
    [[1, 5], [2, 4], [3, 6], [4, 8], [5, 3], [6, 7], [11, 5], [12, 5], [13, 5], [14, 6], [15, 6], [16, 4], [17, 4], [18, 8]].forEach(([seed, seats]) => {
      playGame(seed, seats, notes).forEach(kind => all.add(kind));
    });
  } finally {
    restore();
  }
  // 这些动作类型只有真的决策过才会被检验；缺一个说明样本没覆盖到，守卫等于没测。
  const required = ['draft_pick', 'choose_char', 'choose_district', 'spy_color', 'build',
    'magistrate_signed', 'blackmailer_signed', 'wizard_card', 'take_gold', 'end_turn'];
  const missing = required.filter(kind => !all.has(kind));
  assert(!missing.length, '对局样本里没有出现过这些决策，守卫覆盖不足：' + missing.join('、'));
  assert.equal(notes.size, 0, '启发式电脑读到了人类玩家看不到的信息：\n' +
    Array.from(notes).sort().join('\n'));
  console.log('偷看守卫：' + all.size + ' 类决策全程只用公开信息');
}

main();
