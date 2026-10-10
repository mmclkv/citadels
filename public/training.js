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
let resumeCheckpointCompatible = null;
let resumeCheckpointCheckedName = '';
const CURRENT_STATE_ENCODING_VERSION = 15;
const CURRENT_ACTION_ENCODING_VERSION = 11;

function num(value, digits = 2) { return value == null || value === '' ? '—' : Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—'; }
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
  return {
    targetGames: +$('target-games').value, minPlayers: +$('min-players').value,
    maxPlayers: +$('max-players').value, charSet: $('char-set').value,
    profile: $('profile').value, networkArchitecture: $('network-architecture').value,
    rulesEngine: 'cpp', mctsEngine: 'cpp', neuralNetworkFramework: 'libtorch',
    backend: 'python', device: $('device').value,
    endDistricts: +$('end-districts').value, maxSteps: +$('max-steps').value,
    temperatureStart: +$('temperature-start').value, temperatureEnd: +$('temperature-end').value,
    learningRate: +$('learning-rate').value,
    batchGames: +$('batch-games').value, workers: +$('workers').value,
    miniBatch: +$('mini-batch').value,
    replayBufferGames: +$('replay-buffer-games').value,
    checkpointEvery: +$('checkpoint-every').value, seed: +$('seed').value,
    resumeCheckpoint: resumeCheckpointName(),
    mctsSimulations: Math.max(1, +$('mcts-simulations').value || 500),
    mctsC_puct: +$('mcts-cpuct').value,
    mctsDirichletAlpha: +$('mcts-dirichlet').value,
    mctsDirichletEpsilon: +$('mcts-diri-eps').value,
    mctsMaxDepth: +$('mcts-max-depth').value,
    mctsBatchSize: +$('mcts-batch-size').value,
    mctsParticles: Math.max(1, +$('mcts-particles').value || 1),
    mctsBelief: !!$('mcts-belief') && $('mcts-belief').checked,
    selfPlayMode: $('self-play-mode').value,
    historicalPoolSize: +$('historical-pool-size').value,
    historicalOpponentProbability: +$('historical-opponent-probability').value,
    weaknessSearchEvery: +$('weakness-search-every').value,
    weaknessTrainingGames: +$('weakness-training-games').value,
    weaknessEvaluationPairs: +$('weakness-evaluation-pairs').value,
    networkPlayerCount: +$('network-player-count').value,
    heuristicDifficulty: $('heuristic-difficulty').value,
    curriculumStartPlayers: +$('curriculum-start-players').value,
    curriculumEndPlayers: +$('curriculum-end-players').value,
    curriculumStepGames: +$('curriculum-step-games').value
  };
}

// 存档里保存的 config → 面板控件。新增配置项时同步这张表。
const CONFIG_FIELDS = [
  ['targetGames', 'target-games', 'number'],
  ['minPlayers', 'min-players', 'select'],
  ['maxPlayers', 'max-players', 'select'],
  ['charSet', 'char-set', 'select'],
  ['profile', 'profile', 'select'],
  ['device', 'device', 'select'],
  ['endDistricts', 'end-districts', 'select'],
  ['maxSteps', 'max-steps', 'number'],
  ['temperatureStart', 'temperature-start', 'number'],
  ['temperatureEnd', 'temperature-end', 'number'],
  ['learningRate', 'learning-rate', 'number'],
  ['batchGames', 'batch-games', 'number'],
  ['workers', 'workers', 'number'],
  ['miniBatch', 'mini-batch', 'number'],
  ['replayBufferGames', 'replay-buffer-games', 'number'],
  ['checkpointEvery', 'checkpoint-every', 'number'],
  ['seed', 'seed', 'number'],
  ['mctsSimulations', 'mcts-simulations', 'number'],
  ['mctsC_puct', 'mcts-cpuct', 'number'],
  ['mctsDirichletAlpha', 'mcts-dirichlet', 'number'],
  ['mctsDirichletEpsilon', 'mcts-diri-eps', 'number'],
  ['mctsMaxDepth', 'mcts-max-depth', 'number'],
  ['mctsBatchSize', 'mcts-batch-size', 'number'],
  ['mctsParticles', 'mcts-particles', 'number'],
  ['mctsBelief', 'mcts-belief', 'checked'],
  ['selfPlayMode', 'self-play-mode', 'select'],
  ['historicalPoolSize', 'historical-pool-size', 'number'],
  ['historicalOpponentProbability', 'historical-opponent-probability', 'number'],
  ['weaknessSearchEvery', 'weakness-search-every', 'number'],
  ['weaknessTrainingGames', 'weakness-training-games', 'number'],
  ['weaknessEvaluationPairs', 'weakness-evaluation-pairs', 'number'],
  ['networkPlayerCount', 'network-player-count', 'number'],
  ['heuristicDifficulty', 'heuristic-difficulty', 'select'],
  ['curriculumStartPlayers', 'curriculum-start-players', 'number'],
  ['curriculumEndPlayers', 'curriculum-end-players', 'number'],
  ['curriculumStepGames', 'curriculum-step-games', 'number']
];

