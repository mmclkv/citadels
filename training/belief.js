'use strict';

/**
 * 信念层（belief）：给确定化粒子打权重，让采样服从「看得见的事实」而不是均匀瞎猜。
 *
 * 背景：ISMCTS 只解决了结构问题（树按信息集聚合、每条模拟重采样），但粒子本身
 * 仍是 `training/determinize.js` 的均匀重洗 —— 它在边际分布上是对的（看不见的牌
 * 确实只在对手手里 / 牌库 / 弃牌堆里），却**完全无条件化**：不看对手留了多少钱、
 * 上回合建没建、抽了几张牌。人不会这么猜。
 *
 * 本模块把人真正会做的那条推理写成可计算的约束：
 *
 *   「他手上还有钱、建造次数也没用完，却选择不建造 ⇒ 他手里没有他买得起的牌。」
 *
 * 这是从「他没做的事」反推信息，比任何先验都强。引擎在每个玩家回合结束时把这条
 * 事实记进 `state.observations`（`src/engine.js` 的 recordObservation，只写公开量：
 * 金币 / 手牌张数 / 建造次数 / 角色），本模块负责拿它给每个候选世界扣分。
 *
 * 为什么是软权重而不是硬过滤：
 *   这条推理建立在「对手是理性的」之上，而人确实会为了攒钱建大牌而故意不建小牌。
 *   硬过滤会把真世界直接判死（信念越自信越错得离谱），所以每违反一张就乘一次
 *   decay，让「违反得多」的世界指数级地不被采样，而不是被清零。decay=1 即退回
 *   均匀采样，等于关掉信念 —— 这也是它天然就是一个可 A/B 的开关。
 *
 * 用法：
 *   const weights = beliefWeights(particles, playerId, { decay: 0.15 });
 *   mcts.search({ rootStates: particles, particleWeights: weights, ... });
 */

// 每违反一张「他买得起却没建」的牌，权重乘一次这个数。
// 0.15 是保守起点：1 张违反就把该世界压到 15%，3 张压到 0.3%，但仍不为 0。
const DEFAULT_DECAY = 0.15;

// 权重下限。极端局面下 decay^violations 会下溢成 0，那时整池退化成「永远抽第一个」，
// 比均匀采样更糟。留一个地板保证池里每个世界都还有机会被抽到。
const MIN_WEIGHT = 1e-6;

/**
 * 把 state.observations 翻译成一组与粒子无关的约束。
 * 只依赖公开量，所以整池共用同一份，先算一次即可。
 */
function collectConstraints(observations, viewerIdx) {
  const out = [];
  if (!Array.isArray(observations)) return out;
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i];
    // 视角玩家自己的手牌他自己知道，不需要猜，也就没有可约束的东西
    if (!o || i === viewerIdx) continue;
    if (!(o.gold >= 1)) continue;
    out.push({
      playerIdx: i,
      gold: o.gold,
      handSize: Number(o.handSize) || 0,
      freeColors: Array.isArray(o.freeColors) ? o.freeColors : []
    });
  }
  return out;
}

/**
 * 数一数某个候选世界违反了多少张牌。
 * 单独导出是为了诊断与测试 —— 权重是 decay 的幂，看不出违反了几张。
 */
function countViolations(particle, constraints) {
  let violations = 0;
  for (const c of constraints) {
    const players = particle && particle.players;
    const p = players ? players[c.playerIdx] : null;
    if (!p || !Array.isArray(p.hand) || !p.hand.length) continue;
    const costs = p.hand
      .filter(card => card && !c.freeColors.includes(card.color))
      .map(card => Number(card.cost) || 0)
      .sort((a, b) => a - b);
    // 观测之后新摸到的牌当时还不在他手里，不受这条约束管辖：豁免最便宜的那几张
    // （取最便宜的等于把 penalty 压到最小，是宁可少罚的保守口径）
    const drawn = Math.max(0, p.hand.length - c.handSize);
    for (let i = Math.min(drawn, costs.length); i < costs.length; i++) {
      if (costs[i] <= c.gold) violations++;
    }
  }
  return violations;
}

/**
 * @param {Array<object>} particles 确定化后的候选世界（公开量与真局面一致）
 * @param {string} viewerId 视角玩家的 id（他的手牌是已知量，不参与约束）
 * @param {object} [options] { decay } —— decay=1 表示退回均匀采样
 * @returns {number[]} 与 particles 等长的权重数组（无需归一化，搜索内部自己做）
 */
function beliefWeights(particles, viewerId, options) {
  const opts = options || {};
  const decay = Number.isFinite(opts.decay) ? opts.decay : DEFAULT_DECAY;
  const weights = new Array(particles.length).fill(1);
  if (!particles.length || decay >= 1) return weights;

  const pool = particles[0];
  const viewerIdx = (pool.players || []).findIndex(p => p.id === viewerId);
  const constraints = collectConstraints(pool.observations, viewerIdx);
  // 没有可推理的事实（开局第一回合、或对手都没钱）时老老实实均匀采样
  if (!constraints.length) return weights;

  for (let k = 0; k < particles.length; k++) {
    weights[k] = Math.max(MIN_WEIGHT, Math.pow(decay, countViolations(particles[k], constraints)));
  }
  return weights;
}

/** 诊断用：整池的违反张数分布（日志与测试都靠它确认信念真的起了作用）。 */
function beliefDiagnostics(particles, viewerId) {
  if (!particles.length) return { constraints: 0, violations: [], totalViolations: 0 };
  const pool = particles[0];
  const viewerIdx = (pool.players || []).findIndex(p => p.id === viewerId);
  const constraints = collectConstraints(pool.observations, viewerIdx);
  const violations = particles.map(p => countViolations(p, constraints));
  return {
    constraints: constraints.length,
    violations,
    totalViolations: violations.reduce((sum, v) => sum + v, 0),
    distinct: new Set(violations).size
  };
}

module.exports = { beliefWeights, beliefDiagnostics, countViolations, collectConstraints,
  DEFAULT_DECAY, MIN_WEIGHT };
