'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { sanitizeConfig } = require('../training/train.js');
const { SelfPlayPool } = require('../training/selfplay-pool.js');

(async () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-selfplay-'));
  const modelPath = path.join(temp, 'model.bin');
  const model = new PolicyValueNetwork({ profile: 'fast', seed: 91 });
  const flat = model.exportFlat();
  fs.writeFileSync(modelPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
  const config = sanitizeConfig({ targetGames: 2, minPlayers: 2, maxPlayers: 2,
    charSet: 'base', profile: 'fast', batchGames: 2, workers: 2, seed: 91, endDistricts: 7 });
  const pool = new SelfPlayPool({ root, config, size: 2 });
  try {
    const started = Date.now();
    const results = await pool.run([1, 2], modelPath, 0);
    assert.strictEqual(results.length, 2, '两个 worker 完成两局并行自对弈');
    assert.ok(results.every(result => result.steps > 0 && result.transitions.length > 10), '每局均生成有效轨迹');
    assert.deepStrictEqual(results.map(result => result.gameIndex), [1, 2], '结果按对局编号稳定排序');
    console.log('并行自对弈池：2 个 worker 完成 2 局，用时 ' + (Date.now() - started) + 'ms');
  } finally {
    await pool.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