// Checkpoint weights require a matching network size; runtime hyperparameters
// (workers, GPU mini-batch, MCTS, learning rate, etc.) remain user-controlled.
const CHECKPOINT_ARCHITECTURE_FIELDS = new Set(['profile']);

// 仅把架构相关参数写回表单；其他运行参数继续使用页面当前值。
function applyCheckpointConfig(config) {
  let applied = 0;
  let preserved = 0;
  const skipped = [];
  CONFIG_FIELDS.forEach(([key, id, kind]) => {
    if (!CHECKPOINT_ARCHITECTURE_FIELDS.has(key)) { preserved += 1; return; }
    const el = $(id);
    const value = config[key];
    if (!el || value == null) { skipped.push(key); return; }
    if (kind === 'bool') el.value = value ? 'true' : 'false';
    else if (kind === 'checked') el.checked = !!value;
    else if (kind === 'number') {
      if (!Number.isFinite(Number(value))) { skipped.push(key); return; }
      el.value = String(value);
    } else {
      // 枚举：存档取值在当前面板上不存在时（例如旧版本的选项）保留现值，不清空
      if (!Array.from(el.options).some(option => option.value === String(value))) { skipped.push(key); return; }
      el.value = String(value);
    }
    applied += 1;
  });
  // 填完要刷新派生 UI：评估器提示、阵容联动、单步耗时估算都依赖这些值
  updateMctsHint();
  updateCompositionUI();
  estimateMCTS();
  return { applied, preserved, skipped };
}

/* ------------------------- 继续已有训练（权重） ------------------------- */
function resumeCheckpointName() {
  const value = $('resume-checkpoint').value;
  if (value.startsWith('server:')) return value.slice('server:'.length);
  return value === 'upload' ? $('resume-checkpoint-name').value : '';
}

// 状态轮询会带回服务器上的训练存档；保留当前选择，避免每秒刷新时打断操作。
function updateResumeOptions(checkpoints) {
  const select = $('resume-checkpoint');
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  const addOption = (parent, value, label, disabled = false) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.disabled = disabled;
    parent.appendChild(option);
  };
  addOption(select, '', '从头训练');
  const group = document.createElement('optgroup');
  group.label = '服务器存档（training-data，最近 40 个）';
  if (checkpoints.length) {
    checkpoints.forEach(item => addOption(group, 'server:' + item.name,
      item.name + ' · ' + num(item.bytes / 1024 / 1024, 1) + ' MB'));
  } else addOption(group, '', '服务器上暂无 checkpoint 存档', true);
  select.appendChild(group);
  addOption(select, 'upload', '从本机上传权重文件…');
  if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
}

// 每帧只同步「选了哪个文件」的展示与按钮可用状态，不动下拉框本身。
function syncResumeUI() {
  const running = !!(latest && latest.running);
  const select = $('resume-checkpoint');
  if (select) select.disabled = running;
  const name = $('resume-checkpoint-name').value;
  const label = $('resume-checkpoint-file-name');
  if (label) {
    if (!select || !select.value) label.textContent = '未选择权重文件';
    else if (select.value.startsWith('server:')) label.textContent = '服务器文件：' + select.value.slice(7);
    else label.textContent = name ? '本机上传后已存入服务器：' + name : '请选择本机权重文件';
  }
  syncCheckpointLoadButton();
}

// 没有选中权重或训练正在跑时，按钮不可用（训练中面板整体只读）
function syncCheckpointLoadButton() {
  const button = $('load-checkpoint-config');
  if (button) button.disabled = !!(latest && latest.running) || !resumeCheckpointName();
}

