'use strict';

const VALUE_SLOTS = 8;

function asValueVector(value, scalar = 0) {
  const out = new Float32Array(VALUE_SLOTS);
  if (value && typeof value.length === 'number') {
    for (let i = 0; i < Math.min(VALUE_SLOTS, value.length); i++) out[i] = Number(value[i]) || 0;
  } else out[0] = Number(value == null ? scalar : value) || 0;
  return out;
}

/**
 * AlphaZero 风格蒙特卡洛树搜索（MCST/MCTS）。
 *
 * 设计目标：复用现有神经网络的自对弈流水线，在每一步走子前展开若干
 * 模拟，得到一个关于合法动作的访问分布 π，作为 PPO 训练的更稳策略目标。
 *
 * 隐藏信息（不完美信息）：
 *  富饶之城是隐藏信息博弈 —— 对手手牌、牌库顺序、还没打出的角色牌都不可见。
 *  早先的做法是 PIMC：先随机猜一个（或几个）确定的世界，每个世界各建一棵树
 *  搜完，再把几棵树的根访问分布平均起来。它有两个已知毛病：
 *   ① strategy fusion —— 在每个世界里各自最优、平均出来的动作，在真实世界里
 *      可能全线次优（"两个世界各有一手必胜，但不知道在哪个世界"）；
 *   ② 模拟预算被切成 N 份，同一信息集的经验分散在 N 棵树上，谁都攒不起统计量。
 *  现在改成 ISMCTS（Information-Set MCTS）：调用方传入一组「粒子」（若干个与
 *  公开信息一致的确定化世界），**每条模拟按权重抽一个粒子**，而搜索树只有一棵、
 *  按信息集聚合 —— 节点身份是「从视角玩家看可观测的状态」，不是某个具体世界。
 *  于是"猜"不再发生在搜索之前（一次性钉死），而是内含在搜索的每一次展开里。
 *  聚合的合法性由评估层保证：evaluator 先 sanitize(state, playerId) 再编码，
 *  隐藏信息根本不进网络，所以同一信息集节点无论落到哪个粒子上评估都得到同一个
 *  (P, V)。粒子权重目前默认均匀（等价于采样），后续可换成由策略网络算出的
 *  观测似然，把"根据可观测状态推理"接进来而不动搜索结构。
 *
 * 关键约定：
 *  - `node.value` 永远表示「当前轮到该节点玩家时，其期望终局回报」。
 *  - `backup` 做一次坐标系变换：先把叶子的估值折算到根节点玩家（"我"）的视角，
 *    再按每个节点自身的视角写回 W。因此只有跨过「我 / 非我」边界时符号才变，
 *    **不是每上一层就取反**。具体：
 *      W[node] += V × side(叶子行动方) × side(node行动方)
 *    其中 side(x) = x 是根节点玩家 ? +1 : −1。
 *    - 同一玩家在自己回合内连续决策（A→A）不取反。
 *    - 两个不同对手之间（B→C）不取反，等价 paranoid 假设：其余玩家视为一个
 *      联合阵营，`V_我 = −V_对手` 成立。
 *    - 严格解需要价值头输出「每玩家一维」的向量并满足 Σ=0；当前实现是标量近似。
 *  - `node.P`（prior）是神经网络给出的策略 softmax，dim 等于该节点合法动作数。
 *  - 根节点 P 在搜索前混入 Dirichlet 噪声，让开局更具探索性。
 *  - 调用方需要传入：rootState（已克隆）、rootPlayerId、model、
 *    以及 enumerateLegalActions / encodeState / encodeAction / Engine.sanitize。
 *    全部复用 `training/train.js` 已有的导出，避免重复实现。
 *
 *  - 搜索树内的状态快照会掐掉 state.log / state.notices（详见 search-state.js）：
 *    它们引擎只写不读，却是 state 体积的大头，留着纯属给深拷贝交税。
 * - `cloneState` 可注入，默认是掐掉 UI 字段的版本；传普通深拷贝可复现旧行为（测试用）。
 *
 * 接口：
 *   const { pi, value, visits } = mcts.search({
 *     rootState, rootPlayerId, model, Engine,
 *     rootStates: [s0, s1, s2],      // 可选：粒子池（与 rootState 二选一，优先它）
 *     particleWeights: [3, 1, 1],    // 可选：粒子权重，缺省全 1（均匀采样）
 *     infosetKeyFn,                  // 可选：(state, playerId) => string，启用严格信息集
 *                                    //       校验（默认关闭，省下每步一次哈希的开销）
 *     simulate: 200,                 // 模拟次数
 *     cPuct: 1.0,                    // UCB 探索常数
 *     dirichletAlpha: 0.3,           // 根节点 Dirichlet 混合比例，0 表示关闭
 *     dirichletEpsilon: 0.03,        // Dirichlet 浓度（标准 AlphaZero 默认 0.03）
 *     maxDepth: 200,                 // 单次模拟最大深度，避免走不出来的循环
 *     rewardFn: gameRewards,         // 终局真实奖励：state -> Map<playerId, reward>
 *                                    // 传入后终局分支用真实胜负回传；缺省则回传 0
 *     rng: Math.random,
 *   });
 */

