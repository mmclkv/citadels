'use strict';

const { CHAR_MAP } = require('../src/cards.js');

/**
 * 确定化（determinization）：为不完美信息博弈准备 MCTS 的根局面。
 *
 * 富饶之城的隐藏信息（对手手牌、牌库顺序、未打出的角色牌）直接喂给 MCTS 会让
 * 电脑「偷看」到真牌 —— 那不是策略而是作弊。确定化的做法是：把隐藏部分换成一份
 * 随机猜测，在猜测出的局面上搜索，再把多份猜测的访问分布平均起来选动作。
 * 训练自对弈（training/train.js）与实战神经网络电脑（lib/local-neural-bot.js）
 * 共用本模块，两边搜索看到的信息与人类玩家一致。
 *
 * 本模块只做「打乱 + 按原长度归还」，因此所有公开量严格不变：
 *  - 每位对手的手牌张数、牌库/弃牌堆张数、博物馆张数不变（只换具体内容）；
 *  - 对手「已打出 / 已公开」的角色位置不动，只打乱还没打出的那些槽位；
 *  - 明置移除（draft.faceUp）与回合信息不动，暗置移除与牌池顺序打乱；
 *  - 当前行动者自己的手牌、以及只发给他看的 pending 牌面原样保留（那是他的合法知识）；
 *  - 已经被点名的牌（法师看过的牌、正在结算的墓地牌）钉在原位，
 *    不然猜出来的世界会和已经告诉玩家的公开事实自相矛盾、动作走不通；
 *  - 逮捕令与勒索标记只公开「发给哪几个编号」，哪张是真的按公开集合重新随机指定；
 *  - 叫号队列里「还没叫到的号由谁握有」整条是隐藏信息，所以打乱角色手牌之后
 *    必须按打乱结果重建队列尾部，否则搜索会直接从队列里读到真实归属。
 *
 * 剩余的已知偏差（换取搜索可用性，记录在此以免被误当成严格安全）：
 *  - effects.witchBy / thiefBy 保留真值：它们只在「谁对谁施法/偷窃」的那一回合内被读，
 *    受害者本来就知道来源，随机改写会让引擎的状态恢复逻辑在模拟里走不通。
 *  - 搜索树里由模拟产生的后续事件（例如墓地响应是否发动）按确定化后的局面推进，
 *    与真实分布只在期望上一致 —— 这正是确定化的定义。
 */

function defaultRng() { return Math.random(); }

function deepClone(state) {
  return typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state));
}

function shuffled(values, rng) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function arrayPile(list, pinned) {
  const free = card => !pinned || !pinned.has(card.uid);
  return {
    get: () => list.filter(free),
    // 钉住的牌留在原来的下标上，只把打乱后的其余牌填进空出来的位置
    set: values => {
      let k = 0;
      const next = list.map(card => free(card) ? values[k++] : card);
      list.length = 0;
      next.forEach(card => list.push(card));
    }
  };
}

/**
 * 「已经被点名」的建筑牌：法师看过的牌、正在结算的墓地牌……
 * 引擎已经把这些牌面交给了行动者，属于他的合法知识。它们必须留在原处，否则猜测
 * 出来的世界与已公开的自相矛盾（例如 wizard_take 要求那张牌还在对方手里），
 * 确定化局面里的动作会走不通。
 * 只钉「视角玩家有权看到」的那些：pending 归别人时那些牌面是发给他的，不是发给我的。
 */
function knownCardUids(state, me) {
  const uids = new Set();
  const add = card => { if (card && card.uid) uids.add(card.uid); };
  const t = state.turn;
  if (t && t.pending && t.playerIdx === me) { add(t.pending.card); (t.pending.cards || []).forEach(add); }
  if (state.reaction) add(state.reaction.card);
  if (state.pendingDestroy) add(state.pendingDestroy.card);
  return uids;
}

/** 把若干「隐藏堆」当成一个整体重洗，再按各自原长度归还（数量与可见性都不变）。 */
function redistribute(piles, rng) {
  const active = piles.filter(pile => pile);
  const sizes = active.map(pile => pile.get().length);
  const all = [];
  active.forEach(pile => pile.get().forEach(item => all.push(item)));
  const mixed = shuffled(all, rng);
  let at = 0;
  active.forEach((pile, k) => pile.set(mixed.slice(at, at + sizes[k])));
  return all.length;
}

