'use strict';
const $ = id => document.getElementById(id);
let fetching = false;
const states = {idle:'空闲',preparing:'准备中',collecting:'采集对局',training:'训练中',stopping:'停止中',stopped:'已停止',completed:'已完成',error:'错误'};
const format = value => value == null ? '—' : Number(value).toFixed(4);
async function api(path, body) {
  const response = await fetch('/api/belief/'+path, body == null ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function message(value) { $('message').textContent = value; }
function options(select, checkpoints, placeholder) {
  const selected = select.value;
  const names = checkpoints.map(c=>c.name);
  if (JSON.stringify(names) === select.dataset.names) return;
  select.dataset.names = JSON.stringify(names);
  select.replaceChildren(new Option(placeholder,''), ...checkpoints.map(c=>new Option(`${c.games} 局 · ${c.dimension} 维 · ${c.name}`,c.name)));
  if (names.includes(selected)) select.value=selected;
}
async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    const state = await api('status');
    $('status-badge').textContent=states[state.state] || state.state;
    $('status-badge').className='status '+(state.running?'running':state.state);
    $('progress').max=state.targetGames || 1;$('progress').value=state.completedGames;
    $('start').disabled=state.running;$('stop').disabled=!state.running;
    for (const input of $('belief-form').elements) input.disabled=state.running;
    const values=[`本次 ${state.completedGames}/${state.targetGames} 局`,`累计 ${state.totalGames} 局`,`采集 ${state.samples} 样本`,
      `参数 ${state.parameterCount || '—'}`,`训练 loss ${format(state.metrics?.loss)}`,`验证 NLL ${format(state.metrics?.validationJointNll)}`];
    $('metrics').replaceChildren(...values.map(text=>{const node=document.createElement('span');node.textContent=text;return node;}));
    window.BeliefCharts.render($('belief-charts'),state.history || [],state.runId || '');
    $('history').replaceChildren(...(state.history || []).slice(-30).reverse().map(point=>{
      const row=document.createElement('tr');
      for (const value of [point.games,format(point.loss),format(point.validationJointNll),format(point.validationRoleNll),format(point.validationHandNll)]) {
        const cell=document.createElement('td');cell.textContent=value;row.append(cell);
      }return row;
    }));
    const logText=(state.logs || []).map(l=>`[${new Date(l.at).toLocaleTimeString()}] ${l.text}`).join('\n');
    if ($('logs').textContent !== logText && logText) { const bottom=$('logs').scrollHeight-$('logs').scrollTop-$('logs').clientHeight<20;$('logs').textContent=logText;if(bottom)$('logs').scrollTop=$('logs').scrollHeight; }
    options($('resume'),state.checkpoints || [],'从头训练');options($('checkpoint'),state.checkpoints || [],'选择已保存的信念权重');
    const inference=state.inference || {};
    $('inference').textContent=inference.configured ? `已启用：${inference.checkpoint}（${inference.games} 局）`+(inference.last?` · 最近重采样 ${inference.last.milliseconds} ms，候选有效样本 ${format(inference.last.effectiveSamples)}`:'') : '未启用信念网络，继续使用原有规则信念。';
    if (inference.error) $('inference').textContent+=' · 回退原因：'+inference.error;
    if (state.error) message(state.error);
  } catch(error) {message(error.message);} finally {fetching=false;}
}
$('start').onclick=async()=>{
  if (!$('belief-form').reportValidity()) return;
  const config={};
  for (const input of $('belief-form').elements) config[input.name]=input.type==='number' || ['dimension','endDistricts'].includes(input.name)?Number(input.value):input.value;
  try {await api('start',config);message('信念训练已启动');await refresh();}catch(error){message(error.message);}
};
for (const action of ['stop','activate','disable']) $(action).onclick=async()=>{
  try {await api(action,action==='activate'?{checkpoint:$('checkpoint').value}:{});message(action==='activate'?'已启用信念权重':action==='disable'?'已恢复原有采样':'已请求停止');await refresh();}catch(error){message(error.message);}
};
$('resume').onchange=async()=>{
  if (!$('resume').value) return;
  try {const state=await api('status');const selected=state.checkpoints.find(c=>c.name===$('resume').value);if(selected){$('belief-form').elements.dimension.value=String(selected.dimension);$('belief-form').elements.historyLength.value=String(selected.historyLength);}}catch(error){message(error.message);}
};
refresh();setInterval(refresh,2000);
