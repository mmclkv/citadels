'use strict';
// 回归：「从存档读取参数」按钮 —— 按一下就把该存档（checkpoint）里保存的
// 训练配置全部回填到面板上。
//
// 存档由 training/train.js 的 saveCheckpoint 写出，payload 里带着当次训练的
// config（目标局数、MCTS、PPO、阵容、课程…）。按钮走的链路是：
//   public/training.js  →  GET /api/training/checkpoint?name=…  →
//   lib/training-manager.js 的 checkpointConfig()  →  解压 gz 取 payload.config
// 这里同时覆盖两端：服务端真读一个 gz 存档，前端用源码不变量保证字段没漏。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { createTrainingManager } = require('../lib/training-manager.js');

function withTempManager(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-ckpt-config-'));
  try {
    const dataDir = path.join(dir, 'training-data');
    fs.mkdirSync(dataDir, { recursive: true });
    return fn(createTrainingManager({ root: dir }), dataDir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE_CONFIG = {
  targetGames: 200000, minPlayers: 4, maxPlayers: 8, charSet: 'mixed',
  profile: 'large', rulesEngine: 'js', mctsEngine: 'cpp', neuralNetworkFramework: 'libtorch',
  device: 'cuda', endDistricts: 8, maxSteps: 60000, temperatureStart: 1.1, temperatureEnd: 0.65,
  learningRate: 0.0003, batchGames: 32, miniBatch: 256, workers: 2, checkpointEvery: 500,
  seed: 20260917, resumeCheckpoint: '', mctsSimulations: 500, mctsC_puct: 1.2,
  mctsDirichletAlpha: 0.3, mctsDirichletEpsilon: 0.03, mctsMaxDepth: 300, mctsBatchSize: 256,
  mctsMaxWaitMs: 0, mctsCacheSize: 65536, selfPlayMode: 'curriculum', networkPlayerCount: 1,
  heuristicDifficulty: 'hard', curriculumStartPlayers: 1, curriculumEndPlayers: 0,
  curriculumStepGames: 1000, trainNetworkOnly: true
};

test('checkpointConfig 能从真实存档里读出 config 与局数', () => {
  withTempManager((manager, dataDir) => {
    const name = 'checkpoint-000192-pLarge-m500-egpu.json.gz';
    const payload = { createdAt: '2026-09-18T00:09:54.000Z', game: 192, config: SAMPLE_CONFIG, model: { w: [1, 2, 3] } };
    fs.writeFileSync(path.join(dataDir, name), zlib.gzipSync(JSON.stringify(payload)));

    const result = manager.checkpointConfig(name);
    assert.strictEqual(result.name, name, '返回存档名');
    assert.strictEqual(result.game, 192, '返回已训局数');
    assert.strictEqual(result.createdAt, '2026-09-18T00:09:54.000Z', '返回创建时间');
    assert.deepStrictEqual(result.config, SAMPLE_CONFIG, 'config 原样返回，供面板逐项回填');
    assert.ok(!('model' in result), '模型权重不下发（几十 MB 的数组，前端用不上）');
  });
});

test('checkpointConfig 对非法名 / 不存在 / 损坏 / 缺配置的存档给出可读错误', () => {
  withTempManager((manager, dataDir) => {
    // 路径穿越与非法扩展名必须在读盘前被挡掉
    assert.throws(() => manager.checkpointConfig('../../etc/passwd'), /存档名不合法/);
    assert.throws(() => manager.checkpointConfig('checkpoint-1.json'), /存档名不合法/);
    assert.throws(() => manager.checkpointConfig(''), /存档名不合法/);
    assert.throws(() => manager.checkpointConfig('checkpoint-000001.json.gz'), /存档不存在/);

    fs.writeFileSync(path.join(dataDir, 'checkpoint-broken.json.gz'), Buffer.from('not gzip at all'));
    assert.throws(() => manager.checkpointConfig('checkpoint-broken.json.gz'), /无法解析/);

    // 早期版本产物可能只有模型没有 config
    fs.writeFileSync(path.join(dataDir, 'checkpoint-noconfig.json.gz'),
      zlib.gzipSync(JSON.stringify({ game: 5, model: {} })));
    assert.throws(() => manager.checkpointConfig('checkpoint-noconfig.json.gz'), /没有记录训练配置/);
  });
});

test('服务端暴露了读取存档配置的接口，且沿用本机限制', () => {
  const server = read('server.js');
  assert.match(server, /pathname === '\/api\/training\/checkpoint' && req\.method === 'GET'/,
    '需要 GET /api/training/checkpoint');
  assert.match(server, /trainingManager\.checkpointConfig\(/, '路由调用 trainingManager.checkpointConfig');
  assert.match(server, /sendJson\(res, 400, \{ error: error\.message \}\)/, '读失败要回可读错误而不是 500');
});

test('训练页有按钮，并且回填时会刷新派生 UI', () => {
  const html = read('public/training.html');
  assert.match(html, /id="load-checkpoint-config"/, '面板上要有「从存档读取参数」按钮');
  assert.match(html, /id="checkpoint-load-message"/, '按钮下方要有结果提示位');
  assert.match(html, /id="resume-checkpoint"/, '回填的数据源仍是「继续已有训练」的存档下拉框');

  const js = read('public/training.js');
  assert.match(js, /\$\('load-checkpoint-config'\)\.onclick = async/, '按钮必须绑定点击处理');
  assert.match(js, /\.\/api\/training\/checkpoint\?name=/, '必须请求存档配置接口');
  assert.match(js, /function applyCheckpointConfig\(config\)/, '必须定义 applyCheckpointConfig()');

  const fn = js.match(/function applyCheckpointConfig\(config\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'applyCheckpointConfig 必须存在');
  assert.match(fn[0], /updateMctsEvaluatorUI\(\)/, '回填后要刷新评估器提示');
  assert.match(fn[0], /updateCompositionUI\(\)/, '回填后要刷新阵容/课程联动状态');
  assert.match(fn[0], /estimateMCTS\(\)/, '回填后要重算单步耗时估算');
  assert.match(js, /\$\('resume-checkpoint'\)\.onchange = syncCheckpointLoadButton/, '换存档要同步按钮可用状态');
});

test('CONFIG_FIELDS 覆盖 formConfig 提交的每一个字段', () => {
  const js = read('public/training.js');
  const form = js.match(/function formConfig\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(form, '必须能读到 formConfig()');
  const submitted = [...form[0].matchAll(/^\s{4}([A-Za-z_][\w]*):/gm)].map(m => m[1]);
  assert.ok(submitted.length > 25, 'formConfig 字段数应覆盖整张面板，实得 ' + submitted.length);

  const table = js.match(/const CONFIG_FIELDS = \[[\s\S]*?\n\];/);
  assert.ok(table, '必须定义 CONFIG_FIELDS 映射表');
  const mapped = new Set([...table[0].matchAll(/\['([A-Za-z_][\w]*)',\s*'([\w-]+)',\s*'(number|select|bool)'\]/g)].map(m => m[1]));
  const derived = new Set((js.match(/const CONFIG_DERIVED = \[([^\]]*)\]/) || [, ''])[1]
    .split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean));

  const uncovered = submitted.filter(key => !mapped.has(key) && !derived.has(key));
  assert.deepStrictEqual(uncovered, [],
    'formConfig 里这些字段没有对应的回填控件（新增配置项时要同步 CONFIG_FIELDS）：' + uncovered.join(', '));
  const duplicated = [...mapped].filter(key => submitted.filter(k => k === key).length > 1);
  assert.deepStrictEqual(duplicated, [], '映射表里不应有重复键');
  // 每个映射目标 id 都得真实存在于页面上，否则回填时会静默跳过
  const html = read('public/training.html');
  for (const [, , id] of table[0].matchAll(/\['([A-Za-z_][\w]*)',\s*'([\w-]+)',\s*'(?:number|select|bool)'\]/g)) {
    assert.ok(html.includes('id="' + id + '"'), '映射表指向的控件 ' + id + ' 在 training.html 里不存在');
  }
});

test('训练页静态资源版本号已推进（浏览器才会加载新文件）', () => {
  const html = read('public/training.html');
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  const css = Number((html.match(/training\.css\?v=(\d+)/) || [])[1]);
  assert.ok(js >= 17, 'training.js 版本号需推进，当前 ' + js);
  assert.ok(css >= 9, 'training.css 版本号需推进，当前 ' + css);
});

console.log('训练控制台「从存档读取参数」：服务端读取、字段覆盖与按钮接线全部通过');
