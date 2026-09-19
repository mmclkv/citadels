'use strict';

// 搜索失败时 NativeSearchClient 不能把请求留在 pending 里。
//
// 事故现场（2026-09-19 训练日志 training-2026-09-19T10-29-31-191Z.log）：
// native worker 在第 2128 局段错误退出（code=3221225477），之后每一步 search()
// 都往已经销毁的 stdin 上写 → 拿一条 ERR_STREAM_DESTROYED → reject 掉 promise，
// **但 pending 里的那条 waiter 从没被删掉**。waiter 抓着 promise 的 resolve/reject，
// 也就抓着调用方 runSelfPlayGame 的整个 async 帧（一局的 transfers、粒子池、状态）。
// 于是每失败一次就钉住一份，heap 单调上涨，不到两分钟就把 8GB 机器上的 worker
// 吃到 V8 上限（JS heap out of memory），一小时的样本连同这轮训练一起没了。
//
// 这里锁住三件事：
//   1. 任何失败出口都不许在 pending 里留条目
//   2. 子进程没了以后 search() 立即失败，不再往死管道上写
//   3. 卡住不回包的子进程有超时兜底（同样是「waiter 永不结算」的一条来源）

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NativeSearchClient } = require('../training/native-search.js');

const ROOT = path.join(__dirname, '..');
const executable = process.env.CITADELS_NATIVE_SEARCH_WORKER;

function makeClient(overrides = {}) {
  return new NativeSearchClient(Object.assign({
    root: ROOT, executable, simulations: 4, maxDepth: 8, batchSize: 8, cPuct: 1, seed: 11,
    gpuEvaluator: false, device: 'cpu', inferenceBackend: 'python-binary'
  }, overrides));
}

const dummyState = { players: [{ id: 'p0', hand: [] }], phase: 'play', round: 1 };

async function expectFailure(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

test('搜索失败后 pending 必须清空（不准留下已死请求的 waiter）', async t => {
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER'); return; }
  const client = makeClient();
  try {
    // 模拟 worker 崩溃：exit 处理器会 fail 掉在飞的请求，pending 必须归零
    await new Promise(resolve => setTimeout(resolve, 200));
    client.child.kill();
    // 子进程已经没了：这一串 search() 每一步都必须立刻失败
    for (let i = 0; i < 16; i++) {
      const error = await expectFailure(client.search(dummyState, 'p0', [], 0, null));
      assert.ok(error, '第 ' + i + ' 次搜索应当失败');
    }
    assert.equal(client.pending.size, 0,
      'pending 里还剩 ' + client.pending.size + ' 条 waiter —— 每一条都钉着调用方一整帧');
    assert.ok(client.childExited, '子进程退出后必须留下标记，后续请求快速失败');
    assert.ok(client.searchFailureStreak >= 16, '失败应当在 streak 上累计，供上层熔断');
  } finally {
    client.close();
  }
});

test('同一份 client 上反复失败不会让堆随调用次数线性上涨', async t => {
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER'); return; }
  const client = makeClient();
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    client.child.kill();
    const measure = () => {
      if (global.gc) global.gc();
      return process.memoryUsage().heapUsed;
    };
    // 预热一轮，甩掉首次调用加载模块的分配
    for (let i = 0; i < 8; i++) await expectFailure(client.search(dummyState, 'p0', [], 0, null));
    const before = measure();
    // 每份你自己不会爆炸，但它们钉住的东西会：用一个「体积可观」的上下文调用
    for (let i = 0; i < 400; i++) {
      const ballast = new Float32Array(4096).fill(0.5);   // 16KB/次，模拟一局样本的一小片
      await expectFailure(client.search({ ...dummyState, ballast }, 'p0', [], 0, null));
    }
    const after = measure();
    assert.equal(client.pending.size, 0, 'pending 仍必须为空');
    // 400 次 × 16KB = 6.4MB：真漏的话必然撞上这条线；正常超级线程的堆抖动远小于此
    assert.ok(after - before < 4 * 1024 * 1024,
      '400 次失败调用让堆涨了 ' + Math.round((after - before) / 1024) + 'KB，疑似 waiters 泄漏');
  } finally {
    client.close();
  }
});

test('子进程不回包时请求会超时并重启 worker，而不是永久挂着', async t => {
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER'); return; }
  const client = makeClient({ searchTimeoutMs: 250 });
  const firstChild = client.child;
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    // 让它活着但不回：把 stdout 监听摘掉，包永远到不了 waiter
    client.child.stdout.removeAllListeners('data');
    const error = await expectFailure(client.search(dummyState, 'p0', [], 0, null));
    assert.ok(error, '卡死的搜索必须超时失败');
    assert.match(error.message, /超时/);
    assert.equal(client.pending.size, 0, '超时的请求必须从 pending 里摘掉');
    assert.notEqual(client.child, firstChild, '超时后应当换一个 worker 进程');
  } finally {
    client.close();
  }
});

test('成功的请求必须清掉自己的超时定时器（不能过点后重启误杀后续请求）', async t => {
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER'); return; }
  // 事故（2026-09-20 探针实测）：#onData 成功路径先 pending.delete 再调 resolve，
  // 而 #settle 靠 pending.get 找 waiter 清 timer —— 永远查不到。于是每个成功请求
  // 都漏一个活 timer，闭包里钉着整份请求（含粒子池 state）直到超时窗结束；timer
  // 到点还会照常 fire 去 restart 子进程，把当下正在飞的请求全部 reject。
  // 探针 2400 次：修复前 heap 269MB 锯齿漂移 + 37% 请求被误杀；修复后 4.1MB / 0 误杀。
  const Engine = require('../src/engine.js');
  const { enumerateLegalActions } = require('../training/train.js');
  const seats = Array.from({ length: 4 }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, isBot: true, botType: 'heuristic', botLevel: 'normal'
  }));
  const state = Engine.createGame({ roomId: 'leak-timer', endDistricts: 8,
    charSetMode: 'base', seed: 42, seats });
  Engine.startGame(state);
  const legal = Engine.getAvailableActions(state, state.players[0].id).actions;
  assert.ok(legal.length, '测试局面必须有合法动作');

  const client = makeClient({ searchTimeoutMs: 150 });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const childAfterBoot = client.child;
    for (let i = 0; i < 5; i++) {
      const result = await client.search(state, 'p0', legal, 0, null);
      assert.ok(Array.isArray(result.policy) && result.policy.length === legal.length,
        '第 ' + i + ' 次搜索应当成功');
    }
    // 越过超时窗：若 timer 没清，这里会 fire 出 restart，把 child 换掉
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(client.child, childAfterBoot,
      '成功请求的定时器必须被清掉，不能过点后重启子进程');
    assert.equal(client.pending.size, 0, 'pending 仍必须为空');
    // 清干净之后，后续请求必须落在同一个健康进程上
    const result = await client.search(state, 'p0', legal, 0, null);
    assert.ok(Array.isArray(result.policy), '后续请求不应被历史定时器误杀');
  } finally {
    client.close();
  }
});