async function inspectResumeCheckpoint(name) {
  resumeCheckpointCompatible = null;
  resumeCheckpointCheckedName = '';
  $('checkpoint-load-message').textContent = '正在检查服务器存档 ' + name + '…';
  try {
    const data = await api('./api/training/checkpoint?name=' + encodeURIComponent(name));
    if (resumeCheckpointName() !== name) return;
    resumeCheckpointCompatible = data.encodingCompatible === true;
    resumeCheckpointCheckedName = name;
    $('checkpoint-load-message').textContent = '已选择服务器存档 ' + data.name + '（已训练 ' +
      integer(data.game) + ' 局）；' + (resumeCheckpointCompatible ? '状态编码兼容。' :
        '状态编码 v' + (data.encodingVersion || '未知') + ' 与当前版本不兼容，不能续训。') +
      '可点击“从权重读取参数”导入该存档配置。';
  } catch (error) {
    if (resumeCheckpointName() !== name) return;
    resumeCheckpointCompatible = false;
    resumeCheckpointCheckedName = name;
    $('checkpoint-load-message').textContent = '无法读取服务器存档：' + error.message;
  }
}

// 仅显式选择“从本机上传”时打开浏览器文件选择器；服务器存档直接从列表选择。
function requestCheckpointFile() {
  const picker = $('resume-checkpoint-file');
  if (!picker) return;
  if (latest && latest.running) { $('checkpoint-load-message').textContent = '训练进行中，请先停止再更换权重'; return; }
  picker.value = '';              // 清空才能重复选中同一个文件
  picker.click();
}

async function uploadCheckpointFile(file) {
  const out = $('checkpoint-load-message');
  out.textContent = '正在上传 ' + file.name + '（' + (file.size / 1024 / 1024).toFixed(1) + ' MB）…';
  try {
    // 直接把原始字节发上去：服务端要的就是 gzip 后的存档本身，
    // 不走 multipart 就无需在 Python 服务端手写表单解析器。
    const data = await api('./api/training/checkpoint/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file
    });
    $('resume-checkpoint-name').value = data.name;
    resumeCheckpointCompatible = data.encodingCompatible === true;
    resumeCheckpointCheckedName = data.name;
    out.textContent = '已加载 ' + data.name + '（该文件已训练 ' + integer(data.game) + ' 局）；' +
      (data.renamed ? '原文件名不符合存档命名，已改名为上述名称。' : '') +
      (resumeCheckpointCompatible ? '状态编码 v' + data.encodingVersion + ' 兼容。' :
        '警告：状态编码 v' + (data.encodingVersion || '未知') + ' 与当前 v' + CURRENT_STATE_ENCODING_VERSION + ' 不兼容，不能续训。') +
      '可点左侧按钮把它的超参数读回面板。';
  } catch (error) {
    // 上传失败就退回从头训练，别留下一个指向不存在存档的配置
    $('resume-checkpoint').value = '';
    $('resume-checkpoint-name').value = '';
    resumeCheckpointCompatible = null;
    resumeCheckpointCheckedName = '';
    out.textContent = '加载失败：' + error.message;
  }
  syncResumeUI();
}

function estimateMCTS() {
  const sims = +$('mcts-simulations').value || 0;
  const out = $('mcts-time-estimate');
  if (!sims) { out.textContent = '关闭'; return; }
  const batchSize = +$('mcts-batch-size').value || 32;
  const perStepHint = `C++ ISMCTS + LibTorch · 叶节点批量 ${batchSize} · 耗时随模拟数、粒子数与设备变化`;
  let bullet;
  if (sims <= 50) bullet = '轻量 A 档';
  else if (sims <= 200) bullet = '适中 B 档';
  else if (sims <= 400) bullet = '重度 C 档';
  else bullet = '极限档';
  out.textContent = bullet + ' · ' + perStepHint;
}

function updateMctsHint() {
  $('neural-framework-hint').textContent =
    'C++ ISMCTS worker 使用 LibTorch 在所选设备上评估局面';
  estimateMCTS();
}

function setControls(status) {
  const running = !!status.running;
  $('start-training').disabled = running;
  $('stop-training').disabled = !running || status.stopping;
  document.querySelectorAll('#train-form input,#train-form select').forEach(el => { el.disabled = running; });
  document.querySelectorAll('#mcts-form input').forEach(el => { el.disabled = running; });
  syncCheckpointLoadButton();
}

