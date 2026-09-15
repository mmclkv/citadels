'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { NativeSearchClient } = require('../training/native-search.js');

test('native backend 可完成一局端到端自对弈冒烟', async t => {
  const executable = process.env.CITADELS_NATIVE_SEARCH_WORKER;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER，跳过 native 训练冒烟'); return; }
  const config = {
    backend: 'native', minPlayers: 2, maxPlayers: 2, endDistricts: 1,
    charSet: 'base', seed: 67, targetGames: 1, maxSteps: 2000,
    mctsSimulations: 2, mctsMaxDepth: 16, mctsC_puct: 1
  };
  const client = new NativeSearchClient({ root: path.join(__dirname, '..'), executable,
    simulations: config.mctsSimulations, maxDepth: config.mctsMaxDepth, cPuct: config.mctsC_puct });
  try {
    const model = new (require('../training/neural-policy.js').PolicyValueNetwork)({ profile: 'fast', stateSize: 192, actionSize: 64, seed: config.seed });
    const result = await train.runSelfPlayGame(model, config, 1, () => 0.37, () => false, null, client);
    assert.equal(result.stopped, undefined);
    assert.ok(result.steps > 0);
    assert.ok(Array.isArray(result.transitions));
    assert.equal(result.playerCount, 2);
  } finally {
    client.close();
  }
});
