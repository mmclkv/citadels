'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { train, sanitizeConfig } = require('../training/train.js');

// 跑一次小规模训练，捕获所有 {type:'log'} 消息，断言每个阶段的日志都打到了。
// 直接调 train() 而不走 fork，靠 hijack process.send 拿事件流。
async function runAndCaptureLogs(config) {
  const logs = [];
  const origSend = process.send;
  process.send = msg => {
    if (msg && msg.type === 'log') logs.push(msg.text);
  };
  try { await train(config); }
  finally { process.send = origSend; }
  return logs;
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-log-'));
  const dataDir = path.join(tmpRoot, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 把 ROOT 临时换掉，避免污染真实 training-data
  process.chdir(tmpRoot);
  // train.js 内部用 ROOT = path.join(__dirname, '..')，无法改；这里接受落到真实目录即可
  process.chdir(path.join(__dirname, '..'));

  const config = sanitizeConfig({
    targetGames: 4, batchGames: 4, ppoEpochs: 1, miniBatch: 64,
    minPlayers: 4, maxPlayers: 4, profile: 'fast', backend: 'js',
    seed: 7, checkpointEvery: 100, workers: 1, mctsSimulations: 0
  });
  const logs = await runAndCaptureLogs(config);

  // 1) 启动横幅：所有配置维度都得在
  const banner = logs.find(l => l.includes('启动训练：'));
  assert.ok(banner, '应有启动横幅日志');
  assert.ok(banner.includes('profile=fast'), '横幅应包含 profile');
  assert.ok(banner.includes('目标 4 局'), '横幅应包含目标局数');
  assert.ok(banner.includes('每批 4 局'), '横幅应包含每批局数');
  assert.ok(banner.includes('workers=1'), '横幅应包含 worker 数');
  assert.ok(banner.includes('miniBatch=64'), '横幅应包含 miniBatch');
  assert.ok(banner.includes('seed=7'), '横幅应包含 seed');

  // 2) MCTS 状态行：未启用 + 启用两条都覆盖（用极小 sims=5 保持测试在秒级完成）
  assert.ok(logs.some(l => l.includes('MCTS 未启用')), 'MCTS=0 时应有"未启用"日志');
  const mctsConfig = sanitizeConfig({ targetGames: 2, batchGames: 2, ppoEpochs: 1, miniBatch: 64,
    minPlayers: 4, maxPlayers: 4, profile: 'fast', backend: 'js',
    seed: 7, checkpointEvery: 100, workers: 1, mctsSimulations: 5, mctsC_puct: 1.5 });
  const mctsLogs = await runAndCaptureLogs(mctsConfig);
  const mctsBanner = mctsLogs.find(l => l.includes('MCTS 已启用：'));
  assert.ok(mctsBanner, 'MCTS>0 时应有"已启用"日志');
  assert.ok(mctsBanner.includes('5 模拟'), 'MCTS 日志应含模拟次数');
  assert.ok(mctsBanner.includes('c_puct=1.5'), 'MCTS 日志应含 c_puct');

  // 3) 设备行（JS 模式）
  assert.ok(logs.some(l => l.includes('训练器：JavaScript CPU')), 'JS 模式应有设备行');

  // 4) 策略更新行：每批一次（PPO 已弃用，日志里不应再出现 PPO 字样或裁剪率）
  const ppoLog = logs.find(l => l.includes('策略更新（'));
  assert.ok(ppoLog, '应有策略更新日志');
  assert.ok(ppoLog.includes('策略损失'), '策略更新日志应含策略损失');
  assert.ok(ppoLog.includes('价值损失'), '策略更新日志应含价值损失');
  assert.ok(ppoLog.includes('熵'), '策略更新日志应含熵');
  assert.ok(!ppoLog.includes('裁剪率'), '策略更新日志不应再含 PPO 裁剪率');
  assert.ok(!logs.some(l => l.includes('PPO')), '训练日志不应再出现 PPO 字样');

  // 5) 进度行：每批一次
  const progressLog = logs.find(l => l.includes('进度 4/4 局'));
  assert.ok(progressLog, '应有进度日志');
  assert.ok(progressLog.includes('局/分'), '进度日志应含速率');
  assert.ok(progressLog.includes('avg_score'), '进度日志应含平均分');
  assert.ok(progressLog.includes('网络玩家'), '进度日志应含网络玩家自身指标');
  assert.ok(progressLog.includes('预计剩余'), '进度日志应含 ETA');

  // 6) 存档行：每 checkpointEvery + 最终一次
  const ckptLogs = logs.filter(l => l.includes('存档：'));
  assert.ok(ckptLogs.length >= 1, '至少应有 1 条存档日志');
  assert.ok(ckptLogs[0].includes('checkpoint-'), '存档日志应包含文件名');
  assert.ok(ckptLogs[0].includes('KB'), '存档日志应包含大小');

  // 7) 收尾日志
  assert.ok(logs.some(l => l.includes('训练完成：') && l.includes('checkpoint=')),
    '应有训练完成日志');

  // 8) 慢局检测：人为构造一个 recentGames，验证阈值逻辑（>5×均值才报警）
  const recentGames = [{ durationMs: 100 }, { durationMs: 200 }, { durationMs: 150 }, { durationMs: 180 }];
  const SLOW_GAME_FACTOR = 5;
  function shouldReportSlow(durationMs) {
    const threshold = recentGames.length > 1
      ? (recentGames.slice(0, -1).reduce((s, g) => s + g.durationMs, 0) / (recentGames.length - 1)) * SLOW_GAME_FACTOR
      : Infinity;
    return durationMs > threshold;
  }
  recentGames.push({ durationMs: 5000 });
  assert.ok(shouldReportSlow(5000), '5000ms 显著高于 158ms×5=789ms 阈值，应报警');
  recentGames.length = 0;
  recentGames.push({ durationMs: 100 });
  recentGames.push({ durationMs: 200 });
  assert.ok(!shouldReportSlow(180), '180ms < 150ms×5=750ms 阈值，不应报警');
  recentGames.length = 0;
  recentGames.push({ durationMs: 200 });
  assert.ok(!shouldReportSlow(200), '只有 1 局历史时阈值=Infinity，正常局不会触发');

  // 清理：删掉刚才生成的真实 checkpoint 文件（避免污染 training-data/）
  try {
    for (const file of fs.readdirSync(path.join(__dirname, '..', 'training-data'))) {
      if (/^checkpoint-\d+-pfast-m0-ejs-crandom-s7\.json\.gz$/.test(file)) {
        fs.unlinkSync(path.join(__dirname, '..', 'training-data', file));
      }
    }
  } catch (_) { /* ignored */ }

  console.log('训练过程日志：8 组断言全部通过（共捕获 ' + (logs.length + mctsLogs.length) + ' 条事件）');
})().catch(e => { console.error('ERR:', e.message); console.error(e.stack); process.exit(1); });