/** 建筑牌：对手手牌 + 牌库 + 弃牌堆 + 对手博物馆 + 不属于我的抽牌待定区 */
function districtPiles(state, me, pinned) {
  const piles = [];
  state.players.forEach((p, i) => {
    if (i === me) return;
    if (!Array.isArray(p.hand)) p.hand = [];
    piles.push(arrayPile(p.hand, pinned));
    (p.city || []).forEach(card => {
      if (Array.isArray(card.museum) && card.museum.length) piles.push(arrayPile(card.museum, pinned));
    });
  });
  if (!Array.isArray(state.deck)) state.deck = [];
  if (!Array.isArray(state.discard)) state.discard = [];
  piles.push(arrayPile(state.deck, pinned), arrayPile(state.discard, pinned));
  const t = state.turn;
  if (t && t.pending && Array.isArray(t.pending.cards) && t.playerIdx !== me) {
    piles.push(arrayPile(t.pending.cards, pinned));
  }
  return piles;
}

/** 角色牌：对手手里还没打出的那些 + 暗置移除 +（不属于我的）选角牌池 */
function charPiles(state, me) {
  const piles = [];
  state.players.forEach((p, i) => {
    if (i === me) return;
    const played = new Set(p.played || []);
    if (!Array.isArray(p.chars)) p.chars = [];
    const slots = [];
    p.chars.forEach((cid, j) => { if (!played.has(cid)) slots.push(j); });
    if (slots.length) {
      piles.push({
        get: () => slots.map(j => p.chars[j]),
        set: values => { slots.forEach((j, n) => { p.chars[j] = values[n]; }); }
      });
    }
  });
  const d = state.draft;
  if (d) {
    if (!Array.isArray(d.faceDown)) d.faceDown = [];
    piles.push(arrayPile(d.faceDown));
    const step = d.steps && d.steps[d.stepIdx];
    if (step && step.player !== me && Array.isArray(d.pool)) piles.push(arrayPile(d.pool));
  }
  return piles;
}

/**
 * 叫号队列尾部（还没叫到的那些号）整条都是隐藏信息：entry.playerIdx 就是「谁握着这张角色牌」。
 * 打乱对手手牌后必须按打乱结果重建它，否则搜索会拿真实归属推演后面的每一回合。
 * 队列头部（含正在行动的这条）保持不动 —— 谁被叫过、谁被刺杀、谁已经打出，都是公开事实。
 */
function rebuildCallQueue(state) {
  const queue = state.callQueue;
  if (!Array.isArray(queue) || !queue.length) return;
  const keepThrough = Math.min(state.callIdx || 0, queue.length - 1);
  const rest = [];
  state.players.forEach((p, i) => {
    const played = new Set(p.played || []);
    (p.chars || []).forEach(cid => {
      const info = CHAR_MAP[cid];
      if (!info || played.has(cid)) return;
      rest.push({ charId: cid, num: info.num, playerIdx: i });
    });
  });
  rest.sort((a, b) => a.num - b.num);
  state.callQueue = queue.slice(0, keepThrough + 1).concat(rest);
}

/**
 * 「发给哪几个编号」是公开的，「哪个编号才是真的」不是。
 * 真的那个只有布置者本人知道，所以从布置者视角之外都要重新随机指定。
 * candidates 是仍可能被标为真的编号（已被翻开的、已经处理过的都排除了）。
 */
function reGuessSigned(effect, me, candidates, rng) {
  if (!effect || effect.playerIdx === me) return;
  const options = (Array.isArray(candidates) && candidates.length) ? candidates : (effect.nums || []);
  if (!options.length) return;
  effect.signed = options[Math.floor(rng() * options.length)];
}

/**
 * @param {object} state 服务器上的真实局面（不会被修改）
 * @param {string} playerId 视角玩家（神经网络控制的那台电脑）
 * @param {function} rng 可选随机源，注入后结果可复现
 */
function determinize(state, playerId, rng = defaultRng) {
  const clone = deepClone(state);
  const me = (clone.players || []).findIndex(p => p.id === playerId);
  if (me < 0) return clone;
  redistribute(districtPiles(clone, me, knownCardUids(clone, me)), rng);
  redistribute(charPiles(clone, me), rng);
  rebuildCallQueue(clone);
  const warrant = clone.effects && clone.effects.magistrate;
  // claimed 为真时真目标已经在场上公开翻出来了，不能再猜
  if (warrant && !warrant.claimed) reGuessSigned(warrant, me, warrant.nums, rng);
  const threat = clone.effects && clone.effects.blackmailer;
  if (threat && !(threat.revealed || []).some(r => r && r.isReal)) {
    const open = (threat.nums || []).filter(n => !(threat.done || []).includes(n));
    reGuessSigned(threat, me, open, rng);
  }
  // 被勒索的玩家不知道自己中的是不是真标记（pendingPublic 也不给他看），猜测同理
  const pd = clone.turn && clone.turn.pending;
  if (pd && pd.kind === 'blackmailer_threat') pd.signed = rng() < 0.5;
  // 真种子留在服务器：模拟里的后续抽牌只该依赖上面洗好的牌库顺序
  clone.rngState = Math.floor(rng() * 0x100000000) >>> 0;
  return clone;
}

module.exports = { determinize };