function stateLabel(state) {
  return ({ idle: '空闲', starting: '正在启动', running: '训练中', stopping: '正在停止',
    stopped: '已停止', completed: '已完成', error: '发生错误' })[state] || state;
}

function render(status) {
  latest = status;
  updateResumeOptions(status.checkpoints || []);
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
  const attemptRate = point.attemptsPerMinute || point.gamesPerMinute || 0;
  const remainingMs = attemptRate > 0 ? (target - done) / attemptRate * 60000 : NaN;
  const avgGameSeconds = point.avgGameMs == null ? null : Number(point.avgGameMs) / 1000;
  $('eta').textContent = '预计剩余：' + duration(remainingMs);
  $('m-games').textContent = integer(done);
  $('m-speed').textContent = num(point.finishedGamesPerMinute != null
    ? point.finishedGamesPerMinute : point.gamesPerMinute, 2);
  $('m-game-ms').textContent = num(avgGameSeconds, 2);
  $('m-inference').textContent = num(point.avgInferenceMs, 2);
  $('m-steps').textContent = integer(point.steps);
  $('m-rounds').textContent = num(point.avgRounds, 1);
  $('m-score').textContent = num(point.avgScore, 1);
  // 课程式早期只有个别座位是策略网络，avg_reward（同桌零和均值）不反映它的强弱，
  // 因此单独展示网络座位自己的名次分与第一率。
  $('m-nn-reward').textContent = num(point.networkReward, 2);
  $('m-nn-win').textContent = Number.isFinite(Number(point.networkWinRate))
    ? num(point.networkWinRate * 100, 0) + '%' : '—';
  $('nn-reward-now').textContent = perCountText(point, 'reward', v => num(v, 2));
  $('nn-win-now').textContent = perCountText(point, 'winRate', v => num(v * 100, 0) + '%');
  $('m-fallbacks').textContent = integer(point.fallbacks);
  $('value-loss-now').textContent = '价值损失 ' + num(point.valueLoss, 4);
  $('total-loss-now').textContent = '总损失 ' + num(point.totalLoss, 4);
  const policy = Number(point.policyLoss);
  $('policy-now').textContent = (Number.isFinite(policy) ? policy.toExponential(3) : '—') +
    ' · 梯度 ' + num(point.gradientNorm, 3) + ' · 网络熵 ' + num(point.entropy, 3) +
    ' · MCTS 目标熵 ' + num(point.targetEntropy, 3);
  $('approx-kl-now').textContent = 'KL ' + num(point.approxKl, 5);
  $('speed-now').textContent = num(avgGameSeconds, 2) + ' 秒/局';
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
    { key: 'policyLoss', color: '#35dcff', label: '策略损失' },
    { key: 'targetEntropy', color: '#f5b95c', label: 'MCTS 目标熵（损失下界）' }
  ]);
  // KL 量级很小（常见 0.0x），刻度需要 4 位小数才看得出变化；且恒为正，下界锚到 0
  drawLines($('approx-kl-chart'), history, [
    { key: 'approxKl', color: '#9d7bff', label: 'KL 散度' }
  ], { digits: 4, zeroBased: true });
  // 战力按人数拆线：4 人局拿第一比 8 人局容易得多，不同人数的基线本来就不一样，
  // 混在一起的趋势会被「这段时间主要在跑几人局」牵着走。
  // 最新一点也纳入：它是刚跑完的那批，可能第一次出现某种人数
  const counts = playerCountsWithNetwork(history.concat([point]));
  drawLines($('network-reward-chart'), history, counts.map((n, i) => ({
    label: n + ' 人', color: countColor(i), pick: row => networkStat(row, n, 'reward')
  })));
  drawLines($('network-win-chart'), history, counts.map((n, i) => ({
    label: n + ' 人', color: countColor(i), pick: row => networkStat(row, n, 'winRate')
  })), { digits: 2, zeroBased: true });
  drawLines($('speed-chart'), history, [
    { key: 'avgGameMs', color: '#35dcff', label: '整局毫秒', scale: .001 },
    { key: 'avgInferenceMs', color: '#ff4fc7', label: '单次搜索毫秒' }
  ]);
  drawSeatGroups($('seat-chart'), seatGroups(point.winSeatsByPlayers));
  syncResumeUI();
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
    ['训练运行时', h.runtime || '—'], ['训练设备', h.device || c.device || '—'], ['显卡', h.gpu || '—'],
    ['PyTorch / CUDA', h.torch ? h.torch + ' / ' + (h.cuda || 'CPU') : '—'], ['训练进程', status.pid || '—'], ['参数量', integer(status.parameterCount)],
    ['网络档位', c.profile || '—'], ['并行自对弈', c.workers ? c.workers + ' 个采样进程' : '—'],
    ['GPU 峰值显存', status.point && status.point.gpuMemoryMB ? num(status.point.gpuMemoryMB, 0) + ' MB' : '—'],
    ['玩家范围', c.minPlayers ? c.minPlayers + '–' + c.maxPlayers + ' 人' : '—'],
    ['规则引擎', c.rulesEngine === 'cpp' ? 'C++' : (c.rulesEngine === 'js' ? 'JS' : (c.rulesEngine === 'python' ? 'Python' : '—'))],
    ['MCTS 引擎', c.mctsEngine === 'cpp' ? 'C++ ISMCTS' : '—'],
    ['神经网络框架', c.neuralNetworkFramework === 'libtorch' ? 'LibTorch' : '—'],
    ['计算设备', c.device === 'cuda' ? 'GPU' : (c.device === 'cpu' ? 'CPU' : '—')],
    ['自对弈阵容', c.selfPlayMode === 'random-batch' ? '每批随机混合' : c.selfPlayMode === 'all-network' ? '全策略网络' : (c.selfPlayMode === 'network-vs-heuristic' ? '策略网络 + 启发式' : '课程式递增')],
    ['本批阵容', status.batchComposition ? status.batchComposition.players + ' 人：当前 ' + status.batchComposition.main + '，历史 ' + status.batchComposition.historical + '，启发式 ' + status.batchComposition.heuristic : '—'],
    ['座位公平化', '策略网络座位与开局皇冠每局自动轮换'],
    ['状态 / 动作编码', 'v15 / v11（entity-v6，54 种建筑）'],
    ['每局网络玩家', status.point && status.point.networkPlayers ? status.point.networkPlayers + ' 人' : '—'],
    ['本局当前 / 历史模型', status.point && status.point.currentNetworkPlayers != null ? status.point.currentNetworkPlayers + ' / ' + status.point.historicalPlayers + ' 人' : '—'],
    ['历史策略池', status.point && status.point.historicalPoolCount != null ? status.point.historicalPoolCount + ' / ' + c.historicalPoolSize + ' 个版本' : '—'],
    ['针对性对手', status.weaknessSearch ? (status.weaknessSearch.phase === 'training' ? '训练 ' : status.weaknessSearch.phase === 'evaluating' ? '验证 ' : status.weaknessSearch.phase === 'cancelled' ? '已停止' : status.weaknessSearch.accepted ? '验证通过，已入池' : '验证未通过') + (status.weaknessSearch.total ? status.weaknessSearch.games + ' / ' + status.weaknessSearch.total : '') : '尚未执行'],
    ['启发式难度', c.heuristicDifficulty || '—'],
    ['训练目标', 'MCTS 策略监督 + 终局价值（90% 夺冠、10% 名次）'],
    ['MCTS', mctsLabel + ' · 深度 ' + (c.mctsMaxDepth || '—') +
      ' · 粒子 ' + (c.mctsParticles || '—') + ' · batch ' + (c.mctsBatchSize || '—')],
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


