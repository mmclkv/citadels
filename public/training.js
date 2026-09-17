'use strict';

const $ = id => document.getElementById(id);
let latest = null;
const LOG_SCROLL_EPSILON = 4;   // 判断「是否贴底」的容差（px）
const LOG_MAX_LINES = 400;      // 前端最多保留的日志行数，超出从顶部淘汰
const LOG_PLACEHOLDER = '训练进程运行正常，暂无事件。';
let lastLogSeq = 0;             // 已渲染到的最大日志序号
let logInitialized = false;
let logPlaceholder = false;
let logErrorEl = null;
let logErrorText = '';

function num(value, digits = 2) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; }
function integer(value) { return Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString('zh-CN') : '0'; }
function duration(ms) {
  if (!Number.isFinite(Number(ms))) return '—';
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return (h ? h + '时 ' : '') + (m ? m + '分 ' : '') + s + '秒';
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function formConfig() {
  const rulesEngine = $('rules-engine').value;
  const mctsEngine = $('mcts-engine').value;
  const neuralNetworkFramework = $('neural-network-framework').value;
  return {
    targetGames: +$('target-games').value, minPlayers: +$('min-players').value,
    maxPlayers: +$('max-players').value, charSet: $('char-set').value,
    profile: $('profile').value, rulesEngine, mctsEngine, neuralNetworkFramework, device: $('device').value,
    backend: mctsEngine === 'cpp' ? 'native' : 'gpu',
    nativeInferenceBackend: neuralNetworkFramework === 'libtorch' ? 'libtorch' : 'python-binary',
    endDistricts: +$('end-districts').value, maxSteps: +$('max-steps').value,
    temperatureStart: +$('temperature-start').value, temperatureEnd: +$('temperature-end').value,
    learningRate: +$('learning-rate').value,
    batchGames: +$('batch-games').value, workers: +$('workers').value,
    miniBatch: +$('mini-batch').value,
    checkpointEvery: +$('checkpoint-every').value, seed: +$('seed').value,
    resumeCheckpoint: $('resume-checkpoint').value,
    mctsSimulations: Math.max(1, +$('mcts-simulations').value || 1),
    mctsC_puct: +$('mcts-cpuct').value,
    mctsDirichletAlpha: +$('mcts-dirichlet').value,
    mctsDirichletEpsilon: +$('mcts-diri-eps').value,
    mctsMaxDepth: +$('mcts-max-depth').value,
    mctsEvaluator: resolveMctsEvaluator(),
    mctsBatchSize: +$('mcts-batch-size').value,
    mctsMaxWaitMs: +$('mcts-max-wait').value,
    mctsCacheSize: +$('mcts-cache-size').value,
    selfPlayMode: $('self-play-mode').value,
    networkPlayerCount: +$('network-player-count').value,
    heuristicDifficulty: $('heuristic-difficulty').value,
    curriculumStartPlayers: +$('curriculum-start-players').value,
    curriculumEndPlayers: +$('curriculum-end-players').value,
    curriculumStepGames: +$('curriculum-step-games').value,
    trainNetworkOnly: $('train-network-only').value === 'true'
  };
}

// 不再单独提供「神经网络评估器」选项：其值由「神经网络框架」推导，
// 推导规则与 training/train.js 的 sanitizeConfig 保持一致：
//   PyTorch  → gpu（经 PyTorch 桥批量 forward）
//   LibTorch + JS MCTS → js（worker 内本地 forward）
//   C++ MCTS 恒为 gpu（走进程内原生搜索，不经 JS 评估器）
function resolveMctsEvaluator() {
  return ($('mcts-engine').value === 'cpp' || $('neural-network-framework').value === 'pytorch') ? 'gpu' : 'js';
}

function estimateMCTS() {
  const sims = +$('mcts-simulations').value || 0;
  const out = $('mcts-time-estimate');
  if (!sims) { out.textContent = '关闭'; return; }
  const evaluator = resolveMctsEvaluator();
  const perStepHint = evaluator === 'gpu'
    ? 'GPU 批量 forward 实测取决于模拟数和批大小'
    : '单步 ~' + (sims * 0.87 / 1000).toFixed(2) + ' 秒（JS CPU forward 估算）';
  let bullet;
  if (sims <= 50) bullet = '轻量 A 档';
  else if (sims <= 200) bullet = '适中 B 档';
  else if (sims <= 400) bullet = '重度 C 档';
  else bullet = '极限档';
  out.textContent = bullet + ' · ' + perStepHint;
}

function updateMctsEvaluatorUI() {
  const mctsEngine = $('mcts-engine').value;
  const framework = $('neural-network-framework').value;
  const native = mctsEngine === 'cpp';
  const evaluator = resolveMctsEvaluator();
  // 评估器不再是独立选项，提示改挂在「神经网络框架」下面，说明它会推导出什么
  $('neural-framework-hint').textContent = native
    ? (framework === 'libtorch' ? '✓ C++ MCTS 与完整角色规则在搜索进程内运行，使用 LibTorch 评估' : '✓ C++ MCTS 与完整角色规则运行于搜索进程，通过 PyTorch 桥评估网络')
    : (evaluator === 'gpu' ? '✓ JS MCTS 通过 IPC 把 batch 转发到 PyTorch 子进程' : 'JS 评估器在每个 worker 内部 forward');
  document.querySelectorAll('.native-only').forEach(el => { el.style.display = native ? '' : 'none'; });
  // 切换框架会改变推导出的评估器，单步耗时估算要跟着刷新
  estimateMCTS();
}

function setControls(status) {
  const running = !!status.running;
  $('start-training').disabled = running;
  $('stop-training').disabled = !running || status.stopping;
  document.querySelectorAll('#train-form input,#train-form select').forEach(el => { el.disabled = running; });
  document.querySelectorAll('#mcts-form input').forEach(el => { el.disabled = running; });
}

function stateLabel(state) {
  return ({ idle: '空闲', starting: '正在启动', running: '训练中', stopping: '正在停止',
    stopped: '已停止', completed: '已完成', error: '发生错误' })[state] || state;
}

function render(status) {
  latest = status;
  const point = status.point || {};
  const badge = $('status-badge');
  badge.textContent = stateLabel(status.state);
  badge.className = 'status ' + status.state;
  setControls(status);
  const done = status.completedGames || point.game || 0, target = status.targetGames || status.config && status.config.targetGames || 0;
  const progress = target ? Math.min(100, done / target * 100) : 0;
  $('progress-bar').style.width = progress + '%';
  const progressLabel = integer(done) + ' / ' + integer(target) + ' 局（' + num(progress, 1) + '%）';
  $('progress-text').textContent = status.prepareMessage ? status.prepareMessage + ' · ' + progressLabel : progressLabel;
  const remainingMs = point.gamesPerMinute > 0 ? (target - done) / point.gamesPerMinute * 60000 : NaN;
  $('eta').textContent = '预计剩余：' + duration(remainingMs);
  $('m-games').textContent = integer(done);
  $('m-speed').textContent = num(point.gamesPerMinute, 2);
  $('m-game-ms').textContent = num(point.avgGameMs / 1000, 2);
  $('m-inference').textContent = num(point.avgInferenceMs, 2);
  $('m-steps').textContent = integer(point.steps);
  $('m-rounds').textContent = num(point.avgRounds, 1);
  $('m-score').textContent = num(point.avgScore, 1);
  $('m-fallbacks').textContent = integer(point.fallbacks);
  $('value-loss-now').textContent = '价值损失 ' + num(point.valueLoss, 4);
  $('total-loss-now').textContent = '总损失 ' + num(point.totalLoss, 4);
  const policy = Number(point.policyLoss);
  $('policy-now').textContent = (Number.isFinite(policy) ? policy.toExponential(3) : '—') +
    ' · 梯度 ' + num(point.gradientNorm, 3) + ' · 熵 ' + num(point.entropy, 3);
  $('approx-kl-now').textContent = 'KL ' + num(point.approxKl, 5);
  $('speed-now').textContent = num(point.avgGameMs / 1000, 2) + ' 秒/局';
  $('control-message').textContent = status.error || (status.checkpoint ? '最近存档：' + status.checkpoint : '');
  const profiles = status.profiles || {};
  $('parameter-preview').textContent = profiles[$('profile').value] ? integer(profiles[$('profile').value]) + ' 个参数' : '—';
  renderRuntime(status);
  renderCheckpoints(status.checkpoints || []);
  renderLogs(status);
  const history = status.history || [];
  drawLines($('value-loss-chart'), history, [
    { key: 'valueLoss', color: '#ff4fc7', label: '价值损失' }
  ]);
  drawLines($('total-loss-chart'), history, [
    { key: 'totalLoss', color: '#ffd36a', label: '总损失' }
  ]);
  drawLines($('policy-chart'), history, [
    { key: 'policyLoss', color: '#35dcff', label: '策略损失' }
  ]);
  // KL 量级很小（常见 0.0x），刻度需要 4 位小数才看得出变化；且恒为正，下界锚到 0
  drawLines($('approx-kl-chart'), history, [
    { key: 'approxKl', color: '#9d7bff', label: 'KL 散度' }
  ], { digits: 4, zeroBased: true });
  drawLines($('speed-chart'), history, [
    { key: 'avgGameMs', color: '#35dcff', label: '整局毫秒', scale: .001 },
    { key: 'avgInferenceMs', color: '#ff4fc7', label: '单步毫秒' }
  ]);
  drawBars($('seat-chart'), point.winSeats || []);
  updateCheckpointOptions(status.checkpoints || []);
}

function renderRuntime(status) {
  const h = status.hardware || {}, c = status.config || {};
  const mctsSims = c.mctsSimulations || (status.point && status.point.mctsSimulations) || 0;
  const mctsLabel = mctsSims > 0
    ? mctsSims + ' 模拟 · c_puct ' + (c.mctsC_puct || '—') +
      ' · α ' + (c.mctsDirichletAlpha != null ? c.mctsDirichletAlpha : '—')
    : '未启用';
  const rows = [
    ['处理器', h.cpu || '—'], ['逻辑核心', h.logicalCores || '—'], ['内存', h.memoryGB ? h.memoryGB + ' GB' : '—'],
    ['Node.js', h.runtime || '—'], ['训练设备', h.device || c.device || 'JavaScript CPU'], ['显卡', h.gpu || '—'],
    ['PyTorch / CUDA', h.torch ? h.torch + ' / ' + (h.cuda || 'CPU') : '—'], ['训练进程', status.pid || '—'], ['参数量', integer(status.parameterCount)],
    ['网络档位', c.profile || '—'], ['并行自对弈', c.workers ? c.workers + ' 个进程' : '—'],
    ['GPU 峰值显存', status.point && status.point.gpuMemoryMB ? num(status.point.gpuMemoryMB, 0) + ' MB' : '—'],
    ['玩家范围', c.minPlayers ? c.minPlayers + '–' + c.maxPlayers + ' 人' : '—'],
    ['规则引擎', c.rulesEngine === 'cpp' ? 'C++' : (c.rulesEngine === 'js' ? 'JS' : '—')],
    ['MCTS 引擎', c.mctsEngine === 'cpp' ? 'C++' : (c.mctsEngine === 'js' ? 'JS' : '—')],
    ['神经网络框架', c.neuralNetworkFramework === 'libtorch' ? 'LibTorch（C++）' : (c.neuralNetworkFramework === 'pytorch' ? 'PyTorch' : '—')],
    ['计算设备', c.device === 'cuda' ? 'GPU' : (c.device === 'cpu' ? 'CPU' : '—')],
    ['自对弈阵容', c.selfPlayMode === 'all-network' ? '全策略网络' : (c.selfPlayMode === 'network-vs-heuristic' ? '策略网络 + 启发式' : '课程式递增')],
    ['启发式难度', c.heuristicDifficulty || '—'],
    ['样本来源', c.trainNetworkOnly === false ? '全部玩家' : '仅策略网络玩家'],
    ['MCTS', mctsLabel],
    ['日志文件', c.logFile || status.logFile || '—'],
    ['运行时间', status.startedAt ? duration(Date.now() - new Date(status.startedAt).getTime()) : '—']
  ];
  $('runtime-info').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}

function formatTimestamp(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function renderCheckpoints(list) {
  if (!list.length) { $('checkpoints').innerHTML = '<p>暂无存档</p>'; return; }
  $('checkpoints').innerHTML = list.map(item =>
    '<div class="checkpoint">' +
      '<span class="ckpt-name">' + item.name + '</span>' +
      '<span class="ckpt-meta">' + formatTimestamp(item.mtimeMs) + ' · ' + num(item.bytes / 1024 / 1024, 1) + ' MB</span>' +
    '</div>').join('');
}

function isLogAtBottom(log) {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= LOG_SCROLL_EPSILON;
}

function logRowText(row) {
  return '[' + new Date(row.at).toLocaleTimeString() + '] ' + row.text;
}

function appendLogLine(log, text, className) {
  const line = document.createElement('div');
  line.className = className ? 'log-line ' + className : 'log-line';
  line.textContent = text;
  log.appendChild(line);
  return line;
}

// 淘汰顶部旧行：把被移除的高度从 scrollTop 里扣掉，
// 这样用户正在看的那几行在视觉上不会往上跳。
function trimLogLines(log, keepAtBottom) {
  const lines = log.querySelectorAll('.log-line');
  const overflow = lines.length - LOG_MAX_LINES;
  if (overflow <= 0) return;
  let removedHeight = 0;
  for (let i = 0; i < overflow; i++) {
    removedHeight += lines[i].offsetHeight;
    lines[i].remove();
  }
  if (!keepAtBottom) log.scrollTop = Math.max(0, log.scrollTop - removedHeight);
}

function syncLogError(log, errorText, atBottom) {
  if (errorText === logErrorText) return;
  if (!errorText) {
    if (logErrorEl) { logErrorEl.remove(); logErrorEl = null; }
    logErrorText = '';
    return;
  }
  if (logErrorEl && !logErrorEl.isConnected) logErrorEl = null;
  if (!logErrorEl) logErrorEl = appendLogLine(log, errorText, 'log-error');
  else { logErrorEl.textContent = errorText; logErrorEl.className = 'log-line log-error'; }
  logErrorText = errorText;
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderLogs(status) {
  const log = $('training-log');
  if (!log) return;
  const rows = (status.logs || []).filter(row => row && Number.isFinite(Number(row.seq)));
  const seqOf = row => Number(row.seq);
  const maxSeq = rows.length ? seqOf(rows[rows.length - 1]) : 0;
  const errorText = status.error ? '[错误] ' + status.error : '';
  const restarted = maxSeq < lastLogSeq;   // 训练重启后序号回退：整框重画

  // 首次渲染 / 训练重启：清空重建，并落到最新一条
  if (!logInitialized || restarted) {
    log.textContent = '';
    logErrorEl = null;
    logErrorText = '';
    lastLogSeq = 0;
    if (rows.length) {
      rows.forEach(row => appendLogLine(log, logRowText(row)));
      logPlaceholder = false;
    } else {
      appendLogLine(log, LOG_PLACEHOLDER, 'log-placeholder');
      logPlaceholder = true;
    }
    logInitialized = true;
    lastLogSeq = maxSeq;
    syncLogError(log, errorText, true);
    log.scrollTop = log.scrollHeight;
    return;
  }

  const fresh = rows.filter(row => seqOf(row) > lastLogSeq);
  if (logPlaceholder && fresh.length) { log.textContent = ''; logErrorEl = null; logPlaceholder = false; }
  const atBottom = isLogAtBottom(log);
  if (fresh.length) {
    // 只把新行挂到末尾：已有内容一个字节都不动，滚动位置自然停在当前这条日志上
    const frag = document.createDocumentFragment();
    fresh.forEach(row => {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = logRowText(row);
      frag.appendChild(line);
    });
    log.appendChild(frag);
    lastLogSeq = maxSeq;
    trimLogLines(log, atBottom);
  }
  syncLogError(log, errorText, atBottom);
  // 只有本来就贴在底部时才继续贴底；用户一旦往上翻，就停在他看的位置
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function updateCheckpointOptions(list) {
  const select = $('resume-checkpoint'), current = select.value;
  select.innerHTML = '<option value="">从头训练</option>' +
    list.map(item =>
      '<option value="' + item.name + '">' + item.name + ' · ' + formatTimestamp(item.mtimeMs) + '</option>'
    ).join('');
  if (list.some(x => x.name === current)) select.value = current;
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(10, Math.round(rect.width * ratio)); canvas.height = Math.max(10, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); return { ctx, width: rect.width, height: rect.height };
}

function movingAverage(rows, key, windowSize, scale = 1) {
  return rows.map((row, index) => {
    const start = Math.max(0, index - windowSize + 1);
    let sum = 0, count = 0;
    for (let i = start; i <= index; i++) {
      const value = Number(rows[i][key]) * scale;
      if (Number.isFinite(value)) { sum += value; count++; }
    }
    return count ? sum / count : NaN;
  });
}

function drawLines(canvas, history, series, options) {
  const opts = options || {};
  // digits：Y 轴刻度小数位。KL 这类量级很小的指标需要更高精度，否则刻度会被压成同一个数。
  const digits = Number.isFinite(opts.digits) ? opts.digits : 2;
  const { ctx, width, height } = prepareCanvas(canvas), pad = { l: 48, r: 16, t: 22, b: 38 };
  const plotWidth = width - pad.l - pad.r, plotHeight = height - pad.t - pad.b;
  ctx.clearRect(0, 0, width, height); ctx.strokeStyle = '#174861'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad.t + plotHeight * i / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); }
  const values = [];
  history.forEach(row => series.forEach(s => { const v = Number(row[s.key]) * (s.scale || 1); if (Number.isFinite(v)) values.push(v); }));
  let min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  // zeroBased：恒正指标（如 KL）把下界锚到 0，避免基线悬空、看不出绝对值大小
  if (opts.zeroBased && min > 0) min = 0;
  if (min === max) { min -= .5; max += .5; }
  const games = history.map((row, index) => Number.isFinite(Number(row.game)) ? Number(row.game) : index);
  const firstGame = games.length ? games[0] : 0, lastGame = games.length ? games[games.length - 1] : 0;
  const gameSpan = Math.max(1, lastGame - firstGame);
  const xFor = (row, index) => pad.l + ((games[index] - firstGame) / gameSpan) * plotWidth;
  const yFor = value => pad.t + (max - value) / (max - min) * plotHeight;
  ctx.font = '10px system-ui'; ctx.fillStyle = '#8aaaba';
  ctx.fillText(max.toFixed(digits), 3, pad.t + 3); ctx.fillText(min.toFixed(digits), 3, height - pad.b);
  ctx.strokeStyle = '#34708d'; ctx.beginPath(); ctx.moveTo(pad.l, height - pad.b); ctx.lineTo(width - pad.r, height - pad.b); ctx.stroke();
  const tickCount = width < 420 ? 4 : 6;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let tick = 0; tick <= tickCount; tick++) {
    const ratio = tick / tickCount, x = pad.l + plotWidth * ratio;
    const game = Math.round(firstGame + (lastGame - firstGame) * ratio);
    ctx.strokeStyle = '#34708d'; ctx.beginPath(); ctx.moveTo(x, height - pad.b); ctx.lineTo(x, height - pad.b + 4); ctx.stroke();
    ctx.fillStyle = '#8aaaba'; ctx.fillText(game.toLocaleString('zh-CN'), x, height - pad.b + 7);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const averageWindow = Math.max(3, Math.ceil(history.length / 40));
  series.forEach((s, si) => {
    ctx.strokeStyle = s.color; ctx.globalAlpha = .25; ctx.lineWidth = 1; ctx.beginPath(); let started = false;
    history.forEach((row, i) => {
      const v = Number(row[s.key]) * (s.scale || 1); if (!Number.isFinite(v)) return;
      started ? ctx.lineTo(xFor(row, i), yFor(v)) : ctx.moveTo(xFor(row, i), yFor(v)); started = true;
    });
    ctx.stroke();
    const average = movingAverage(history, s.key, averageWindow, s.scale || 1);
    ctx.globalAlpha = 1; ctx.lineWidth = 2.3; ctx.beginPath(); started = false;
    average.forEach((value, i) => {
      if (!Number.isFinite(value)) return;
      started ? ctx.lineTo(xFor(history[i], i), yFor(value)) : ctx.moveTo(xFor(history[i], i), yFor(value)); started = true;
    });
    ctx.stroke(); ctx.fillStyle = s.color; ctx.fillRect(pad.l + si * 112, 5, 12, 3);
    ctx.fillText(s.label + '（均线）', pad.l + 17 + si * 112, 10);
  });
  ctx.globalAlpha = 1;
  if (!history.length) { ctx.fillStyle = '#8aaaba'; ctx.textAlign = 'center'; ctx.fillText('等待训练数据', width / 2, height / 2); ctx.textAlign = 'left'; }
}

function drawBars(canvas, values) {
  const { ctx, width, height } = prepareCanvas(canvas), pad = 30;
  ctx.clearRect(0, 0, width, height); const max = Math.max(1, ...values); const gap = 8;
  const barWidth = (width - pad * 2 - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length);
  values.forEach((value, i) => {
    const h = (height - 55) * value / max, x = pad + i * (barWidth + gap), y = height - 28 - h;
    const grad = ctx.createLinearGradient(0, y, 0, height - 28); grad.addColorStop(0, '#ff4fc7'); grad.addColorStop(1, '#35dcff');
    ctx.fillStyle = grad; ctx.fillRect(x, y, barWidth, h); ctx.fillStyle = '#8aaaba'; ctx.textAlign = 'center';
    ctx.fillText('座位' + (i + 1), x + barWidth / 2, height - 9); ctx.fillStyle = '#eafaff'; ctx.fillText(String(value), x + barWidth / 2, Math.max(12, y - 5));
  });
  if (!values.length) { ctx.fillStyle = '#8aaaba'; ctx.textAlign = 'center'; ctx.fillText('等待胜局数据', width / 2, height / 2); }
  ctx.textAlign = 'left';
}

async function refresh() {
  try { render(await api('./api/training/status')); }
  catch (error) { $('control-message').textContent = error.message; $('status-badge').textContent = '服务离线'; $('status-badge').className = 'status error'; }
}

$('start-training').onclick = async () => {
  $('control-message').textContent = '正在启动…';
  try { render(await api('./api/training/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formConfig()) })); }
  catch (error) { $('control-message').textContent = error.message; }
};
$('stop-training').onclick = async () => {
  $('control-message').textContent = '正在安全停止并保存 checkpoint…';
  try { render(await api('./api/training/stop', { method: 'POST' })); }
  catch (error) { $('control-message').textContent = error.message; }
};
$('profile').onchange = () => { if (latest) render(latest); };
$('rules-engine').onchange = updateMctsEvaluatorUI;
$('char-set').onchange = updateMctsEvaluatorUI;
$('mcts-engine').onchange = updateMctsEvaluatorUI;
$('neural-network-framework').onchange = updateMctsEvaluatorUI;
$('device').onchange = updateMctsEvaluatorUI;
function updateCompositionUI() {
  const mode = $('self-play-mode').value;
  $('network-player-count').disabled = mode !== 'network-vs-heuristic';
  ['curriculum-start-players', 'curriculum-end-players', 'curriculum-step-games'].forEach(id => { $(id).disabled = mode !== 'curriculum'; });
}
$('self-play-mode').onchange = updateCompositionUI;
['mcts-simulations', 'mcts-cpuct', 'mcts-dirichlet', 'mcts-diri-eps', 'mcts-max-depth',
  'mcts-batch-size', 'mcts-max-wait', 'mcts-cache-size'].forEach(id => {
  $(id).oninput = estimateMCTS;
});
estimateMCTS();
updateMctsEvaluatorUI();
updateCompositionUI();
window.addEventListener('resize', () => { if (latest) render(latest); });
refresh(); setInterval(refresh, 1000);
