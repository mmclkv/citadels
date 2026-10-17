(function () {
  'use strict';
  const Cards = window.CitCards;
  if (!Cards) return;
  const COLORS = { yellow: '皇家', blue: '宗教', green: '贸易', red: '军事', purple: '特殊' };
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const roles = Cards.CHARACTERS.slice().sort((a, b) => a.num - b.num || a.name.localeCompare(b.name, 'zh-CN'));
  const allCards = Cards.buildDistrictDeck();
  const purpleNames = [...new Set(allCards.filter(card => card.color === 'purple').map(card => card.en))];
  function eligibleCards(roleIds) {
    const selected = new Set(roleIds);
    return allCards.filter(card => {
      const def = Cards.DISTRICTS.find(item => item.en === card.en);
      const required = def && def.requiresAnyCharacter;
      return !Array.isArray(required) || required.some(id => selected.has(id));
    });
  }
  let root, model, onStart;

  function baseRoles(count, mode) { return Cards.pickCharacterSet(count, mode).slice(0, count + 2); }
  function makePlayer(index) {
    return { name: index === 0 ? '我' : '玩家 ' + (index + 1), gold: 2, crown: index === 0,
      role: '', hand: new Set(), city: new Set() };
  }
  function removeUnavailableCards() {
    const available = new Set(eligibleCards([...model.roles])
      .filter(card => card.color !== 'purple' || model.uniqueDistricts.has(card.en))
      .map(card => card.uid));
    for (const player of model.players) {
      player.hand = new Set([...player.hand].filter(id => available.has(id)));
      player.city = new Set([...player.city].filter(id => available.has(id)));
    }
  }
  function sync() {
    if (!root) return;
    const $ = selector => root.querySelector(selector);
    model.count = Number($('#debug-count').value);
    model.phase = $('#debug-phase').value;
    model.roleMode = $('#debug-role-mode').value;
    model.endDistricts = Number($('#debug-end').value);
    model.round = Number($('#debug-round').value);
    model.roles = new Set([...root.querySelectorAll('[data-role]:checked')].map(input => input.value));
    model.uniqueDistricts = new Set([...root.querySelectorAll('[data-unique]:checked')].map(input => input.value));
    model.players = Array.from({ length: model.count }, (_, i) => {
      const panel = root.querySelector('[data-player="' + i + '"]');
      if (!panel) return model.players[i] || makePlayer(i);
      return { name: panel.querySelector('[data-name]').value.trim() || '玩家 ' + (i + 1),
        gold: Number(panel.querySelector('[data-gold]').value),
        crown: panel.querySelector('[data-crown]').checked,
        role: panel.querySelector('[data-player-role]')?.value || '',
        hand: new Set([...panel.querySelectorAll('[data-card-zone="hand"]:checked')].map(input => input.value)),
        city: new Set([...panel.querySelectorAll('[data-card-zone="city"]:checked')].map(input => input.value)) };
    });
    model.draftPlayer = Number($('#debug-draft-player')?.value || 0);
  }
  function cardOptions(zone, playerIndex, selected, available) {
    return Object.keys(COLORS).map(color => {
      const cards = available.filter(card => card.color === color);
      if (!cards.length) return '';
      return '<details class="dse-card-group" data-view-key="cards-' + playerIndex + '-' + zone + '-' + color + '"><summary>' + COLORS[color] + '建筑 <span>' + cards.length + ' 张</span></summary><div class="dse-card-list">' +
        cards.map(card => '<label title="' + esc(card.en) + ' · ' + card.cost + ' 金"><input type="checkbox" data-card-zone="' + zone + '" data-player-index="' + playerIndex + '" value="' + esc(card.uid) + '"' + (selected.has(card.uid) ? ' checked' : '') + '><span>' + esc(card.name) + ' · ' + card.cost + '金</span></label>').join('') +
        '</div></details>';
    }).join('');
  }
  function render() {
    // Changing available cards rebuilds the form; retain the user's place and
    // every disclosure's state using keys that survive changes to the card pool.
    const scrollTop = root.querySelector('.dse-content')?.scrollTop || 0;
    const disclosures = new Map([...root.querySelectorAll('details[data-view-key]')].map(details =>
      [details.dataset.viewKey, { open: details.open, scrollTop: details.querySelector('.dse-card-list')?.scrollTop || 0 }]));
    const active = document.activeElement;
    const focusedCheckbox = root.contains(active) && active.matches('[data-role], [data-unique]')
      ? { attribute: active.hasAttribute('data-role') ? 'data-role' : 'data-unique', value: active.value } : null;
    const count = model.count;
    const rolePool = baseRoles(count, model.roleMode);
    const roleIds = [...model.roles].filter(id => roles.some(role => role.id === id));
    const fallbackIds = rolePool.map(role => role.id);
    const shownRoles = roles;
    const districtPool = eligibleCards(roleIds.length ? roleIds : fallbackIds)
      .filter(card => card.color !== 'purple' || model.uniqueDistricts.has(card.en));
    const playerHtml = model.players.slice(0, count).map((player, index) => {
      const selectedRole = player.role && roleIds.includes(player.role) ? player.role : (roleIds[index] || '');
      const roleSelect = '<label class="dse-field">行动角色<select data-player-role><option value="">选择角色</option>' +
        roleIds.map(id => { const role = Cards.CHAR_MAP[id]; return role ? '<option value="' + esc(id) + '"' + (selectedRole === id ? ' selected' : '') + '>' + role.num + '号 · ' + esc(role.name) + '</option>' : ''; }).join('') + '</select></label>';
      return '<details class="dse-player" data-view-key="player-' + index + '" data-player="' + index + '"' + (index === 0 ? ' open' : '') + '><summary>玩家 ' + (index + 1) + ' <span class="dse-player-summary">' + esc(player.name) + '</span></summary>' +
        '<div class="dse-player-fields"><label class="dse-field">名称<input data-name maxlength="24" value="' + esc(player.name) + '"></label>' +
        '<label class="dse-field">金币<input data-gold type="number" min="0" max="99" value="' + Math.max(0, Number(player.gold) || 0) + '"></label>' +
        '<label class="dse-crown"><input data-crown type="radio" name="debug-crown"' + (player.crown ? ' checked' : '') + '> 皇冠持有者</label>' +
        (model.phase === 'action' ? roleSelect : '') + '</div>' +
        '<div class="dse-zones"><section><h4>手牌 <span>(' + player.hand.size + ')</span></h4>' + cardOptions('hand', index, player.hand, districtPool) + '</section>' +
        '<section><h4>已建建筑 <span>(' + player.city.size + ')</span></h4>' + cardOptions('city', index, player.city, districtPool) + '</section></div></details>';
    }).join('');
    const html = '<div class="dse-backdrop"><section class="dse-dialog" role="dialog" aria-modal="true" aria-labelledby="dse-title"><header><div><h2 id="dse-title">调试模式 · 设置对局</h2><p>点击选项设置状态。未指定的牌会留在牌堆；开始后所有玩家手牌公开，由你逐个操作。</p></div><button type="button" class="dse-close" aria-label="关闭">×</button></header>' +
      '<div class="dse-content"><div class="dse-top-fields"><label class="dse-field">对局人数<select id="debug-count">' + Array.from({ length: 7 }, (_, i) => '<option value="' + (i + 2) + '"' + (count === i + 2 ? ' selected' : '') + '>' + (i + 2) + ' 人</option>').join('') + '</select></label>' +
      '<label class="dse-field">开始阶段<select id="debug-phase"><option value="draft"' + (model.phase === 'draft' ? ' selected' : '') + '>选角</option><option value="action"' + (model.phase === 'action' ? ' selected' : '') + '>行动</option></select></label>' +
      '<label class="dse-field">默认角色集<select id="debug-role-mode"><option value="base"' + (model.roleMode === 'base' ? ' selected' : '') + '>基础</option><option value="dark"' + (model.roleMode === 'dark' ? ' selected' : '') + '>黑暗城市</option><option value="mixed"' + (model.roleMode === 'mixed' ? ' selected' : '') + '>混合</option></select></label>' +
      '<label class="dse-field">结束建筑数<input id="debug-end" type="number" min="1" max="20" value="' + model.endDistricts + '"></label><label class="dse-field">回合数<input id="debug-round" type="number" min="1" max="99" value="' + model.round + '"></label></div>' +
      '<details class="dse-section" open><summary>本局角色集 <span>至少选择 ' + (count + 1) + ' 个角色</span></summary><div class="dse-role-grid">' + shownRoles.map(role => '<label><input type="checkbox" data-role value="' + esc(role.id) + '"' + (model.roles.has(role.id) ? ' checked' : '') + '><span>' + role.num + '号 · ' + esc(role.name) + '</span></label>').join('') + '</div></details>' +
      '<details class="dse-section"><summary>可用独特建筑 <span>默认包含全部特殊建筑</span></summary><div class="dse-role-grid">' + purpleNames.map(name => '<label><input type="checkbox" data-unique value="' + esc(name) + '"' + (model.uniqueDistricts.has(name) ? ' checked' : '') + '><span>' + esc((Cards.DISTRICTS.find(card => card.en === name) || {}).name || name) + '</span></label>').join('') + '</div></details>' +
      '<div class="dse-player-list"><h3>玩家状态</h3>' + playerHtml + '</div>' +
      (model.phase === 'draft' ? '<label class="dse-field dse-draft">当前选角玩家<select id="debug-draft-player">' + model.players.slice(0, count).map((p, i) => '<option value="' + i + '"' + (i === model.draftPlayer ? ' selected' : '') + '>玩家 ' + (i + 1) + ' · ' + esc(p.name) + '</option>').join('') + '</select></label>' : '') +
      '<div class="dse-error" role="status" hidden></div></div><footer><button type="button" class="dse-cancel">取消</button><button type="button" class="dse-start">从此状态开始对局</button></footer></section></div>';
    root.innerHTML = html;
    // These sections have a fixed order and remain present in both phases.
    root.querySelectorAll('.dse-section').forEach((details, index) => {
      details.dataset.viewKey = index === 0 ? 'roles' : 'unique-districts';
    });
    root.querySelectorAll('details[data-view-key]').forEach(details => {
      const saved = disclosures.get(details.dataset.viewKey);
      if (!saved) return;
      details.open = saved.open;
      const list = details.querySelector('.dse-card-list');
      if (list) list.scrollTop = saved.scrollTop;
    });
    if (focusedCheckbox) root.querySelector('[' + focusedCheckbox.attribute + '][value="' + CSS.escape(focusedCheckbox.value) + '"]')?.focus({ preventScroll: true });
    root.querySelector('.dse-content').scrollTop = scrollTop;
    root.querySelector('.dse-close').onclick = close;
    root.querySelector('.dse-cancel').onclick = close;
    root.querySelector('.dse-backdrop').onclick = event => { if (event.target.classList.contains('dse-backdrop')) close(); };
    root.querySelector('.dse-content').onchange = event => {
      const input = event.target;
      if (input.matches('[data-card-zone]') && input.checked) {
        root.querySelectorAll('[data-card-zone][value="' + CSS.escape(input.value) + '"]').forEach(other => {
          if (other !== input) { other.checked = false; other.disabled = true; }
        });
      } else if (input.matches('[data-card-zone]') && !input.checked) {
        root.querySelectorAll('[data-card-zone][value="' + CSS.escape(input.value) + '"]').forEach(other => { other.disabled = false; });
      }
      if (input.matches('[data-role], [data-unique]')) {
        sync();
        removeUnavailableCards();
        render();
      } else if (input.id === 'debug-count' || input.id === 'debug-role-mode' || input.id === 'debug-phase') {
        sync();
        const nextCount = input.id === 'debug-count' ? Number(input.value) : model.count;
        if (input.id === 'debug-count') {
          while (model.players.length < nextCount) model.players.push(makePlayer(model.players.length));
          model.players = model.players.slice(0, nextCount);
          const nextRoles = baseRoles(nextCount, model.roleMode).map(role => role.id);
          for (const id of nextRoles) if (model.roles.size < nextCount + 2) model.roles.add(id);
          model.count = nextCount;
        } else if (input.id === 'debug-role-mode') {
          const nextRoles = baseRoles(model.count, model.roleMode).map(role => role.id);
          model.roles = new Set(nextRoles);
        } else {
          model.phase = input.value;
        }
        removeUnavailableCards();
        render();
      }
    };
    root.querySelector('.dse-content').oninput = event => {
      if (event.target.matches('[data-name]')) {
        const summary = event.target.closest('.dse-player').querySelector('.dse-player-summary');
        summary.textContent = event.target.value;
        const draftOption = root.querySelector('#debug-draft-player option[value="' + event.target.closest('.dse-player').dataset.player + '"]');
        if (draftOption) draftOption.textContent = '玩家 ' + (Number(event.target.closest('.dse-player').dataset.player) + 1) + ' · ' + event.target.value;
      }
    };
    const usedCards = new Set();
    for (const player of model.players) { for (const id of player.hand) usedCards.add(id); for (const id of player.city) usedCards.add(id); }
    root.querySelectorAll('[data-card-zone]').forEach(input => {
      if (usedCards.has(input.value) && !input.checked) input.disabled = true;
    });
    root.querySelector('.dse-start').onclick = start;
  }
  function close() { if (root) root.remove(); root = null; }
  function start() {
    sync();
    const error = root.querySelector('.dse-error');
    const fail = message => { error.textContent = message; error.hidden = false; };
    const count = model.count, roleIds = [...model.roles];
    if (roleIds.length < count + 1) return fail('角色至少需要 ' + (count + 1) + ' 个，当前选择了 ' + roleIds.length + ' 个。');
    if (new Set(model.players.map(player => player.crown)).size !== 2 || model.players.filter(player => player.crown).length !== 1) return fail('请选择且只选择一位皇冠持有者。');
    if (!Number.isInteger(model.endDistricts) || model.endDistricts < 1 || model.endDistricts > 20) return fail('结束建筑数须为 1–20 的整数。');
    if (!Number.isInteger(model.round) || model.round < 1 || model.round > 99) return fail('回合数须为 1–99 的整数。');
    if (model.players.some(player => !Number.isInteger(player.gold) || player.gold < 0 || player.gold > 99)) return fail('金币数须为 0–99 的整数。');
    const cardPool = eligibleCards(roleIds).filter(card => card.color !== 'purple' || model.uniqueDistricts.has(card.en));
    const cardById = new Map(cardPool.map(card => [card.uid, card]));
    const used = new Set();
    for (const player of model.players) {
      for (const id of [...player.hand, ...player.city]) {
        if (used.has(id)) return fail('同一张建筑牌不能分配给多位玩家或同时放入手牌与城市。');
        used.add(id);
        const card = cardById.get(id);
        if (!card) return fail('玩家建筑牌与当前角色集或独特建筑集不匹配，请调整角色集或建筑选择。');
      }
    }
    const deck = cardPool.filter(card => !used.has(card.uid));
    if (model.phase === 'action') {
      const assigned = model.players.map(player => player.role);
      if (assigned.some(id => !roleIds.includes(id)) || new Set(assigned).size !== count) return fail('行动阶段请给每位玩家分配一个不同的本局角色。');
    }
    const players = model.players.slice(0, count).map((player, i) => ({
      id: 'debug-seat-' + i, name: player.name || '玩家 ' + (i + 1), seat: i, isBot: false,
      botType: 'npc', botLevel: 'hard', gold: player.gold, handCount: player.hand.size,
      hasCrown: player.crown, connected: i === 0, played: [], chars: model.phase === 'action' ? [player.role] : [],
      hand: [...player.hand].map(id => ({ ...cardById.get(id) })),
      city: [...player.city].map(id => ({ ...cardById.get(id) }))
    }));
    const state = { phase: model.phase, initializeTurn: model.phase === 'action', round: model.round, rngState: 123456789, firstToFinish: -1,
      config: { playerCount: count, endDistricts: model.endDistricts, charSetMode: model.roleMode }, players,
      deck, discard: [], charDeck: roleIds, callQueue: [], callIdx: 0, turnsCompleted: 0,
      draft: model.phase === 'draft' ? { stepIdx: 0, totalSteps: count, currentPlayer: players[model.draftPlayer].id,
        sub: '', pool: roleIds.slice(), faceUp: [], faceDown: [],
        steps: players.map((_, player) => ({ player, keep: 1, discard: 0, fromFaceDown: false })) } : null,
      draftPublic: { faceUp: [], faceDownCount: 0 },
      turn: null, reaction: null, pendingDestroy: null, roundConfirm: null,
      effects: {}, enabledBellTowers: [], firstFinishers: [], observations: [], uniqueDistricts: [...model.uniqueDistricts] };
    if (model.phase === 'action') {
      state.callQueue = players.map((player, playerIdx) => {
        const role = Cards.CHAR_MAP[player.chars[0]];
        return { charId: role.id, num: role.num, playerIdx };
      }).sort((a, b) => a.num - b.num);
      const first = state.callQueue[0];
      state.turn = { charId: first.charId, num: first.num, playerIdx: first.playerIdx, phase: 'main',
        takenResources: false, incomeTaken: false, monkExtraTaken: false, abilityUsed: false,
        builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
    }
    const callback = onStart;
    close();
    callback(state);
  }
  window.CitadelDebugEditor = { open(callback) {
    if (typeof callback !== 'function') return;
    onStart = callback;
    const count = 4, roleMode = 'base', chosen = baseRoles(count, roleMode);
    model = { count, phase: 'draft', roleMode, endDistricts: 8, round: 1,
      roles: new Set(chosen.map(role => role.id)), uniqueDistricts: new Set(purpleNames),
      players: Array.from({ length: count }, (_, i) => makePlayer(i)), draftPlayer: 0 };
    const startingCards = eligibleCards(chosen.map(role => role.id)).filter(card => card.color !== 'purple' || model.uniqueDistricts.has(card.en));
    model.players.forEach((player, index) => {
      player.hand = new Set(startingCards.slice(index * 4, index * 4 + 4).map(card => card.uid));
    });
    root = document.createElement('div');
    root.id = 'citadel-debug-editor';
    document.body.appendChild(root);
    render();
  } };
})();