function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(10, Math.round(rect.width * ratio)); canvas.height = Math.max(10, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); return { ctx, width: rect.width, height: rect.height };
}

// 一条曲线取值的唯一入口：普通系列读 row[key]，按人数拆分的系列用 pick(row)，
// 两种情况都要再乘 scale。
function seriesValue(row, series) {
  const raw = series.pick ? series.pick(row) : row[series.key];
  if (raw == null || raw === '') return NaN;
  const value = Number(raw) * (series.scale || 1);
  return Number.isFinite(value) ? value : NaN;
}

function movingAverage(rows, series, windowSize) {
  return rows.map((row, index) => {
    const start = Math.max(0, index - windowSize + 1);
    let sum = 0, count = 0;
    for (let i = start; i <= index; i++) {
      const value = seriesValue(rows[i], series);
      if (Number.isFinite(value)) { sum += value; count++; }
    }
    return count ? sum / count : NaN;
  });
}

// 图例按可用宽度自动换行：按人数拆线后最多 7 条，一行摆不下会挤到画布外。
function drawLegend(ctx, series, x0, y0, maxWidth) {
  if (!series.length) return 1;
  ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const suffix = series.length <= 2 ? '（均线）' : '';
  const itemWidth = Math.min(110, Math.max(46, ...series.map(s => ctx.measureText(s.label + suffix).width + 20)));
  const perRow = Math.max(1, Math.floor(maxWidth / itemWidth));
  series.forEach((s, i) => {
    const x = x0 + (i % perRow) * itemWidth, y = y0 + Math.floor(i / perRow) * 13;
    ctx.fillStyle = s.color; ctx.fillRect(x, y - 3, 12, 3);
    ctx.fillStyle = '#8aaaba'; ctx.fillText(s.label + suffix, x + 17, y);
  });
  return Math.ceil(series.length / perRow);
}

