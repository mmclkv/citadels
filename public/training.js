'use strict';

const $ = id => document.getElementById(id);
let latest = null;

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
  return {
    targetGames: +$('target-games').value, minPlayers: +$('min-players').value,
    maxPlayers: +$('max-players').value, charSet: $('char-set').value,
    profile: $('profile').value, backend: $('backend').value, learningRate: +$('learning-rate').value,
    batchGames: +$('batch-games').value, workers: +$('workers').value,
    ppoEpochs: +$('ppo-epochs').value, miniBatch: +$('mini-batch').value,
    checkpointEvery: +$('checkpoint-every').value, seed: +$('seed').value,
    resumeCheckpoint: $('resume-checkpoint').value, endDistricts: 8
  };
}

function setControls(status) {
  const running = !!status.running;
  $('start-training').disabled = running;
  $('stop-training').disabled = !running || status.stopping;
  document.querySelectorAll('#train-form input,#train-form select').forEach(el => { el.disabled = running; });
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
  $('progress-text').textContent = integer(done) + ' / ' + integer(target) + ' 局（' + num(progress, 1) + '%）';
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
  $('loss-now').textContent = '总损失 ' + num(point.totalLoss, 4);
  const policy = Number(point.policyLoss);
  $('policy-now').textContent = (Number.isFinite(policy) ? policy.toExponential(3) : '—') +
    ' · KL ' + num(point.approxKl, 5) + ' · 梯度 ' + num(point.gradientNorm, 3) + ' · 熵 ' + num(point.entropy, 3);
  $('speed-now').textContent = num(point.avgGameMs / 1000, 2) + ' 秒/局';
  $('control-message').textContent = status.error || (status.checkpoint ? '最近存档：' + status.checkpoint : '');
  const profiles = status.profiles || {};
  $('parameter-preview').textContent = profiles[$('profile').value] ? integer(profiles[$('profile').value]) + ' 个参数' : '—';
  renderRuntime(status);
  renderCheckpoints(status.checkpoints || []);
  renderLogs(status);
  const history = status.history || [];
  drawLines($('loss-chart'), history, [
    { key: 'valueLoss', color: '#ff4fc7', label: '价值' },
    { key: 'totalLoss', color: '#ffd36a', label: '总计' }
  ]);
  drawLines($('policy-chart'), history, [
    { key: 'policyLoss', color: '#35dcff', label: '策略损失' }
  ]);
  drawLines($('speed-chart'), history, [
    { key: 'avgGameMs', color: '#35dcff', label: '整局毫秒', scale: .001 },
    { key: 'avgInferenceMs', color: '#ff4fc7', label: '单步毫秒' }
  ]);
  drawBars($('seat-chart'), point.winSeats || []);
  updateCheckpointOptions(status.checkpoints || []);
}

function renderRuntime(status) {
  const h = status.hardware || {}, c = status.config || {};
  const rows = [
    ['处理器', h.cpu || '—'], ['逻辑核心', h.logicalCores || '—'], ['内存', h.memoryGB ? h.memoryGB + ' GB' : '—'],
    ['Node.js', h.runtime || '—'], ['训练设备', h.device || 'JavaScript CPU'], ['显卡', h.gpu || '—'],
    ['PyTorch / CUDA', h.torch ? h.torch + ' / ' + (h.cuda || 'CPU') : '—'], ['训练进程', status.pid || '—'], ['参数量', integer(status.parameterCount)],
    ['网络档位', c.profile || '—'], ['并行自对弈', c.workers ? c.workers + ' 个进程' : '—'],
    ['GPU 峰值显存', status.point && status.point.gpuMemoryMB ? num(status.point.gpuMemoryMB, 0) + ' MB' : '—'],
    ['玩家范围', c.minPlayers ? c.minPlayers + '–' + c.maxPlayers + ' 人' : '—'],
    ['运行时间', status.startedAt ? duration(Date.now() - new Date(status.startedAt).getTime()) : '—']
  ];
  $('runtime-info').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}

function renderCheckpoints(list) {
  $('checkpoints').innerHTML = list.length ? list.map(item =>
    '<div class="checkpoint"><span>' + item.name + '</span><span>' + num(item.bytes / 1024 / 1024, 1) + ' MB</span></div>').join('') : '<p>暂无存档</p>';
}

function renderLogs(status) {
  const lines = (status.logs || []).map(row => '[' + new Date(row.at).toLocaleTimeString() + '] ' + row.text);
  if (status.error && !lines.some(line => line.includes(status.error))) lines.push('[错误] ' + status.error);
  $('training-log').textContent = lines.length ? lines.join('\n') : '训练进程运行正常，暂无事件。';
  $('training-log').scrollTop = $('training-log').scrollHeight;
}

function updateCheckpointOptions(list) {
  const select = $('resume-checkpoint'), current = select.value;
  const names = list.map(x => x.name);
  select.innerHTML = '<option value="">从头训练</option>' + names.map(name => '<option value="' + name + '">' + name + '</option>').join('');
  if (names.includes(current)) select.value = current;
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(10, Math.round(rect.width * ratio)); canvas.height = Math.max(10, Math.round(rect.height * ratio));
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); return { ctx, width: rect.width, height: rect.height };
}

function drawLines(canvas, history, series) {
  const { ctx, width, height } = prepareCanvas(canvas), pad = { l: 42, r: 12, t: 22, b: 26 };
  ctx.clearRect(0, 0, width, height); ctx.strokeStyle = '#174861'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad.t + (height - pad.t - pad.b) * i / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke(); }
  const values = [];
  history.forEach(row => series.forEach(s => { const v = Number(row[s.key]) * (s.scale || 1); if (Number.isFinite(v)) values.push(v); }));
  let min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  if (min === max) { min -= .5; max += .5; }
  ctx.font = '10px system-ui'; ctx.fillStyle = '#8aaaba'; ctx.fillText(max.toFixed(2), 3, pad.t + 3); ctx.fillText(min.toFixed(2), 3, height - pad.b);
  series.forEach((s, si) => {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath(); let started = false;
    history.forEach((row, i) => {
      const v = Number(row[s.key]) * (s.scale || 1); if (!Number.isFinite(v)) return;
      const x = pad.l + (width - pad.l - pad.r) * i / Math.max(1, history.length - 1);
      const y = pad.t + (max - v) / (max - min) * (height - pad.t - pad.b);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke(); ctx.fillStyle = s.color; ctx.fillRect(pad.l + si * 92, 5, 12, 3); ctx.fillText(s.label, pad.l + 17 + si * 92, 10);
  });
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
window.addEventListener('resize', () => { if (latest) render(latest); });
refresh(); setInterval(refresh, 1000);
