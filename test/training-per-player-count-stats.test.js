'use strict';
// 回归：训练控制台的两张图必须按「对局人数」分开统计，不能把不同人数的座位混在一起。
//
// 4 人局的座位 1 和 8 人局的座位 1 不是同一个概念（先手优势、每轮收益、获胜概率
// 都不一样），合并统计出来的曲线只是「这段时间主要在跑几人局」的加权结果；
// 战力的名次分/第一率同理，4 人局拿第一比 8 人局容易得多。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { train, sanitizeConfig } = require('../training/train.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// 跑一次极小规模自对弈，拿每个进度点。backend=js + 无 MCTS 保证测试在秒级完成，
// 也不会起 native worker / PyTorch 子进程。
async function runPoints(config) {
  const points = [];
  const origSend = process.send;
  process.send = () => {};
  try { await train(config, { onProgress: point => points.push(point) }); }
  finally { process.send = origSend; }
  return points;
}

test('每个进度点都带按人数分桶的座位胜局与战力', async () => {
  const config = sanitizeConfig({
    targetGames: 12, batchGames: 4, ppoEpochs: 1, miniBatch: 64,
    minPlayers: 4, maxPlayers: 6, profile: 'fast', backend: 'js',
    seed: 11, checkpointEvery: 100000, workers: 1, mctsSimulations: 0
  });
  const points = await runPoints(config);
  assert.ok(points.length >= 3, '应产出多个进度点，实际 ' + points.length);
  const last = points[points.length - 1];

  const seats = last.winSeatsByPlayers;
  assert.ok(seats && Object.keys(seats).length, 'point 必须有 winSeatsByPlayers');
  const counts = Object.keys(seats).map(Number).sort((a, b) => a - b);
  assert.ok(counts.length >= 2, '12 局里应出现多种人数，实际 ' + counts.join(','));
  for (const n of counts) {
    assert.ok(n >= config.minPlayers && n <= config.maxPlayers, n + ' 人不在配置区间内');
    assert.strictEqual(seats[n].wins.length, n, n + ' 人局的胜局数组长度应等于人数');
    assert.ok(seats[n].wins.every(v => Number.isFinite(v) && v >= 0), n + ' 人局的胜局必须是非负计数');
  }
  // 每个桶各自计数，合计应等于已完成的局数（并列第一会让胜局总数略多，只做下界校验）
  const totalGames = counts.reduce((sum, n) => sum + seats[n].games, 0);
  assert.strictEqual(totalGames, last.game, '各人数桶的局数合计应等于已完成局数');

  const network = last.networkByPlayers;
  assert.ok(network && Object.keys(network).length, 'point 必须有 networkByPlayers');
  for (const key of Object.keys(network)) {
    const bucket = network[key];
    assert.ok(Number(bucket.games) > 0, key + ' 人桶应有对局数');
    assert.ok(Number.isFinite(bucket.reward), key + ' 人名次分必须是数值');
    assert.ok(bucket.winRate >= 0 && bucket.winRate <= 1, key + ' 人第一率应在 0~1');
  }
  // 战力是按人数分窗口的：不同人数的取值不应被强行平均成同一个数
  const numKeys = Object.keys(network);
  assert.ok(numKeys.length >= 2, '12 局里应出现多种人数（战力分桶），实际 ' + numKeys.join(','));
});

test('train.js 不再导出合并人数 winSeats', () => {
  const trainJs = read('training/train.js');
  assert.doesNotMatch(trainJs, /winSeats:\s*winSeats/, '不应再下发跨人数合并的 winSeats 数组');
  assert.match(trainJs, /winSeatsByPlayers:\s*seatStatsByPlayers/, '应下发按人数分桶的座位胜局');
  assert.match(trainJs, /networkByPlayers/, '应下发按人数分桶的战力');
});

test('控制台：座位图按人数分组，战力拆成两张按人数分线的图', () => {
  const html = read('public/training.html');
  assert.match(html, /<canvas id="seat-chart"><\/canvas>/, '座位图 canvas 仍在');
  assert.match(html, /<canvas id="network-reward-chart"><\/canvas>/, '需要名次分图');
  assert.match(html, /<canvas id="network-win-chart"><\/canvas>/, '需要第一率图');
  assert.doesNotMatch(html, /network-chart"/, '旧的单张合并战力图应已移除');
  assert.match(html, /chart-panel wide/, '座位图分组后更宽，应跨两列');

  const js = read('public/training.js');
  assert.match(js, /function drawSeatGroups\(canvas, groups\)/, '需要按人数分组的座位图');
  assert.match(js, /function seatGroups\(byPlayers\)/, '需要把 winSeatsByPlayers 转成分组数据');
  assert.doesNotMatch(js, /function drawBars\(/, '旧的合并座位图函数应已删除');
  // 战力曲线：一个人数一条线，取值走 pick(row) 而不是扁平字段
  // （不写死缩进：格式化随时可能变，抓的是「哪张画布 + 取哪个分桶字段」）
  const reward = js.match(/drawLines\(\$\('network-reward-chart'\)[\s\S]*?networkStat\(row, n, 'reward'\)[\s\S]*?\}\)\)\);/);
  assert.ok(reward, '必须绘制 network-reward-chart');
  assert.match(reward[0], /label: n \+ ' 人'/, '每条线要标出人数');
  const win = js.match(/drawLines\(\$\('network-win-chart'\)[\s\S]*?networkStat\(row, n, 'winRate'\)[\s\S]*?\}\)\), \{ digits: 2, zeroBased: true \}\);/);
  assert.ok(win, '必须绘制 network-win-chart');
  assert.match(win[0], /label: n \+ ' 人'/, '每条线要标出人数');
  // 座位图数据源必须是分桶字段
  assert.match(js, /drawSeatGroups\(\$\('seat-chart'\), seatGroups\(point\.winSeatsByPlayers\)\)/);
  assert.doesNotMatch(js, /point\.winSeats\b/, '不应再读合并的 winSeats');
});

test('drawLines 支持取数函数并且图例会换行', () => {
  const js = read('public/training.js');
  assert.match(js, /function seriesValue\(row, series\)/, '需要统一的取数入口');
  assert.match(js, /series\.pick \? series\.pick\(row\) : row\[series\.key\]/, 'pick 优先于 key');
  assert.match(js, /function drawLegend\(ctx, series, x0, y0, maxWidth\)/, '需要可换行的图例');
  assert.match(js, /pad\.t \+= \(drawLegend\(/, '图例占多行时应把绘图区顶部让出来');
});

test('静态资源版本号已推进', () => {
  const html = read('public/training.html');
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  const css = Number((html.match(/training\.css\?v=(\d+)/) || [])[1]);
  assert.ok(js >= 23, 'training.js 版本号需推进，当前 ' + js);
  assert.ok(css >= 11, 'training.css 版本号需推进，当前 ' + css);
});
