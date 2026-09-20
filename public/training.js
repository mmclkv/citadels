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
const CURRENT_STATE_ENCODING_VERSION = 7;

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
    // 「继续已有训练」只有两种模式：从头训练，或加载一个外部权重文件。
    // 后者选完文件后由 uploadCheckpointFile() 把服务器侧落地的存档名写进隐藏域。
    resumeCheckpoint: resumeCheckpointName(),
    mctsSimulations: Math.max(1, +$('mcts-simulations').value || 1),
    mctsC_puct: +$('mcts-cpuct').value,
    mctsDirichletAlpha: +$('mcts-dirichlet').value,
    mctsDirichletEpsilon: +$('mcts-diri-eps').value,
    mctsMaxDepth: +$('mcts-max-depth').value,
    mctsEvaluator: resolveMctsEvaluator(),
    mctsBatchSize: +$('mcts-batch-size').value,
    mctsMaxWaitMs: +$('mcts-max-wait').value,
    mctsCacheSize: +$('mcts-cache-size').value,
    mctsParticles: Math.max(1, +$('mcts-particles').value || 1),
    mctsBelief: !!$('mcts-belief') && $('mcts-belief').checked,
    selfPlayMode: $('self-play-mode').value,
    networkPlayerCount: +$('network-player-count').value,
    heuristicDifficulty: $('heuristic-difficulty').value,
    curriculumStartPlayers: +$('curriculum-start-players').value,
    curriculumEndPlayers: +$('curriculum-end-players').value,
    curriculumStepGames: +$('curriculum-step-games').value,
    trainNetworkOnly: $('train-network-only').value === 'true'
  };
}

// 存档里保存的 config → 面板控件。新增配置项时同步这张表，否则
// 「从存档读取参数」会静默漏填该字段（test/training-checkpoint-config.test.js 会盯着）。
const CONFIG_FIELDS = [
  ['targetGames', 'target-games', 'number'],
  ['minPlayers', 'min-players', 'select'],
  ['maxPlayers', 'max-players', 'select'],
  ['charSet', 'char-set', 'select'],
  ['profile', 'profile', 'select'],
  ['rulesEngine', 'rules-engine', 'select'],
  ['mctsEngine', 'mcts-engine', 'select'],
  ['neuralNetworkFramework', 'neural-network-framework', 'select'],
  ['device', 'device', 'select'],
  ['endDistricts', 'end-districts', 'select'],
  ['maxSteps', 'max-steps', 'number'],
  ['temperatureStart', 'temperature-start', 'number'],
  ['temperatureEnd', 'temperature-end', 'number'],
  ['learningRate', 'learning-rate', 'number'],
  ['batchGames', 'batch-games', 'number'],
  ['workers', 'workers', 'number'],
  ['miniBatch', 'mini-batch', 'number'],
  ['checkpointEvery', 'checkpoint-every', 'number'],
  ['seed', 'seed', 'number'],
  ['mctsSimulations', 'mcts-simulations', 'number'],
  ['mctsC_puct', 'mcts-cpuct', 'number'],
  ['mctsDirichletAlpha', 'mcts-dirichlet', 'number'],
  ['mctsDirichletEpsilon', 'mcts-diri-eps', 'number'],
  ['mctsMaxDepth', 'mcts-max-depth', 'number'],
  ['mctsBatchSize', 'mcts-batch-size', 'number'],
  ['mctsMaxWaitMs', 'mcts-max-wait', 'number'],
  ['mctsCacheSize', 'mcts-cache-size', 'number'],
  ['mctsParticles', 'mcts-particles', 'number'],
  ['mctsBelief', 'mcts-belief', 'checked'],
  ['selfPlayMode', 'self-play-mode', 'select'],
  ['networkPlayerCount', 'network-player-count', 'number'],
  ['heuristicDifficulty', 'heuristic-difficulty', 'select'],
  ['curriculumStartPlayers', 'curriculum-start-players', 'number'],
  ['curriculumEndPlayers', 'curriculum-end-players', 'number'],
  ['curriculumStepGames', 'curriculum-step-games', 'number'],
  ['trainNetworkOnly', 'train-network-only', 'bool']
];

// 不参与回填的键：resumeCheckpoint 是「读哪个存档」本身；backend /
// nativeInferenceBackend / mctsEvaluator 由面板其他选项推导，不能被存档值反向覆盖。
const CONFIG_DERIVED = ['resumeCheckpoint', 'backend', 'nativeInferenceBackend', 'mctsEvaluator'];