function sampleDirichlet(size, alpha, rng) {
  // 生成 Gamma(alpha, 1) 样本后归一化，得到 Dirichlet 分布
  const out = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    let x = 0;
    // Marsaglia & Tsang 2000 — Gamma 抽样的稳定实现
    if (alpha < 1) {
      const u = Math.max(1e-12, rng());
      x = sampleGamma(alpha + 1, rng) * Math.pow(u, 1 / alpha);
    } else {
      x = sampleGamma(alpha, rng);
    }
    out[i] = Math.max(1e-12, x);
    sum += out[i];
  }
  for (let i = 0; i < size; i++) out[i] /= sum;
  return out;
}

function sampleGamma(alpha, rng) {
  if (alpha < 1) return sampleGamma(alpha + 1, rng) * Math.pow(Math.max(rng(), 1e-12), 1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleStandardNormal(rng) {
  // Box-Muller，单次成对抽样的常见实现
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = rng();
  while (u2 === 0) u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// 搜索树里的节点快照一律掐掉 state.log / state.notices：这两个字段引擎只写不读，
// 却占到状态体积的六成以上、且随对局推进单调增长 —— 留着等于让每个节点的深拷贝
// 成本随游戏进程一路走高。详见 ./search-state.js。
const { cloneTrimmed } = require('./search-state.js');
// 增量落子 + 撤销：MCTS 用它试走候选动作并精确还原，避免每个候选一次完整深拷贝。
const { applyRecorded } = require('./undo.js');

function makeNode(playerId, legalActions) {
  return {
    playerId,
    legalActions,             // 由调用方注入；为同一引用，便于复用
    P: null,                  // Float32Array(legalActions.length)
    W: 0,
    WVector: new Float64Array(VALUE_SLOTS),
    N: 0,
    value: 0,                 // 兼容字段：valueVector[0]
    valueVector: new Float32Array(VALUE_SLOTS),
    expanded: false,
    children: new Map(),      // actionIndex (整型) -> Node
    incomingAction: null,     // 走到本节点的动作（根节点为 null）；MCTS 靠重放它还原状态
    parent: null,             // 父节点（根节点为 null）
  };
}

class Search {
  constructor(opts) {
    this.opts = opts;
    this.model = opts.model;
    this.Engine = opts.Engine;
    this.sanitize = opts.sanitize;
    this.legalFn = opts.legalFn;
    this.encodeState = opts.encodeState;
    this.encodeAction = opts.encodeAction;
    this.simulate = Math.max(0, Math.floor(Number(opts.simulate) || 0));
    this.cPuct = Number(opts.cPuct) || 1.0;
    this.dirichletAlpha = Math.max(0, Math.min(1, Number(opts.dirichletAlpha) || 0));
    this.dirichletEpsilon = Number.isFinite(opts.dirichletEpsilon) ? opts.dirichletEpsilon : 0.03;
    this.maxDepth = Math.max(1, Math.floor(Number(opts.maxDepth) || 200));
    // 终局奖励函数：state -> Map<playerId, reward>。传入后才能用真实胜负做回传，
    // 否则终局分支一律回传 0（旧行为）。由 train.js 的 gameRewards 提供。
    this.rewardFn = typeof opts.rewardFn === 'function' ? opts.rewardFn : null;
    this.rng = opts.rng || Math.random;
    // 节点快照的深拷贝实现：默认掐掉 log / notices；注入普通深拷贝即退回旧行为
    this.cloneState = typeof opts.cloneState === 'function' ? opts.cloneState : cloneTrimmed;
    // —— 隐藏信息：粒子池 ——
    // rootStates 优先；只给 rootState 时退化成「单粒子」，行为与改造前逐字一致。
    this.rawParticles = Array.isArray(opts.rootStates) && opts.rootStates.length
      ? opts.rootStates
      : (opts.rootState ? [opts.rootState] : []);
    const weights = Array.isArray(opts.particleWeights) ? opts.particleWeights : null;
    this.particleWeights = this.rawParticles.map((_, i) => {
      const w = Number(weights ? weights[i] : 1);
      return Number.isFinite(w) && w > 0 ? w : 1;
    });
    this.weightTotal = this.particleWeights.reduce((sum, w) => sum + w, 0);
    // 严格信息集校验的注入点：默认关闭（每步一次哈希太贵），测试与调试时打开
    this.infosetKeyFn = typeof opts.infosetKeyFn === 'function' ? opts.infosetKeyFn : null;
    // 软超时：模拟循环里逐条检查，到点就停。以前是「每棵树跑之前检查一次」，现在
    // 只有一棵树，粒度必须落到单条模拟上，否则临场推理就没了 deadline 保护。
    // 停下来的 π 依然可用 —— 它只是访问次数少一些，不是半棵坏树。
    this.deadlineAt = Number.isFinite(Number(opts.deadlineAt)) ? Number(opts.deadlineAt) : 0;
    this.simIndex = -1;
    this.cacheHits = 0;
    this.expansions = 0;
    // 测量用：单次 search 内各 return 路径的模拟计数
    this.simTerminal = 0;       // 走到 gameover 终局
    this.simDepthCapped = 0;    // 撞到 maxDepth 截断
    this.simLeaf = 0;           // 命中未展开叶子（正常 MCTS 叶子）
    this.simOther = 0;          // 无合法动作 / 落子失败等兜底
    this.simReplayFail = 0;     // 重放路径上的动作，在本次抽到的粒子里走不通
    this.simInfoSetMismatch = 0;// 该粒子与节点所属信息集不合，放弃这条模拟
    this.particleDraws = null;  // search() 里初始化：每个粒子被抽中的次数
    // 根节点玩家（"我"）：backup 的视角换算以他为基准，在 search() 开始时注入
    this.rootPlayerId = null;
    this.playerOrder = [];
    this.vectorMode = false;
    // evaluator 抽象层：默认 JsEvaluator 包装当前 model，行为与旧实现一致
    if (opts.evaluator) {
      this.evaluator = opts.evaluator;
    } else {
      const { JsEvaluator } = require('./evaluator.js');
      this.evaluator = new JsEvaluator({
        model: this.model, sanitize: this.sanitize,
        encodeState: this.encodeState, encodeAction: this.encodeAction
      });
    }
  }

  async expand(node, state) {
    if (node.expanded) return;
    const result = await this.evaluator.evaluate(node, state);
    if (result && result.valueVector && typeof result.valueVector.length === 'number') {
      node.valueVector = asValueVector(result.valueVector);
      node.value = node.valueVector[0];
      this.vectorMode = true;
    }
    this.expansions++;
    return result;
  }

  selectUCB(node, parentVisit) {
    // 在 node 的子节点中挑一个；如果有未访问的，优先第一个未访问的（避免冷启动偏向）
    let bestAction = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < node.legalActions.length; i++) {
      const child = node.children.get(i);
      let score;
      if (!child || child.N === 0) {
        // 未访问：返回 PUCT 中的探索项，让首次访问也能被选
        const p = node.P ? node.P[i] : 0;
        score = this.cPuct * p * Math.sqrt(Math.max(parentVisit, 1) / (1 + 0)) * (1 + this.rng() * 1e-3);
      } else {
        const slot = this.vectorMode ? this.relativeSlot(child.playerId, node.playerId) : 0;
        const q = this.vectorMode ? child.WVector[slot] / child.N : child.W / child.N;
        const p = node.P ? node.P[i] : 0;
        const u = this.cPuct * p * Math.sqrt(parentVisit) / (1 + child.N);
        score = q + u;
      }
      if (score > bestScore) { bestScore = score; bestAction = i; }
    }
    return bestAction;
  }

  // 终局状态的真实回报，取该节点行动方的视角（backup 会再换算到根节点视角）。
  // 没有提供 rewardFn 时退化为 0，保持与旧实现一致。
  terminalValue(state, playerId) {
    if (!this.rewardFn) return 0;
    try {
      const rewards = this.rewardFn(state);
      if (!rewards) return 0;
      const value = typeof rewards.get === 'function' ? rewards.get(playerId) : rewards[playerId];
      return Number.isFinite(value) ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  terminalValueVector(state, playerId) {
    const out = new Float32Array(VALUE_SLOTS);
    if (!this.rewardFn) return out;
    try {
      const rewards = this.rewardFn(state);
      if (!rewards) return out;
      const players = state && state.players && state.players.length ? state.players : null;
      const order = players ? players.map(player => player.id) : (this.playerOrder || []);
      if (!order.length) {
        out[0] = this.terminalValue(state, playerId);
        return out;
      }
      const me = order.indexOf(playerId);
      if (me < 0) return out;
      for (let rel = 0; rel < Math.min(VALUE_SLOTS, order.length); rel++) {
        const id = order[(me + rel) % order.length];
        const value = typeof rewards.get === 'function' ? rewards.get(id) : rewards[id];
        out[rel] = Number.isFinite(Number(value)) ? Number(value) : 0;
      }
    } catch (_) { /* malformed reward function remains a zero vector */ }
    return out;
  }

  relativeSlot(perspectiveId, targetId) {
    const n = this.playerOrder.length;
    if (!n) return targetId === perspectiveId ? 0 : 0;
    const perspective = this.playerOrder.indexOf(perspectiveId);
    const target = this.playerOrder.indexOf(targetId);
    if (perspective < 0 || target < 0) return targetId === perspectiveId ? 0 : 0;
    return (target - perspective + n) % n;
  }

  currentValue(node) {
    return this.vectorMode ? node.valueVector : node.value;
  }

  backup(path, value) {
    // path: 从根节点到叶子（含根节点）
    //
    // value 是「叶子行动方视角」的估值。先把它折算到根节点玩家的视角，再按每个
    // 节点自身的视角写回 W。于是符号只在跨过「我 / 非我」边界时翻转：
    //   - 同一玩家连续决策（自己回合内的多步）不翻转
    //   - 两个不同对手之间不翻转（paranoid 假设：其余玩家是一个联合阵营）
    // 旧实现是「每上一层就 value = -value」，在多人局与回合内多步的情况下都会
    // 把符号搞反。
    if (!this.vectorMode || !value || typeof value.length !== 'number') {
      const rootId = this.rootPlayerId;
      const side = playerId => (playerId === rootId ? 1 : -1);
      const leaf = path[path.length - 1];
      const rootValue = Number(value && typeof value.length === 'number' ? value[0] : value) || 0;
      for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i];
        node.W += rootValue * side(leaf.playerId) * side(node.playerId);
        node.N += 1;
      }
      return;
    }
    const leaf = path[path.length - 1];
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      for (let rel = 0; rel < Math.min(VALUE_SLOTS, this.playerOrder.length || VALUE_SLOTS); rel++) {
        const targetId = this.playerOrder.length ? this.playerOrder[(this.playerOrder.indexOf(node.playerId) + rel + this.playerOrder.length) % this.playerOrder.length] : node.playerId;
        const leafSlot = this.relativeSlot(leaf.playerId, targetId);
        node.WVector[rel] += Number(value[leafSlot]) || 0;
      }
      node.N += 1;
      node.W = node.WVector[0];
    }
  }

  /* legacy scalar backup body retained above; vector path returns before this */
  backupLegacyUnused(path, value) {
    const rootId = this.rootPlayerId;
    const side = playerId => (playerId === rootId ? 1 : -1);
    const leaf = path[path.length - 1];
    const rootValue = value * side(leaf.playerId);
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i];
      node.W += rootValue * side(node.playerId);
      node.N += 1;
    }
  }

  /**
   * 按权重抽一个粒子。权重全相等时就是均匀采样（现阶段行为）；后续把权重换成
   * 「策略网络给出的观测似然」，这里一行都不用改 —— 信念的升级不碰搜索结构。
   */
  pickParticleIndex() {
    const pool = (this.particles && this.particles.length ? this.particles : this.rawParticles) || [];
    const n = pool.length;
    if (n <= 1) return 0;
    if (!(this.weightTotal > 0)) return Math.min(n - 1, Math.floor(this.rng() * n));
    let r = this.rng() * this.weightTotal;
    for (let i = 0; i < n; i++) {
      r -= this.particleWeights[i];
      if (r <= 0) return i;
    }
    return n - 1;
  }

  async runOne(root) {
    // 增量落子：整棵搜索树不再为每个节点存一份完整状态快照，而是只保存「走到这里的动作」，
    // 用一份 working 状态从根节点沿路径重放动作来还原当前节点。这样每个模拟只需要 1 次
    // 根快照（cloneState），其余都是原地 apply / 重放，省掉了原先每个新节点一次的深拷贝，
    // 也把内存从「每节点 ~10KB 快照」降到「每节点几个字段」。详情见 training/undo.js。
    //
    // ISMCTS 的关键就在这里：**每条模拟重新抽一个粒子**。世界只在本次模拟里有效，
    // 树节点不属于任何特定世界 —— 它属于信息集。于是「猜」不是搜索前的一次性动作，
    // 而是内含在每一次展开里。
    const particleIndex = this.pickParticleIndex();
    if (this.particleDraws) this.particleDraws[particleIndex]++;
    // 本条模拟的序号：只用它判断节点是不是「本次刚建的」（见下面的信息集校验）
    const simIndex = ++this.simIndex;
    // 池子由 search() 用掐掉 log/notices 的副本填好；直接调 runOne 的调用方（测试桩）
    // 没走 search，这里退回原始粒子 / root.state，保证旧用法照样能跑。
    const pool = (this.particles && this.particles.length ? this.particles : this.rawParticles) || [];
    let working = this.cloneState(pool[particleIndex] || root.state);
    const path = [root];
    let current = root;
    let depth = 0;
    while (depth < this.maxDepth) {
      // 从父节点重放走到 current 的动作（根节点无需重放）
      if (current !== root) {
        const parent = current.parent;
        // 在本次抽到的世界里走这条路径。走不通说明这个粒子与路径不合，放弃这条模拟 ——
        // 硬推下去会把别的世界的统计量写进不属于它的节点里。
        let replayed = false;
        try {
          const applied = this.Engine.applyAction(working, parent.playerId, current.incomingAction);
          replayed = !!(applied && applied.ok);
        } catch (_) { replayed = false; }
        // 信息集校验。只针对「别的模拟留下的节点」：本次刚建的节点用的是同一个粒子，
        // 状态必然一致，再算一次哈希纯属浪费。
        //   廉价版：重放后行动方应与节点记录的一致（几乎免费，始终开着）。
        //   严格版：infosetKeyFn 算出的可观测状态哈希要相等（默认关闭，每步一次哈希太贵）。
        const foreign = current.bornSim !== undefined && current.bornSim !== simIndex;
        let mismatch = false;
        if (foreign) {
          const replayActor = replayed ? this.nextActor(working) : null;
          if (replayed && replayActor && replayActor.id !== current.playerId) mismatch = true;
          if (!mismatch && this.infosetKeyFn && current.infosetKey != null &&
              this.infosetKeyFn(working, current.playerId) !== current.infosetKey) {
            mismatch = true;
          }
        }
        if (!replayed || mismatch) {
          if (!replayed) this.simReplayFail++; else this.simInfoSetMismatch++;
          // 只回传到 current 的父节点：current 在这个粒子下不该被访问，不该被计数。
          // 路径前缀属于同一信息集，照常计数。
          this.backup(path.slice(0, -1), this.currentValue(path[path.length - 2] || current));
          return;
        }
      }
      // 终局判定要放在扩展之前：真实胜负是唯一有监督信号的量，优先级高于网络估值。
      if (working.phase === 'gameover') {
        this.simTerminal++;
        this.backup(path, this.terminalValueVector(working, current.playerId));
        return;
      }
      if (!current.expanded) {
        await this.expand(current, working);
        this.simLeaf++;
        this.backup(path, this.currentValue(current));
        return;
      }
      if (!current.legalActions.length) {
        this.simOther++;
        this.backup(path, this.currentValue(current));
        return;
      }
      const actionIdx = this.selectUCB(current, current.N);
      let child = current.children.get(actionIdx);
      if (!child) {
        // 在 working 上试走该动作（applyRecorded 自动记录并可精确撤销），
        // 拿到后继合法动作后立刻撤销，把 working 还原回 current 的状态。
        const { ok, undo } = applyRecorded(working, current.playerId, current.legalActions[actionIdx]);
        if (!ok) {
          this.simOther++;
          this.backup(path, this.currentValue(current));
          return;
        }
        const actor = this.nextActor(working);
        const nextPlayerId = actor ? actor.id : current.playerId;
        const legalActions = this.legalFn(working, nextPlayerId);
        child = makeNode(nextPlayerId, legalActions);
        child.incomingAction = current.legalActions[actionIdx];
        child.parent = current;
        child.bornSim = simIndex;
        // 记录所属信息集：后续模拟重放到这个节点时会拿它做一致性校验
        if (this.infosetKeyFn) child.infosetKey = this.infosetKeyFn(working, nextPlayerId);
        current.children.set(actionIdx, child);
        undo();
      }
      path.push(child);
      current = child;
      depth++;
    }
    // 走完最大深度还没展开：用当前节点价值兜底
    this.simDepthCapped++;
    this.backup(path, this.currentValue(current));
  }

  // 当前行动方：引擎未导出 currentActor，这里沿用与旧实现一致的逻辑
  // （MCTS 只在 action 阶段被调用，turn 必然存在）。
  nextActor(state) {
    if (this.Engine.currentActor) {
      const a = this.Engine.currentActor(state);
      if (a) return a;
    }
    if (state.turn && typeof state.turn === 'object') return state.players[state.turn.playerIdx];
    return null;
  }

  async search(rootState, rootPlayerId) {
    this.rootPlayerId = rootPlayerId;
    // 粒子池：预先掐掉 log / notices 各存一份，之后每条模拟只要从池里 clone 一个，
    // 不必每次再处理那几十 KB 的 UI 战报。只给了 rootState 时就是单粒子（旧行为）。
    const pool = this.rawParticles.length ? this.rawParticles : (rootState ? [rootState] : []);
    this.particles = pool.map(state => this.cloneState(state));
    this.particleDraws = new Array(this.particles.length).fill(0);
    const seedState = this.particles.length ? this.particles[0] : rootState;
    this.playerOrder = ((seedState && seedState.players) || []).map(player => player.id);
    this.vectorMode = false;
    const rootLegal = this.legalFn(seedState, rootPlayerId);
    if (!rootLegal.length) {
      return { pi: null, value: 0, valueVector: new Float32Array(VALUE_SLOTS), visits: 0, fallback: true, expansions: 0 };
    }
    const root = makeNode(rootPlayerId, rootLegal);
    // 根节点评估用哪个粒子都一样：evaluator 先 sanitize 再编码，隐藏信息不进网络。
    // 这正是「树按信息集聚合」成立的原因。
    root.state = seedState;
    await this.expand(root, seedState);
    // Dirichlet 噪声混合到 priors，仅根节点施加
    if (this.dirichletAlpha > 0 && rootLegal.length > 1 && root.P) {
      const noise = sampleDirichlet(rootLegal.length, Math.max(1e-3, this.dirichletEpsilon), this.rng);
      const alpha = this.dirichletAlpha;
      for (let i = 0; i < rootLegal.length; i++) {
        root.P[i] = (1 - alpha) * root.P[i] + alpha * noise[i];
      }
    }
    this.simTerminal = 0;
    this.simDepthCapped = 0;
    this.simLeaf = 0;
    this.simOther = 0;
    this.simReplayFail = 0;
    this.simInfoSetMismatch = 0;
    let completed = 0;
    for (let sim = 0; sim < this.simulate; sim++) {
      if (this.deadlineAt && Date.now() >= this.deadlineAt) break;
      await this.runOne(root);
      completed++;
    }
    if (this.evaluator.flush) await this.evaluator.flush();
    const pi = new Float32Array(rootLegal.length);
    let total = 0;
    for (const [a, child] of root.children) {
      pi[a] = child.N;
      total += child.N;
    }
    if (total > 0) {
      for (let i = 0; i < pi.length; i++) pi[i] /= total;
    } else {
      // 走到这只能是 simul=0：直接用网络的 P 当作访问分布
      if (root.P) pi.set(root.P); else { for (let i = 0; i < pi.length; i++) pi[i] = 1 / pi.length; }
    }
    const valueVector = new Float32Array(VALUE_SLOTS);
    if (this.vectorMode) {
      for (let i = 0; i < VALUE_SLOTS; i++) valueVector[i] = root.WVector[i] / Math.max(1, root.N);
    } else valueVector[0] = root.W / Math.max(1, root.N);
    return {
      pi,
      value: valueVector[0],
      valueVector,
      visits: total,
      expansions: this.expansions,
      fallback: false,
      rootQ: valueVector[0],
      rootVisitDistribution: Array.from(pi),
      simTerminal: this.simTerminal,
      simDepthCapped: this.simDepthCapped,
      simLeaf: this.simLeaf,
      simOther: this.simOther,
      simReplayFail: this.simReplayFail,
      simInfoSetMismatch: this.simInfoSetMismatch,
      simulations: completed,
      timedOut: !!(this.deadlineAt && Date.now() >= this.deadlineAt),
      particles: this.particles.length,
      particleDraws: this.particleDraws ? this.particleDraws.slice() : [],
    };
  }
}

async function search(opts) {
  const runner = new Search(opts);
  return runner.search(opts.rootState, opts.rootPlayerId);
}

module.exports = { search, Search, sampleDirichlet };
