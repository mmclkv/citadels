'use strict';

// One outstanding decision per room. Changed game state invalidates old answers.
function createBotDriver({ Engine, AI, agent, currentActor, send, delay }) {
  function cancel(r) {
    if (r.botJob) { clearTimeout(r.botJob.timer); r.botJob.controller.abort(); }
    r.botJob = null;
    r.agentStatus = null;
  }
  function tick(r) {
    if (r.botJob || r.closed || !r.state || r.state.phase === 'gameover') return;
    const actor = currentActor(r.state);
    if (!actor || !actor.isBot) { r.agentStatus = null; return; }
    if (r.agentStatus && r.agentStatus.state === 'error' && r.agentStatus.playerId === actor.id) return;
    const job = { controller: new AbortController(), timer: null };
    r.botJob = job;
    job.timer = setTimeout(async () => {
      const st = r.state;
      let stamp;
      let action;
      const modelDriven = actor.botType === 'agent';
      const valid = () => r.botJob === job && !r.closed && r.state === st &&
        currentActor(st) === actor && actor.isBot && (!stamp || JSON.stringify(st) === stamp);
      try {
        if (!valid()) return;
        if (modelDriven) {
          r.agentStatus = { playerId: actor.id, state: 'thinking', model: agent.status().model };
          send(r);
          stamp = JSON.stringify(st);
          const result = await agent.decide(st, actor.id, { signal: job.controller.signal });
          if (!valid()) return;
          action = result.action;
          r.agentStatus = { playerId: actor.id, state: 'ready', model: result.model };
        } else {
          r.agentStatus = null;
          action = AI.decide(st, actor.id);
        }
        if (!action && !modelDriven) action = (Engine.getAvailableActions(st, actor.id).actions || []).find(a => !a.disabled);
        if (!action) throw new Error('没有可执行的行动');
        let res = Engine.applyAction(st, actor.id, action);
        if (!res.ok && !modelDriven) {
          const fallback = (Engine.getAvailableActions(st, actor.id).actions || []).find(a => !a.disabled);
          if (fallback) res = Engine.applyAction(st, actor.id, fallback);
          if (!res.ok && st.turn) Engine.applyAction(st, actor.id, { type: st.turn.pending ? 'ability_skip' : 'end_turn' });
        }
        if (!res.ok && modelDriven) throw new Error('模型行动未通过游戏规则校验');
        r.nextBotDelay = delay(r, action);
        send(r);
      } catch (e) {
        if (modelDriven && valid()) {
          r.agentStatus = { playerId: actor.id, state: 'error', model: agent.status().model,
            message: e.code ? e.message : 'Agent 决策失败，请重试或切换普通电脑' };
          send(r);
        } else if (!modelDriven) console.error('NPC decision failed:', e.message);
      } finally {
        if (r.botJob === job) { r.botJob = null; tick(r); }
      }
    }, r.nextBotDelay == null ? (r.config.botPace || 430) : r.nextBotDelay);
    r.nextBotDelay = null;
  }
  return { tick, cancel };
}
module.exports = { createBotDriver };