// 把存档里的 config 填回面板。返回实际写入项数与跳过项，
// 便于在按钮下方如实告知「哪些没读到」而不是假装全部成功。
function applyCheckpointConfig(config) {
  let applied = 0;
  const skipped = [];
  CONFIG_FIELDS.forEach(([key, id, kind]) => {
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
  updateMctsEvaluatorUI();
  updateCompositionUI();
  estimateMCTS();
  return { applied, skipped };
}

/* ------------------------- 继续已有训练（权重） ------------------------- *
 * 面板上只有两个选项：从头训练 / 加载权重继续训练。选后者会弹出系统文件管理器
 * （Windows 上就是资源管理器），选中后立刻上传给服务器，由它落成 training-data
 * 下的合法存档名，再把这个名字当作 resumeCheckpoint 提交。
 *
 * 为什么不直接列服务器上的存档：存档名里那串后缀（局数/档位/种子）对人不友好，
 * 而权重文件常常来自别的机器或备份目录 —— 统一走「选文件」既直观又能跨目录。
 */
const RESUME_MODES = '<option value="">从头训练</option>' +
  '<option value="file">加载权重继续训练…</option>';

function resumeCheckpointName() {
  return $('resume-checkpoint').value === 'file' ? $('resume-checkpoint-name').value : '';
}

// 选项写入一次即可：render() 每秒都会跑，反复重建下拉框会打断用户的选择。
function initResumeOptions() {
  $('resume-checkpoint').innerHTML = RESUME_MODES;
}

// 每帧只同步「选了哪个文件」的展示与按钮可用状态，不动下拉框本身。
function syncResumeUI() {
  const running = !!(latest && latest.running);
  const select = $('resume-checkpoint');
  if (select) select.disabled = running;
  const name = $('resume-checkpoint-name').value;
  const label = $('resume-checkpoint-file-name');
  if (label) {
    label.textContent = !select || select.value !== 'file' ? '未选择权重文件'
      : (name ? '已选：' + name : '尚未选择权重文件，再点一次上面的下拉框即可重选');
  }
  syncCheckpointLoadButton();
}

// 没有选中权重或训练正在跑时，按钮不可用（训练中面板整体只读）
function syncCheckpointLoadButton() {
  const button = $('load-checkpoint-config');
  if (button) button.disabled = !!(latest && latest.running) || !resumeCheckpointName();
}

// 选「加载权重继续训练」→ 弹出文件管理器。取消选择要退回原状态，
// 否则会留下「选了模式但没有文件」的半吊子配置，点开始训练会被服务端拒绝。
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
    // 不走 multipart 就不用在 server.js 里手写一个表单解析器。
    const data = await api('./api/training/checkpoint/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: file
    });
    $('resume-checkpoint-name').value = data.name;
    resumeCheckpointCompatible = data.encodingCompatible === true;
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
    out.textContent = '加载失败：' + error.message;
  }
  syncResumeUI();
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
  syncCheckpointLoadButton();
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
    { key: 'avgInferenceMs', color: '#ff4fc7', label: '单步毫秒' }
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
    ['座位公平化', '策略网络座位与开局皇冠每局自动轮换'],
    ['状态编码', 'v' + CURRENT_STATE_ENCODING_VERSION + '（JS / C++ 对齐）'],
    ['每局网络玩家', status.point && status.point.networkPlayers ? status.point.networkPlayers + ' 人' : '—'],
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


function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(10, Math.round(rect.width * ratio)); canvas.height = Math.max(10, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); return { ctx, width: rect.width, height: rect.height };
}

// 一条曲线取值的唯一入口：普通系列读 row[key]，按人数拆分的系列用 pick(row)，
// 两种情况都要再乘 scale。
function seriesValue(row, series) {
  const raw = series.pick ? series.pick(row) : row[series.key];
  return Number(raw) * (series.scale || 1);
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
  if (resumeCheckpointName() && resumeCheckpointCompatible === false) {
    $('control-message').textContent = '当前权重的状态编码与 v' + CURRENT_STATE_ENCODING_VERSION + ' 不兼容，请从头训练或选择新权重';
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
// 「从权重读取参数」：读取所选权重里保存的那份 config，一键填回面板所有选项。
// 不改动「继续已有训练」的选择，用户读完可以直接点开始训练从该权重续训。
$('load-checkpoint-config').onclick = async () => {
  const name = resumeCheckpointName();
  const out = $('checkpoint-load-message');
  if (!name) { out.textContent = '请先在上方「继续已有训练」里选择「加载权重继续训练」并选中一个权重文件'; return; }
  out.textContent = '正在读取 ' + name + ' …';
  try {
    const data = await api('./api/training/checkpoint?name=' + encodeURIComponent(name));
    resumeCheckpointCompatible = data.encodingCompatible === true;
    const result = applyCheckpointConfig(data.config || {});
    if (latest) render(latest);
    out.textContent = (resumeCheckpointCompatible ? '已从 ' : '警告：已从 ') + data.name + '（已训 ' + integer(data.game) + ' 局）读入 ' + result.applied + ' 项参数；' +
      (resumeCheckpointCompatible ? '状态编码兼容。' : '状态编码 v' + (data.encodingVersion || '未知') + ' 与当前 v' + CURRENT_STATE_ENCODING_VERSION + ' 不兼容，不能续训。') +
      (result.skipped.length ? '；' + result.skipped.length + ' 项该存档未记录或面板无此选项，保持当前值' : '');
  } catch (error) {
    out.textContent = error.message;
  }
};
$('resume-checkpoint').onchange = syncCheckpointLoadButton;
// 换到「加载权重继续训练」就弹文件管理器；换回「从头训练」要清掉已登记的文件名。
$('resume-checkpoint').addEventListener('change', () => {
  if ($('resume-checkpoint').value === 'file') {
    if (!$('resume-checkpoint-name').value) requestCheckpointFile();
  } else {
    $('resume-checkpoint-name').value = '';
    resumeCheckpointCompatible = null;
  }
  syncResumeUI();
});
$('resume-checkpoint-file').onchange = () => {
  const file = $('resume-checkpoint-file').files && $('resume-checkpoint-file').files[0];
  if (file) uploadCheckpointFile(file);
  else { $('resume-checkpoint').value = ''; $('resume-checkpoint-name').value = ''; resumeCheckpointCompatible = null; syncResumeUI(); }
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
initResumeOptions();
syncCheckpointLoadButton();
window.addEventListener('resize', () => { if (latest) render(latest); });
refresh(); setInterval(refresh, 1000);