function drawLines(canvas, history, series, options) {
  const opts = options || {};
  // digits：Y 轴刻度小数位。KL 这类量级很小的指标需要更高精度，否则刻度会被压成同一个数。
  const digits = Number.isFinite(opts.digits) ? opts.digits : 2;
  const { ctx, width, height } = prepareCanvas(canvas), pad = { l: 48, r: 16, t: 22, b: 38 };
  const plotWidth = width - pad.l - pad.r;
  ctx.clearRect(0, 0, width, height);
  // 图例可能占多行（按人数拆线时最多 7 条），先把它的高度让出来再定绘图区
  pad.t += (drawLegend(ctx, series, pad.l, 10, plotWidth) - 1) * 13;
  const plotHeight = height - pad.t - pad.b;
  ctx.strokeStyle = '#174861'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad.t + plotHeight * i / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); }
  const values = [];
  history.forEach(row => series.forEach(s => { const v = seriesValue(row, s); if (Number.isFinite(v)) values.push(v); }));
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
  series.forEach(s => {
    ctx.strokeStyle = s.color; ctx.globalAlpha = .25; ctx.lineWidth = 1; ctx.beginPath(); let started = false;
    history.forEach((row, i) => {
      const v = seriesValue(row, s); if (!Number.isFinite(v)) return;
      started ? ctx.lineTo(xFor(row, i), yFor(v)) : ctx.moveTo(xFor(row, i), yFor(v)); started = true;
    });
    ctx.stroke();
    const average = movingAverage(history, s, averageWindow);
    ctx.globalAlpha = 1; ctx.lineWidth = 2.3; ctx.beginPath(); started = false;
    average.forEach((value, i) => {
      if (!Number.isFinite(value)) return;
      started ? ctx.lineTo(xFor(history[i], i), yFor(value)) : ctx.moveTo(xFor(history[i], i), yFor(value)); started = true;
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  if (!history.length) { ctx.fillStyle = '#8aaaba'; ctx.textAlign = 'center'; ctx.fillText('等待训练数据', width / 2, height / 2); ctx.textAlign = 'left'; }
}

// 人数分组用的配色：同一人数在两个战力图里同色，方便跨图对照
const PLAYER_COUNT_COLORS = ['#35dcff', '#ffd36a', '#ff4fc7', '#7dff9b', '#9d7bff', '#ff9f6a', '#6affd8'];
// 面板右上角只放得下前几种人数，后面用省略号收尾
const HEADER_COUNTS = 4;

function countColor(index) { return PLAYER_COUNT_COLORS[index % PLAYER_COUNT_COLORS.length]; }

function seatGroups(byPlayers) {
  const bucket = byPlayers || {};
  return Object.keys(bucket).map(Number)
    .filter(n => n >= 2 && bucket[n] && bucket[n].wins && bucket[n].wins.length)
    .sort((a, b) => a - b)
    .map(n => ({ players: n, games: Number(bucket[n].games) || 0, wins: bucket[n].wins.map(Number) }));
}

function networkStat(row, players, field) {
  const bucket = row && row.networkByPlayers ? row.networkByPlayers[players] : null;
  return bucket && Number(bucket.games) > 0 ? Number(bucket[field]) : NaN;
}

function playerCountsWithNetwork(rows) {
  const set = new Set();
  rows.forEach(row => {
    const bucket = (row && row.networkByPlayers) || {};
    Object.keys(bucket).forEach(key => { if (Number(bucket[key].games) > 0) set.add(Number(key)); });
  });
  return [...set].sort((a, b) => a - b);
}

function perCountText(point, field, format) {
  const counts = playerCountsWithNetwork([point]);
  if (!counts.length) return '—';
  const bucket = point.networkByPlayers || {};
  const shown = counts.slice(0, HEADER_COUNTS);
  return shown.map(n => n + '人 ' + format(Number(bucket[n][field]))).join(' · ') +
    (counts.length > shown.length ? ' …' : '');
}

// 座位胜局按人数分组：4 人局与 8 人局的「座位 1」不是同一个概念，混在一起统计
// 只会得到一条按人数分布加权出来的假曲线。这里每种人数一组小图，组内仍按座位排。
function drawSeatGroups(canvas, groups) {
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (!groups.length) {
    ctx.fillStyle = '#8aaaba'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('等待胜局数据', width / 2, height / 2); ctx.textAlign = 'left'; return;
  }
  const padX = 12, gap = 16, top = 34, bottom = 24;
  const groupWidth = (width - padX * 2 - gap * (groups.length - 1)) / groups.length;
  groups.forEach((group, gi) => {
    const x0 = padX + gi * (groupWidth + gap), baseY = height - bottom, maxH = baseY - top;
    // 组内按该人数座位里的最高胜局归一：跨人数不可比（总局数与获胜人数都不同），
    // 组内形状才是「这个人数下有没有先后手偏差」。
    const groupMax = Math.max(1, ...group.wins);
    ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#8aaaba';
    ctx.fillText(group.players + ' 人 · ' + integer(group.games) + ' 局', x0 + groupWidth / 2, 14);
    const seats = group.wins.length, inner = 5;
    const barGap = seats > 1 ? Math.min(4, (groupWidth - inner * 2) / (seats * 3)) : 0;
    const barWidth = Math.max(2, (groupWidth - inner * 2 - barGap * (seats - 1)) / seats);
    // 分隔线：把每组框出来，避免相邻组看成一个连续的长条序列
    ctx.strokeStyle = '#12384c'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0 + inner, baseY + 1); ctx.lineTo(x0 + groupWidth - inner, baseY + 1); ctx.stroke();
    group.wins.forEach((value, i) => {
      const h = maxH * value / groupMax, x = x0 + inner + i * (barWidth + barGap), y = baseY - h;
      const grad = ctx.createLinearGradient(0, y, 0, baseY);
      grad.addColorStop(0, '#ff4fc7'); grad.addColorStop(1, '#35dcff');
      ctx.fillStyle = grad; ctx.fillRect(x, y, barWidth, Math.max(1, h));
      if (barWidth >= 15) {
        ctx.font = '9px system-ui'; ctx.fillStyle = '#eafaff'; ctx.textAlign = 'center';
        ctx.fillText(String(value), x + barWidth / 2, Math.max(11, y - 4));
      }
    });
    ctx.font = '9px system-ui'; ctx.fillStyle = '#8aaaba'; ctx.textAlign = 'center';
    if (barWidth >= 11) group.wins.forEach((_, i) => {
      ctx.fillText(String(i + 1), x0 + inner + i * (barWidth + barGap) + barWidth / 2, baseY + 13);
    });
    else ctx.fillText('座位 1–' + seats, x0 + groupWidth / 2, baseY + 13);
  });
  ctx.textAlign = 'left';
}

async function refresh() {
  try { render(await api('./api/training/status')); }
  catch (error) { $('control-message').textContent = error.message; $('status-badge').textContent = '服务离线'; $('status-badge').className = 'status error'; }
}

$('start-training').onclick = async () => {
  const selectedCheckpoint = resumeCheckpointName();
  if (selectedCheckpoint && resumeCheckpointCheckedName !== selectedCheckpoint) {
    $('control-message').textContent = '正在检查所选服务器权重，请稍候后再开始训练';
    return;
  }
  if (resumeCheckpointName() && resumeCheckpointCompatible === false) {
    $('control-message').textContent = '当前权重需先迁移到状态 v15 / 动作 v11，或选择兼容的新权重';
    return;
  }
  $('control-message').textContent = '正在启动…';
  try { render(await api('./api/training/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formConfig()) })); }
  catch (error) { $('control-message').textContent = error.message; }
};
$('stop-training').onclick = async () => {
  $('control-message').textContent = '正在安全停止并保存 checkpoint…';
  try { render(await api('./api/training/stop', { method: 'POST' })); }
  catch (error) { $('control-message').textContent = error.message; }
};
// 从 checkpoint 读取网络规模等架构参数，不覆盖当前页面的运行参数。
// 不改动「继续已有训练」的选择，用户读完可调整运行参数后直接续训。
$('load-checkpoint-config').onclick = async () => {
  const name = resumeCheckpointName();
  const out = $('checkpoint-load-message');
  if (!name) { out.textContent = '请先选择一个服务器存档，或从本机上传权重文件'; return; }
  out.textContent = '正在读取 ' + name + ' …';
  try {
    const data = await api('./api/training/checkpoint?name=' + encodeURIComponent(name));
    resumeCheckpointCompatible = data.encodingCompatible === true;
    const result = applyCheckpointConfig(data.config || {});
    if (latest) render(latest);
    out.textContent = (resumeCheckpointCompatible ? '已从 ' : '警告：已从 ') + data.name + '（已训 ' + integer(data.game) + ' 局）读入 ' + result.applied + ' 项网络架构参数；' +
      (resumeCheckpointCompatible ? '状态编码兼容。' : '状态编码 v' + (data.encodingVersion || '未知') + ' 与当前 v' + CURRENT_STATE_ENCODING_VERSION + ' 不兼容，不能续训。') +
      '；' + result.preserved + ' 项运行参数保留页面当前值，可继续修改。' +
      (result.skipped.length ? '另有 ' + result.skipped.length + ' 项网络参数未记录或面板无此选项。' : '');
  } catch (error) {
    out.textContent = error.message;
  }
};
$('resume-checkpoint').onchange = syncCheckpointLoadButton;
$('resume-checkpoint').addEventListener('change', () => {
  const value = $('resume-checkpoint').value;
  $('resume-checkpoint-name').value = '';
  resumeCheckpointCompatible = null;
  resumeCheckpointCheckedName = '';
  if (value.startsWith('server:')) inspectResumeCheckpoint(value.slice(7));
  else if (value === 'upload') requestCheckpointFile();
  else $('checkpoint-load-message').textContent = '读取权重兼容所需的网络规模；并行进程数、GPU 小批量、MCTS 等参数以本页设置为准';
  syncResumeUI();
});
$('resume-checkpoint-file').onchange = () => {
  const file = $('resume-checkpoint-file').files && $('resume-checkpoint-file').files[0];
  if (file) uploadCheckpointFile(file);
  else { $('resume-checkpoint').value = ''; $('resume-checkpoint-name').value = ''; resumeCheckpointCompatible = null; resumeCheckpointCheckedName = ''; syncResumeUI(); }
};
$('resume-checkpoint-file').oncancel = () => {
  $('resume-checkpoint').value = '';
  $('resume-checkpoint-name').value = '';
  resumeCheckpointCompatible = null;
  resumeCheckpointCheckedName = '';
  syncResumeUI();
};
$('profile').onchange = () => { if (latest) render(latest); };
$('char-set').onchange = updateMctsHint;
$('device').onchange = updateMctsHint;
function updateCompositionUI() {
  const mode = $('self-play-mode').value;
  $('network-player-count').disabled = mode !== 'network-vs-heuristic';
  ['curriculum-start-players', 'curriculum-end-players', 'curriculum-step-games'].forEach(id => { $(id).disabled = mode !== 'curriculum'; });
}
$('self-play-mode').onchange = updateCompositionUI;
['mcts-simulations', 'mcts-cpuct', 'mcts-dirichlet', 'mcts-diri-eps', 'mcts-max-depth', 'mcts-batch-size'].forEach(id => {
  $(id).oninput = estimateMCTS;
});
estimateMCTS();
updateMctsHint();
updateCompositionUI();
updateResumeOptions([]);
syncCheckpointLoadButton();
window.addEventListener('resize', () => { if (latest) render(latest); });
refresh(); setInterval(refresh, 1000);
