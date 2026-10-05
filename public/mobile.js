/* Live mobile client. The markup and board CSS are copied from V12. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const T = window.CitadelThemeManager;
  T.apply('neon', { persist: false });
  const C = { yellow:'#e0a92b', blue:'#3d7ec4', green:'#3fa46a', red:'#d0503f', purple:'#8b5cc7' };
  const CN = { yellow:'皇家', blue:'宗教', green:'商业', red:'军事', purple:'独特' };
  const SESSION = 'citadels.net.session';
  const M = { ws:null, state:null, id:null, room:null, name:'玩家',
    reconnect:0, handOpen:false, roleOpen:true, targetType:null, selection:null,
    sheetPlayer:null, viewer:null, actions:[], menu:false, leavePending:false,
    sidebar:false, sidebarTab:'log', chat:[], speed:localStorage.getItem('citadels.speed')||'normal',
    stage:null, sequence:null, noticeSeen:null, events:[], event:null, eventTimer:0, effectFallback:null, effectTimer:0,
    focus:null, confirm:null, autoFocus:null, bubbles:[], bubbleTimer:0, fxMemo:null, logSeen:null };
  const V = {room:null,joining:false,muted:true,error:''};
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const attr = esc;
  const cardKey = card => card && (card.uid || card.id || card.name);
  const myPlayer = () => M.state && M.state.players && M.state.players.find(p => p.id === M.id);
  const legal = () => (M.state && M.state.available && M.state.available.actions || []).filter(a=>!a.disabled);
  // Cards the current multi-select may use, taken straight from the engine's legal actions.
  const selectionAllowed = type => { const a = legal();
    if (type === 'choose_cards') return new Set(a.filter(x => x.type === 'choose_cards' && Array.isArray(x.uids)).flatMap(x => x.uids));
    const field = type === 'museum' ? 'cardUid' : 'discardUid';
    return new Set(a.filter(x => x.type === type).map(x => x[field]).filter(Boolean)); };
  const role = id => (M.state && M.state.charDeck || []).find(c => c.id === id) ||
    (M.state && M.state.players || []).flatMap(p => p.chars || []).find(c => c.id === id) ||
    { id, name:id || '角色', num:'?' };
  const score = p => {
    const index = M.state.players.findIndex(x => x.id === p.id);
    return M.state.scores && M.state.scores[index] || {base:0,bonus:0,total:0,detail:[]};
  };
  const districtImg = (card, variant='thumb') => T.districtAsset(card,variant) || '';
  const roleImg = (card, variant='thumb') => T.roleAsset(card,variant) || '';
  const badge = card => `<span class="role-num">${esc(card.num)}</span><span class="role-mini-name">${esc(card.name)}</span>`;
  const roleTag = (card, extra='') => `<button class="summary-role ${extra}" type="button" data-kind="role" data-key="${attr(card.id)}">${badge(card)}</button>`;
  const canBuild = card => !!card?.uid && legal().some(a=>a.type==='build'&&a.uid===card.uid);
  const canBuildAny = () => legal().some(a=>a.type==='build');
  const mini = card => `<button class="city-mini ${M.selection?.uids.has(card.uid)?'selected':''} ${canBuild(card)?'buildable':''}${stageCls('district',card.uid)}${stageCls('hand',card.uid)}" type="button" data-kind="district" data-key="${attr(cardKey(card))}" style="--district-color:${C[card.color]||C.purple}" title="${attr(card.name)} · ${card.cost} 金币"><span class="mini-cost">${esc(card.cost)}</span><span class="mini-name">${esc(String(card.name||'').slice(0,3))}</span></button>`;
  const thumb = (card, kind) => `<button class="small-card-btn ${M.selection?.uids.has(card.uid)?'selected':''} ${kind==='district'&&canBuild(card)?'buildable':''}${kind==='district'?stageCls('district',card.uid)+stageCls('hand',card.uid):''}" type="button" data-kind="${kind}" data-key="${attr(cardKey(card))}"><img src="${attr(kind==='role'?roleImg(card):districtImg(card))}" alt="${attr(card.name)}"><span class="small-card-label">${kind==='role'?esc(card.num)+' · ':''}${esc(card.name)}</span></button>`;
  const coin = n => `<span class="stat-with-icon"><i class="coin-icon"></i><span class="stat-value">${esc(n)}</span></span>`;
  const points = n => `<span class="stat-with-icon"><i class="score-icon"></i><span class="stat-value">${esc(n)}</span></span>`;
  const hand = n => `<span class="hand-stat"><i class="hand-back"></i><span class="stat-value">×${esc(n)}</span></span>`;
  function message(text) { $('entryMessage').textContent = text || ''; }
  function send(payload) { if (M.ws && M.ws.readyState===1) M.ws.send(JSON.stringify(payload)); else message('正在重新连接服务器'); }
  function action(a) { if (!a) return; send({t:'action',action:a}); M.targetType=null; M.selection=null; M.focus=null; M.confirm=null; closeViewer(); closeSheet(); }
  // 选目标类动作共用：点亮目标所在区域并把视口挪过去。
  const focusEl = area => area==='players'?$('players').closest('section'):area==='hand'?$('handSection'):area==='roles'?$('roleArea'):null;
  const surfaceFocus = surface => surface==='player'||surface==='district'?'players':surface==='hand'?'hand':surface==='role'?'roles':null;
  // 居中对齐目标区域；自动聚焦用瞬时滚动，避免被随后的状态刷新把平滑动画打断。
  function scrollFocus(smooth){const el=M.focus&&focusEl(M.focus);if(el)el.scrollIntoView({block:'center',behavior:smooth?'smooth':'auto'});}
  function focusArea(area){if(!area)return;M.focus=area;if(area==='hand')M.handOpen=true;if(area==='roles')M.roleOpen=true;
    render();scrollFocus(true);}
  function session() { try { const v=JSON.parse(localStorage.getItem(SESSION)||'null'); return v && v.token && v.roomId ? v:null; } catch (_) { return null; } }
  function remember(token, roomId) { try {localStorage.setItem(SESSION,JSON.stringify({token,roomId,name:M.name,server:session()?.server||location.origin}));}catch(_){ } }
  function connect() {
    if (M.ws && M.ws.readyState<=1) return;
    const saved=session();
    if(!saved){location.replace('./index.html');return;}
    const ws = new WebSocket((saved.server||location.origin).replace(/^http/,'ws'));
    M.ws=ws;
    ws.onopen=()=>{ M.name=(saved.name||'玩家').trim();
      send({t:'hello',name:M.name,resumeToken:saved.token,roomId:saved.roomId});
    };
    ws.onmessage=event=>{ let msg;try{msg=JSON.parse(event.data);}catch(_){return;} receive(msg); };
    ws.onclose=()=>{ if(M.ws!==ws)return; message('连接中断，正在重连…'); M.ws=null;
      clearTimeout(M.reconnect); M.reconnect=setTimeout(connect,1500);
    };
    ws.onerror=()=>{ message('无法连接本地游戏服务'); };
  }
  function receive(msg) {
    if(msg.t==='rooms'&&M.leavePending){location.replace('./index.html');return;}
    if(msg.t==='hello') { M.id=msg.youId || M.id; if(!msg.resumed){try{localStorage.removeItem(SESSION);}catch(_){}location.replace('./index.html');} }
    else if(msg.t==='joined') { M.id=msg.youId; M.room=msg.roomId; if(msg.resumeToken)remember(msg.resumeToken,msg.roomId); M.state=msg.state; render(); }
    else if(msg.t==='state') { M.state=msg.state; if(msg.state.you)M.id=msg.state.you; if(!driveSequence())render(); }
    else if(msg.t==='chat') { M.chat.push(msg); renderSidebar(); }
    else if(msg.t==='error') { M.sequence=null;message(msg.error); $('selectedInfo').textContent=msg.error; render();$('selectedInfo').textContent=msg.error; }
  }
  function render() {
    const s=M.state;if(!s)return;
    const scroll=$('viewport').scrollTop;
    const sheetScroll=$('sheet').scrollTop;
    $('entryOverlay').hidden=true;
    if(s.phase==='lobby'){location.replace('./index.html');return;}
    if(s.phase==='gameover'){renderOver(s);}else{$('overOverlay').hidden=true;}
    $('handSection').hidden=false;$('removedArea').hidden=false;
    const own=myPlayer(); const current=s.phase==='draft' ? s.draft?.currentPlayer : s.turn?.playerId;
    const phase=s.phase==='draft'?'选角阶段':s.phase==='gameover'?'游戏结束':'行动阶段';
    $('phase').innerHTML=`第 ${esc(s.round)} 轮 · ${phase}<small>${s.players.length} 人局 · ${current===M.id?'轮到你':'公开局面按顺时针排列'}</small>`;
    $('playerCount').textContent=s.players.length+' 人局';
    const voiceAvailable=s.voiceReady!==false&&s.voiceEnabled!==false&&s.config?.voice!==false;
    $('menuVoice').hidden=!voiceAvailable;$('sidebarVoiceTab').hidden=!voiceAvailable;
    const targetActions=legal().filter(a=>['choose_player','spy_target','wizard_target','emperor_crown','choose_district'].includes(a.type));
    M.targetType=targetActions[0]?.type||null;
    if(s.turn?.pending?.kind==='bishop_repay'&&!M.selection){M.selection={type:'choose_cards',uids:new Set()};M.handOpen=true;M.focus='hand';}
    if(M.selection?.type==='choose_cards'&&s.turn?.pending?.kind!=='bishop_repay')M.selection=null;
    const stage=stageStep();
    if(stage&&M.stage){if(stage.surface==='hand')M.handOpen=true;if(stage.surface==='role')M.roleOpen=true;
      $('publicSub').textContent=stage.surface==='player'||stage.surface==='district'?stageTitle():'顺时针排列';}
    else $('publicSub').textContent=M.targetType?'点击目标玩家':'顺时针排列';
    const wantFocus=current!==M.id||M.confirm?null:M.stage?surfaceFocus(stageStep()?.surface):choiceItems()?'roles':M.targetType?'players':M.selection?'hand':canBuildAny()?'hand':null;
    const focusMoved=wantFocus!==M.autoFocus;M.autoFocus=wantFocus;
    if(focusMoved&&wantFocus){M.focus=wantFocus;if(wantFocus==='hand')M.handOpen=true;if(wantFocus==='roles')M.roleOpen=true;}
    if(!wantFocus)M.focus=null;
    renderEffects();renderPlayers();renderHand(own);renderChoices();renderRemoved();renderFooter();
    renderSidebar();
    if(M.sheetPlayer)renderDetail(M.sheetPlayer);
    ['players','hand','roles'].forEach(a=>{const el=focusEl(a);if(el)el.classList.toggle('focus-glow',M.focus===a);});
    $('viewport').scrollTop=scroll;
    $('sheet').scrollTop=sheetScroll;
    if(focusMoved&&wantFocus)scrollFocus();
    processNotices(s);logBubbles(s);
  }
  // 本轮生效的宣告类效果：与 PC 端 #tb-effects 同源（state.effects）。
  // 引擎会在目标被叫到、效果结算的那一刻清空 effects.thief（game_state.hpp:1005-1010），
  // 所以按轮次留档，让横幅像宣告本身一样常驻到回合结束，并标出已生效。
  function effectItems(){const s=M.state,e=s&&s.effects||{},deck=s&&s.charDeck||[];
    if(!M.fxMemo||M.fxMemo.round!==s.round)M.fxMemo={round:s.round};
    const memo=M.fxMemo,out=[];
    const label=n=>{const c=deck.find(x=>Number(x.num)===Number(n));return `${n} 号${c?'·'+c.name:''}`;};
    const keep=(key,val,make)=>{const live=val!=null;if(live)memo[key]=val;const num=live?val:memo[key];
      if(num!=null)out.push(make(num,!live));};
    keep('assassinated',e.assassinated,(n,spent)=>({tone:'danger',icon:'!',text:`${label(n)} 被刺杀${spent?'（已生效）':''}`}));
    keep('bewitched',e.bewitched,(n,spent)=>({tone:'magic',icon:'✦',text:`${label(n)} 被施咒${spent?'（已生效）':''}`}));
    keep('thief',e.thief,(n,spent)=>({tone:'warn',icon:'$',text:`${label(n)} 被盗贼盯上${spent?'（已生效）':''}`}));
    // The first declared target is the real warrant. Never display declaration order,
    // including when reconnecting to a server that still sends the original order.
    const mg=(e.magistrate||{}).nums; if(mg&&mg.length)memo.mag=mg.filter(n=>n!=null).sort((a,b)=>Number(a)-Number(b));
    if((memo.mag||[]).length)out.push({tone:'magic',icon:'§',text:`逮捕令 ${memo.mag.map(label).join('、')}`});
    const bl=(e.blackmailer||{}).nums; if(bl&&bl.length)memo.blk=bl.filter(n=>n!=null);
    if((memo.blk||[]).length)out.push({tone:'warn',icon:'†',text:`威胁标记 ${memo.blk.map(label).join('、')}`});
    return out;}
  function renderEffects(){const box=$('effectsBanner');if(!box)return;const items=effectItems();
    box.hidden=!items.length;box.innerHTML=items.map(x=>`<span class="effects-item ${x.tone}"><i>${esc(x.icon)}</i>${esc(x.text)}</span>`).join('');}
  const seatName=(s,idx)=>{const p=(s.players||[])[idx];return p?p.name:'玩家';};
  function queueEvent(ev){M.events.push(ev);if(!M.event)nextEvent();}
  function nextEvent(){clearTimeout(M.eventTimer);const ev=M.events.shift();if(!ev){closeEvent();return;}
    M.event=ev;$('eventBox').className='event-box tone-'+(ev.tone||'info');
    $('eventIcon').textContent=ev.icon||'✦';$('eventTitle').textContent=ev.title||'';
    $('eventText').innerHTML=`<b>${esc(ev.text||'')}</b>${ev.detail?`<span class="event-detail">${esc(ev.detail)}</span>`:''}`;
    const hold=ev.hold||4200,fill=$('eventBarFill');$('eventOverlay').hidden=false;
    fill.style.transition='none';fill.style.width='100%';
    setTimeout(()=>{fill.style.transition='width '+hold+'ms linear';fill.style.width='0%';},40);
    M.eventTimer=setTimeout(closeEvent,hold);}
  function closeEvent(){clearTimeout(M.eventTimer);M.event=null;$('eventOverlay').hidden=true;if(M.events.length)nextEvent();}
  // 只有宣告类效果、以及被效果选中的对象本人才弹全屏提示，其余效果在玩家行上弹气泡。
  const DECLARE_ROLES=new Set(['刺客','盗贼','女巫','行政官','勒索者']);
  const idxId=(s,i)=>((s.players||[])[i]||{}).id;
  // notice 只带发动者，对象名字是按 _player_label（server.py:912）的「座位N·名字」写进描述的，
  // 所以要靠文本反推出被选中的玩家。
  const myHeldNums=s=>{const me=(s.players||[]).find(p=>p.id===M.id);return ((me&&me.chars)||[]).map(c=>Number(c.num));};
  function mentionedIds(text,s,exclude){const out=[];if(!text)return out;
    // 只认「座位N·名字」这一种标签，避免像「我」这种短名字在别的文案里被误判成对象。
    (s.players||[]).forEach(p=>{if(p.id===exclude||p.seat==null)return;
      if(text.includes(`座位${p.seat+1}·`)||(p.name&&text.includes(`·${p.name}`)))out.push(p.id);});
    return out;}
  const hitsMe=(...ids)=>ids.some(id=>id&&id.includes(M.id));
  function noticeView(n,s){const ev=noticeData(n,s);if(ev&&ev.victim===M.id)ev.full=true;return ev;}
  function noticeData(n,s){switch(n.kind){
    case 'role_effect':{const actor=idxId(s,n.playerIdx),victims=mentionedIds(n.description,s,actor);
      return {actor,victim:hitsMe(victims)?M.id:null,full:false,tone:'magic',icon:'✦',title:`角色能力发动 · ${n.roleName||'角色'}`,
        text:`${n.playerName||seatName(s,n.playerIdx)} 发动了【${n.roleName||'角色'}】能力`,detail:n.description};}
    case 'role_effect_detail':{const full=DECLARE_ROLES.has(n.roleName),actor=idxId(s,n.playerIdx),desc=n.description||'效果已结算';
      const victims=mentionedIds(desc,s,actor);
      const nums=[...String(desc).matchAll(/(\d+)\s*号/g)].map(m=>Number(m[1]));
      const targeted=hitsMe(victims,nums.length&&myHeldNums(s).some(x=>nums.includes(x))?[M.id]:[]);
      return {actor,victim:targeted?M.id:null,full,tone:full?'magic':'info',icon:full?'✦':'·',
        title:targeted?`${n.roleName||'角色'}效果 · 目标是你`:`${n.roleName||'角色'}效果`,
        text:`${n.playerName||seatName(s,n.playerIdx)}：${desc}`};}
    case 'magistrate_declare':{const list=(n.targets&&n.targets.length?n.targets:(n.nums||[]).map(num=>({num,name:`${num} 号角色`}))).slice().sort((a,b)=>Number(a.num)-Number(b.num));
      const mine=list.some(t=>myHeldNums(s).includes(Number(t.num)));
      return {actor:n.byId,victim:mine?M.id:null,full:true,tone:'magic',icon:'§',title:mine?'你收到了逮捕令':'行政官发出逮捕令',
        text:`${n.byName||''} 把 3 张逮捕令发给了 ${list.map(t=>`${t.num} 号·${t.name}`).join('、')}`,
        detail:'其中只有一张是真的，被真逮捕令命中的玩家建造时建筑会被没收。'};}
    case 'magistrate_confiscate':return {actor:n.byId,victim:n.playerId,full:n.playerId===M.id,tone:'danger',icon:'§',title:'建筑被没收',
      text:`【行政官】${n.byName||''} 没收了 ${n.playerName||''} 的『${(n.card&&n.card.name)||n.cardName||'建筑'}』`};
    case 'seized':return {actor:n.byId,victim:n.playerId,full:n.playerId===M.id,tone:'warn',icon:'⚔',title:'建筑被抢夺',
      text:`【元帅】${n.byName||''} 从 ${n.playerName||''} 处抢走了『${n.cardName||'建筑'}』`};
    case 'crown_transfer':return {actor:idxId(s,n.fromIdx),victim:idxId(s,n.toIdx),full:idxId(s,n.toIdx)===M.id,tone:'warn',icon:'♛',title:'皇冠已转移',
      text:`皇冠交给了 ${seatName(s,n.toIdx)}`};
    case 'prophet_collect':{const from=(n.fromIdxs||[]).map(i=>idxId(s,i));
      return {actor:idxId(s,n.toIdx),victim:hitsMe(from)?M.id:null,full:false,tone:'info',icon:'☉',title:'预言家收集手牌',
        text:`${seatName(s,n.toIdx)} 从其他玩家处各取走 1 张手牌`};}
    default:return null;}}
  function noticeEvent(n,s){const ev=noticeView(n,s);if(!ev)return;
    if(n.kind==='role_effect'||n.kind==='role_effect_detail')M.effectFallback=null;
    if(ev.full)queueEvent(ev);else bubbleOn(ev);}
  // 引擎对「没有对象」的效果（魔术师弃牌重抽、航海家奖励等）既不发 role_effect 也不发 detail，
  // 本地提交后短时间没等到提示就自己补一个气泡，保证每个效果都有反馈。
  function expectEffect(text){clearTimeout(M.effectTimer);M.effectFallback=text;
    M.effectTimer=setTimeout(()=>{if(!M.effectFallback)return;const text2=M.effectFallback;M.effectFallback=null;
      bubbleOn({actor:M.id,text:text2,tone:'magic'});},900);}
  function bubbleOn(ev){if(!ev.text)return;if(!ev.actor){message(ev.text);return;}
    const name=(M.state?.players||[]).find(p=>p.id===ev.actor)?.name;
    const text=name&&ev.text.startsWith(name+'：')?ev.text.slice(name.length+1):ev.text;
    M.bubbles.push({id:ev.actor,text,tone:ev.tone||'info',until:Date.now()+5000,fresh:true});render();armBubbles();}
  // 拿金币 / 抽建筑牌 / 领取收入这类资源动作引擎不发 notice，用战报文本补一条气泡。
  const RESOURCE_LOG=/^(拿取金币|抽取建筑牌|领取收入)/;
  function logBubbles(s){const log=s.log||[];if(!log.length)return;const last=log[log.length-1].i;
    if(M.logSeen==null||last<M.logSeen){M.logSeen=last;return;}
    const fresh=log.filter(x=>x.i>M.logSeen);M.logSeen=last;let any=false;
    fresh.forEach(x=>{const text=String(x.text||''),at=text.indexOf('：');if(at<0)return;
      const who=text.slice(0,at),what=text.slice(at+1);if(!RESOURCE_LOG.test(what))return;
      const p=(s.players||[]).find(q=>q.name===who);if(!p)return;
      if(M.bubbles.some(b=>b.id===p.id&&b.text===what))return;
      M.bubbles.push({id:p.id,text:what,tone:'info',until:Date.now()+5000,fresh:true});any=true;});
    if(any){renderPlayers();armBubbles();}}
  function armBubbles(){clearTimeout(M.bubbleTimer);if(!M.bubbles.length)return;M.bubbleTimer=setTimeout(tickBubbles,220);}
  function tickBubbles(){const now=Date.now();let changed=false;
    M.bubbles.forEach(b=>{if(!b.fading&&now>=b.until-800){b.fading=true;changed=true;}});
    const keep=M.bubbles.filter(b=>b.until>now);if(keep.length!==M.bubbles.length)changed=true;
    M.bubbles=keep;if(!keep.length){render();return;}if(changed)render();armBubbles();}
  const bubbleFor=id=>{const now=Date.now();return M.bubbles.filter(b=>b.id===id&&b.until>now).slice(-1)[0];};
  function processNotices(s){const list=s.notices||[];if(!list.length)return;const last=list[list.length-1].seq;
    // 中途加入或新开一局时只对齐进度，不回放历史提示。
    if(M.noticeSeen==null||last<M.noticeSeen){M.noticeSeen=last;return;}
    const fresh=list.filter(n=>n.seq>M.noticeSeen);M.noticeSeen=last;
    fresh.forEach(n=>{try{noticeEvent(n,s);}catch(_){}});}
  // 结算页：结构与字段沿用 PC 端 showOver（app.js:5060）+ #screen-over。
  function renderOver(s){const box=$('overOverlay'),rows=(s.scores||[]).slice().sort((a,b)=>b.total-a.total);
    $('overTitle').textContent=s.winner!=null&&s.players[s.winner]?`${s.players[s.winner].name} 获胜！`:'游戏结束（平局）';
    $('scoreTable').innerHTML='<tr><th>玩家</th><th>城区</th><th>建筑分</th><th>奖励</th><th>总分</th></tr>'+
      rows.map(r=>{const me=(s.players[r.playerIdx]||{}).id===M.id,
          bonus=(r.detail||[]).filter(d=>d.label!=='建筑总分');
        return `<tr class="${s.winner===r.playerIdx?'win':''}"><td>${esc(r.name)}${me?' · 你':''}</td><td>${esc(r.cityCount)}</td><td>${esc(r.base)}</td><td>+${esc(r.bonus)}</td><td class="total">${esc(r.total)}</td></tr>`+
          `<tr class="detail-row"><td colspan="5">${bonus.map(d=>`${esc(d.label)} +${esc(d.value)}`).join('，')||'无奖励分'}</td></tr>`;}).join('');
    box.hidden=false;}
  function orderedPlayers(players){if(players.length<=2)return players;const out=[players[0],players[1]];for(let lo=2,hi=players.length-1;lo<=hi;lo++,hi--){out.push(players[hi]);if(lo!==hi)out.push(players[lo]);}return out;}
  function renderPlayers(){const s=M.state;const active=s.phase==='draft'?s.draft?.currentPlayer:s.turn?.playerId;
    const st=stageStep();const stagePlayers=st&&st.surface==='player'?new Set(st.options.map(o=>String(o.value))):null;
    const candidates=legal().filter(a=>a.type===M.targetType);const targetIds=new Set(candidates.map(a=>a.target));
    $('players').classList.toggle('targeting',!!M.targetType||!!stagePlayers);
    $('players').innerHTML=orderedPlayers(s.players).map(p=>{
      const ch=p.revealedCharId && !(s.phase==='draft'&&p.id!==M.id)?role(p.revealedCharId):null;
      const isTarget=stagePlayers?stagePlayers.has(String(p.id)):targetIds.has(p.id);
      const bub=bubbleFor(p.id);
      return `<article class="player-row ${p.id===M.id?'self ':''}${p.id===active?'active-turn ':''}${p.threat?'threat ':''}${M.targetType||stagePlayers?(isTarget?'target-selectable':'target-ineligible'):''}" data-player="${attr(p.id)}">
        <div class="player-meta"><div class="player-headline"><div class="pname">${esc(p.name)}</div>${p.id===M.id?'<span class="you-chip">你</span>':''}${p.hasCrown?'<i class="crown-icon">♛</i>':''}
        ${ch?`<span class="public-role-inline"><button class="public-role-btn" type="button" data-kind="role" data-key="${attr(ch.id)}"><span class="role-no">${esc(ch.num)}</span><span>${esc(ch.name)}</span></button></span>`:''}
        <div class="p-stats">${coin(p.gold)}${points(score(p).total)}${hand(p.handCount)}</div></div></div>
        <div class="city-compact">${(p.city||[]).map(mini).join('')}</div>
        ${bub?`<div class="row-bubble tone-${attr(bub.tone)}${bub.fresh?' enter':''}${bub.fading?' fading':''}">${esc(bub.text)}</div>`:''}</article>`;
    }).join('');
    // 入场动画只在气泡出现的那一次渲染播放，避免每次状态刷新都重放造成闪动。
    M.bubbles.forEach(b=>{b.fresh=false;});
  }
  function renderHand(own){const cards=own?.hand||[];const section=$('handSection');section.classList.toggle('collapsed',!M.handOpen);
    section.querySelector('.sub').textContent=cards.length+' 张';section.querySelector('.fold-toggle').textContent=M.handOpen?'收起':'展开';
    $('handSummary').style.setProperty('--summary-count',String(Math.max(1,cards.length)));
    $('handSummary').innerHTML=cards.map(mini).join('')||'<span class="choice-help">暂无手牌</span>';
    $('myHand').innerHTML=cards.map(c=>thumb(c,'district')).join('')||'<span class="choice-help">暂无手牌</span>';
  }
  function choiceItems(){const s=M.state,a=legal(),pending=s.turn?.pending;
    if(s.phase==='draft'&&s.draft?.pool?.length)return {title:s.draft.sub==='discard'?'暗置弃掉一张角色牌':'请选择一个角色',hint:`进度 ${s.draft.stepIdx+1} / ${s.draft.totalSteps} · 点击卡图查看 / 选择`,kind:'role',items:s.draft.pool,action:c=>a.find(x=>(x.type==='draft_pick'||x.type==='draft_discard')&&x.charId===c.id)};
    const cardTypes=['draw_keep','scholar_pick','wizard_card','prophet_give'];
    const type=cardTypes.find(t=>a.some(x=>x.type===t));
    if(type){const pool=type==='prophet_give'?myPlayer()?.hand||[]:pending?.cards||pending?.hand||[];
      const cards=pool.length?pool:a.filter(x=>x.type===type).map(x=>[...(myPlayer()?.hand||[]),...(pending?.cards||[])].find(c=>c.uid===x.uid)).filter(Boolean);
      return {title:s.available?.prompt||'选择建筑牌',hint:'点击卡图查看并确认',kind:'district',items:cards,action:c=>a.find(x=>x.type===type&&x.uid===c.uid)};}
    if(pending?.kind==='wizard_choice'&&pending.card)return {title:'法师 · 选择卡牌去向',hint:'点击卡图查看，再从下方选择',kind:'district',items:[pending.card],action:()=>null};
    const roleTypes=['choose_char','magistrate_signed','magistrate_char','blackmailer_signed','blackmailer_char'];
    const rt=roleTypes.find(t=>a.some(x=>x.type===t));
    if(rt){const choices=a.filter(x=>x.type===rt).map(x=>({...(s.charDeck||[]).find(c=>c.num===Number(x.num??x.name)),num:Number(x.num??x.name),id:(s.charDeck||[]).find(c=>c.num===Number(x.num??x.name))?.id||String(x.num??x.name),name:x.label}));
      return {title:s.available?.prompt||'选择角色',hint:'点击卡图查看并确认',kind:'role',items:choices,action:c=>a.find(x=>x.type===rt&&Number(x.num??x.name)===Number(c.num))};}
    return null;
  }
  function renderChoices(){const st=stageStep();
    const choice=st&&st.surface==='role'?{kind:'role',title:stageTitle(),hint:stageHint(),items:st.options.map(o=>o.card).filter(Boolean)}:choiceItems();
    const area=$('roleArea');area.hidden=!choice;if(!choice)return;
    area.classList.toggle('collapsed',!M.roleOpen);area.querySelector('strong').textContent=choice.title;
    area.querySelector('.sub').textContent=choice.hint;area.querySelector('.fold-toggle').textContent=M.roleOpen?'收起':'展开';
    $('roleSummary').style.setProperty('--summary-count',String(Math.max(1,choice.items.length)));
    $('roleSummary').innerHTML=choice.kind==='role'?choice.items.map(c=>roleTag(c)).join(''):choice.items.map(mini).join('');
    $('roles').innerHTML=choice.items.map(c=>thumb(c,choice.kind)).join('');
  }
  function renderRemoved(){const removed=M.state.removed||{faceUp:[],faceDownCount:0};
    $('removedRoles').innerHTML=`<span class="removed-label">弃置</span><div class="removed-cards">${(removed.faceUp||[]).map(c=>roleTag(c)).join('')}${Array.from({length:removed.faceDownCount||0},()=>'<button class="removed-back" data-kind="back" type="button" aria-label="暗置角色牌"></button>').join('')}</div><span class="removed-count">${(removed.faceUp||[]).length+(removed.faceDownCount||0)}</span><span class="removed-note">暗置身份不可见</span>`;
  }
  const STAGED_ROLES=new Set(['magician','assassin','thief','witch','spy','wizard','emperor','navigator','warlord','marshal','diplomat','artist','magistrate','blackmailer']);
  const COLORS=['yellow','blue','green','red','purple'];
  function stageOptions(){const st=M.stage,s=M.state,step=st.step,used=new Set(st.picks.map(x=>x.value));
    const people=s.players.filter(p=>p.id!==M.id).map(p=>({value:p.id,label:`${p.name} · ${p.handCount} 张手牌`,surface:'player',player:p}));
    const roles=(s.charDeck||[]).filter(c=>c.num!==role(s.turn?.charId).num&&!(s.removed?.faceUp||[]).some(x=>x.num===c.num)).sort((a,b)=>a.num-b.num).map(c=>({value:c.num,label:`${c.num} · ${c.name}`,surface:'role',card:c}));
    const cities=players=>players.flatMap(p=>(p.city||[]).map(c=>({value:c.uid,label:`${p.name} · ${c.name} · ${c.cost} 金`,surface:'district',target:p.id,uid:c.uid,card:c}))).filter(x=>!x.card.fortress);
    const mode=(value,label)=>({value,label,surface:'button'});
    switch(st.role){
      case 'magician':return step===0?[mode('swap','交换手牌'),mode('redraw','弃牌重抽')]:st.picks[0]?.value==='swap'?people:(myPlayer()?.hand||[]).map(c=>({value:c.uid,label:`${c.name} · ${c.cost} 金`,surface:'hand'}));
      case 'assassin':case 'thief':case 'witch':return roles.filter(x=>st.role==='thief'?x.value!==1:st.role==='witch'?x.value!==1:true);
      case 'spy':return step===0?people:COLORS.map(c=>mode(c,CN[c]));
      case 'wizard':return people.filter(x=>x.player.handCount>0);
      case 'emperor':return step===0?people:[mode('gold','拿取 1 金币'),mode('card','取得 1 张手牌')];
      case 'navigator':return [mode('gold','额外获得 4 金币'),mode('cards','额外抽取 4 张建筑牌')];
      case 'warlord':case 'marshal':return cities(s.players.filter(p=>st.role==='warlord'||p.id!==M.id));
      case 'diplomat':return step===0?cities(s.players.filter(p=>p.id===M.id)):cities(s.players.filter(p=>p.id!==M.id));
      case 'artist':return cities(s.players.filter(p=>p.id===M.id)).filter(x=>!x.card.beautified);
      case 'magistrate':return roles.filter(x=>!used.has(x.value));
      case 'blackmailer':return step<2?roles.filter(x=>!used.has(x.value)):st.picks.slice(0,2);
      default:return [];
    }
  }
  function stageTitle(){const names={magician:'魔术师能力',assassin:'刺杀目标',thief:'偷窃目标',witch:'施咒目标',spy:'间谍能力',wizard:'法师目标',emperor:'皇帝能力',navigator:'航海家奖励',warlord:'摧毁建筑',marshal:'抢夺建筑',diplomat:'交换建筑',artist:'美化建筑',magistrate:'逮捕令',blackmailer:'威胁标记'};return names[M.stage?.role]||'角色能力';}
  function stageHint(){const st=M.stage;if(!st)return '';if(st.ready)return '确认后才会向游戏引擎提交行动。';
    const hints={magician:st.step===0?'选择一种能力':st.picks[0]?.value==='swap'?'选择交换手牌的玩家':'选择要弃掉的手牌，可留空',spy:st.step===0?'选择调查的玩家':'选择调查的建筑颜色',emperor:st.step===0?'选择接收皇冠的玩家':'选择从该玩家处取得的资源',diplomat:st.step===0?'先选择自己的一栋建筑':'再选择对方的一栋建筑',artist:'选择最多两栋建筑，可留空',magistrate:['选择真实逮捕目标','选择第一个伪装目标','选择第二个伪装目标'][st.step],blackmailer:['选择第一个威胁角色','选择第二个威胁角色','选择真实威胁目标'][st.step]};
    return hints[st.role]||'选择目标，确认前可以返回';}
  const stageMulti = st => (st.role==='magician'&&st.step===1&&st.picks[0]?.value==='redraw')||st.role==='artist';
  function stageStep(){ if(!M.stage) return null; const options=stageOptions();
    return {options, surface:options[0]?.surface||'button', multi:stageMulti(M.stage)}; }
  const stageIndexOf = value => { const st=stageStep(); return st?st.options.findIndex(o=>String(o.value)===String(value)):-1; };
  const stagePicked = value => !!M.stage && M.stage.selected.has(String(value));
  // Reuses the board / role-area / hand highlights already styled for engine-driven picks.
  const stageCls = (surface,uid) => { const st=stageStep(); if(!st||st.surface!==surface||stageIndexOf(uid)<0) return '';
    return st.multi&&stagePicked(uid)?' selected':' buildable'; };
  function startStage(){const roleId=M.state?.turn?.charId;if(!STAGED_ROLES.has(roleId))return false;M.stage={role:roleId,step:0,picks:[],selected:new Set(),ready:false};render();return true;}
  function chooseStageOption(index){const st=M.stage;if(!st)return;const option=stageOptions()[index];if(!option)return;
    const multi=stageMulti(st);
    if(multi){const v=String(option.value);st.selected.has(v)?st.selected.delete(v):st.selected.add(v);if(st.role==='artist'&&st.selected.size>2)st.selected.delete(v);}
    else{closeSheet();closeViewer();st.picks[st.step]=option;const last={magician:1,spy:1,emperor:1,diplomat:1,magistrate:2,blackmailer:2}[st.role]??0;if(st.step<last)st.step++;else st.ready=true;}
    render();
  }
  function backStage(){const st=M.stage;if(!st)return;if(stageMulti(st)&&st.selected.size){st.selected.clear();render();return;}
    if(st.ready){st.ready=false;st.picks.splice(st.step,1);}else if(st.step>0){st.step--;st.picks.splice(st.step,1);st.selected.clear();}else M.stage=null;render();}
  function sequenceSteps(st){const p=st.picks.map(x=>x.value),first=[{type:'ability'}];switch(st.role){
    case 'magician':first.push({type:'magician_mode',mode:p[0]});if(p[0]==='swap')first.push({type:'choose_player',target:p[1]});return first;
    case 'assassin':case 'thief':case 'witch':return [...first,{type:'choose_char',num:p[0]}];
    case 'spy':return [...first,{type:'spy_target',target:p[0]},{type:'spy_color',color:p[1]}];
    case 'wizard':return [...first,{type:'wizard_target',target:p[0]}];
    case 'emperor':return [...first,{type:'emperor_crown',target:p[0]},{type:'emperor_take',mode:p[1]}];
    case 'navigator':return [...first,{type:'navigator_bonus',mode:p[0]}];
    case 'warlord':case 'marshal':return [...first,{type:'choose_district',target:st.picks[0].target,uid:st.picks[0].uid}];
    case 'diplomat':return [...first,...st.picks.map(x=>({type:'choose_district',target:x.target,uid:x.uid}))];
    case 'artist':return [...first,...[...st.selected].map(uid=>({type:'choose_district',uid,target:M.id})),{type:'artist_done'}];
    case 'magistrate':return [...first,{type:'magistrate_signed',num:p[0]},{type:'magistrate_char',num:p[1]},{type:'magistrate_char',num:p[2]}];
    case 'blackmailer':return [...first,{type:'blackmailer_char',num:p[0]},{type:'blackmailer_char',num:p[1]},{type:'blackmailer_signed',num:p[2]}];
    default:return first;
  }}
  function matchStep(step){return legal().find(a=>a.type===step.type&&(step.target===undefined||a.target===step.target)&&(step.uid===undefined||a.uid===step.uid)&&(step.num===undefined||Number(a.num??a.name)===Number(step.num))&&(step.color===undefined||a.color===step.color)&&(step.mode===undefined||(a.mode||a.name)===step.mode));}
  function driveSequence(){const seq=M.sequence;if(!seq)return false;
    if(seq.index>=seq.steps.length){
      if(seq.redraw&&M.state?.turn?.pending?.kind==='magician_redraw'){
        const options=legal().filter(a=>a.type==='choose_cards');const next=options[0];const wanted=seq.redraw.has(next?.uid)?'use':'skip';const exact=options.find(a=>(a.mode||a.name)===wanted);
        if(exact||(!next?.mode&&!next?.name&&next)){send({t:'action',action:exact||next});return true;}
      }
      M.sequence=null;return false;
    }
    const step=seq.steps[seq.index],exact=matchStep(step);if(!exact){M.sequence=null;message('当前状态已变化，请重新选择角色能力');return false;}
    seq.index++;send({t:'action',action:exact});return true;
  }
  function confirmStage(){const st=M.stage;if(!st)return;const multi=stageMulti(st);if(!st.ready&&!multi)return;
    expectEffect(`${myPlayer()?.name||'我'} 发动了【${role(st.role).name||'角色'}】能力`);
    M.sequence={steps:sequenceSteps(st),index:0,redraw:st.role==='magician'&&st.picks[0]?.value==='redraw'?new Set(st.selected):null};M.stage=null;M.focus=null;render();$('selectedInfo').textContent='正在提交角色能力…';driveSequence();
  }
  const actionsClass = n => 'actions count-'+Math.min(6,n)+(n===1?' one':'');
  function renderFooter(){const s=M.state,all=legal(),choice=choiceItems();
    if(M.stage){const st=stageStep();const buttons=st.surface==='button'?st.options.map((o,i)=>`<button class="btn primary" type="button" data-stage-option="${i}" title="${esc(o.label)}">${esc(o.label)}</button>`):[];
      const multiPick=st.multi&&M.stage.selected.size>0;
      buttons.push(`<button class="btn ghost" type="button" id="stageBack">${multiPick?'返回重选':M.stage.step>0?'返回上一步':M.stage.ready?'返回重选':'返回'}</button>`);
      if(M.stage.ready||st.multi)buttons.push(`<button class="btn gold" type="button" id="stageConfirm">确认发动${st.multi?' · '+M.stage.selected.size+' 张':''}</button>`);
      M.actions=[];$('selectedInfo').textContent=stageHint();
      $('actions').className=actionsClass(buttons.length);
      $('actions').innerHTML=buttons.join('');return;}
    if(M.confirm){M.actions=[];$('selectedInfo').textContent=M.confirm.hint;
      $('actions').className=actionsClass(2);
      $('actions').innerHTML=`<button class="btn ghost" type="button" id="confirmBack">返回</button><button class="btn purple" type="button" id="confirmAction">确认发动</button>`;return;}
    const generic=all.filter(a=>!['draft_pick','draft_discard','build','draw_keep','scholar_pick','wizard_card','prophet_give','choose_char','magistrate_signed','magistrate_char','blackmailer_signed','blackmailer_char'].includes(a.type));
    const grouped=[];const seen=new Set();for(const a of generic){const target=['choose_player','spy_target','wizard_target','emperor_crown','choose_district'].includes(a.type);
      const key=target?a.type:((a.type==='lab'||a.type==='museum')?a.type:JSON.stringify(a));if(seen.has(key))continue;seen.add(key);grouped.push({...a,_targetGroup:target});}
    M.actions=grouped.filter(a=>!a._targetGroup&&!(M.selection&&a.type==='choose_cards'));
    const prompt=s.available?.prompt||(s.phase==='draft'?'选角阶段':s.phase==='gameover'?'游戏结束':'等待其他玩家行动');
    $('selectedInfo').textContent=M.targetType?'在公开区域选择目标玩家':choice?choice.title:prompt;
    const buttons=M.actions.map((a,i)=>`<button class="btn ${a.type==='end_turn'||a.type==='ability_skip'?'ghost':a.type==='ability'?'purple':'primary'}" type="button" data-action-index="${i}" title="${esc(a.label||a.type)}">${esc(a._targetGroup?(a.type==='choose_district'?'选择目标建筑':'选择目标玩家'):a.label||a.type)}</button>`);
    const current=s.phase==='draft'?s.draft?.currentPlayer:s.turn?.playerId;
    if(current===M.id&&!M.targetType&&!M.selection&&choice)buttons.unshift(`<button class="btn gold" type="button" id="chooseTarget">${esc(String(choice.title||'选择目标').replace(/^请/,''))}</button>`);
    if(!M.targetType&&!M.selection&&all.some(a=>a.type==='build'))buttons.unshift('<button class="btn gold" type="button" id="chooseBuild">建造建筑</button>');
    if(M.selection)buttons.unshift(`<button class="btn gold" type="button" id="confirmSelection">确认所选 ${M.selection.uids.size} 张</button>`,`<button class="btn ghost" type="button" id="cancelSelection">清空选择</button>`);
    $('actions').className=actionsClass(buttons.length);
    const waiting=s.phase==='gameover'?'对局已结束':current!==M.id?'等待其他玩家':M.targetType?'点击上方高亮玩家选择目标':M.selection?'点击手牌选择要偿还的建筑牌':choice?'点击上方卡牌完成选择':'请从上方选择行动';
    $('actions').innerHTML=buttons.join('')||`<button class="btn ghost" disabled>${waiting}</button>`;
  }
  function findCard(key,kind){const s=M.state;if(kind==='role')return [ ...(s.charDeck||[]),...(s.draft?.pool||[]),...(s.removed?.faceUp||[]) ].find(c=>String(cardKey(c))===key)||role(key);
    const cards=[...(myPlayer()?.hand||[]),...(s.turn?.pending?.cards||[]),...s.players.flatMap(p=>p.city||[])];return cards.find(c=>String(cardKey(c))===key);}
  function openViewer(kind,card,confirm,context,stageOption){if(!card&&kind!=='back')return;M.viewer={kind,card,confirm,context,stageOption};
    $('viewerTitle').textContent=kind==='back'?'暗置角色牌':kind==='role'?`${card.num} · ${card.name} · 角色卡`:`${card.name} · 建筑卡`;
    $('viewerImg').src=kind==='back'?'./assets/themes/neon/card-back.png':kind==='role'?roleImg(card,'full'):districtImg(card,'full');
    $('viewerMeta').innerHTML=kind==='back'?'暗置弃置角色的身份不会公开。':kind==='role'?`编号 ${esc(card.num)} · ${esc(card.name)}`:`<span class="color-dot" style="--district-color:${C[card.color]||C.purple}"></span><span>${esc(CN[card.color]||'独特')} · 费用 ${esc(card.cost)} · ${esc(context||'点击查看卡牌')}</span>`;
    const pick=stageOption>=0, act=confirm||pick;
    $('viewerActions').className='viewer-actions '+(act?'two':'');
    $('viewerActions').innerHTML='<button class="btn ghost" type="button" id="viewerBack">返回</button>'+(act?`<button class="btn ${confirm?.type==='draft_discard'?'danger':'gold'}" type="button" id="viewerConfirm">${esc(confirm?.label||'确认选择')}</button>`:'');
    $('viewer').classList.add('show');
  }
  function closeViewer(){M.viewer=null;$('viewer').classList.remove('show');$('viewerImg').removeAttribute('src');}
  function closeSheet(){M.sheetPlayer=null;$('sheet').classList.remove('show','player-detail-mode');$('mask').classList.remove('show','player-detail-mode');}
  function renderDetail(playerId){const p=M.state.players.find(x=>x.id===playerId);if(!p){closeSheet();return;}
    M.sheetPlayer=playerId;const s=score(p),ch=p.revealedCharId&&!(M.state.phase==='draft'&&p.id!==M.id)?role(p.revealedCharId):null;
    const st=stageStep(),staging=!!M.stage&&(st.surface==='player'||st.surface==='district');
    const target=staging?st.options.filter(o=>st.surface==='player'?String(o.value)===String(p.id):String(o.target)===String(p.id)):legal().filter(a=>a.type===M.targetType&&a.target===p.id);
    $('sheetTitle').textContent=(target.length?'选择目标 · ':'')+p.name+(p.id===M.id?' · 你':'');
    const rewards=(s.detail||[]).filter(d=>d.label!=='建筑总分');
    const roleBlock=ch?`<div class="detail-role-card"><button class="detail-role-thumb" type="button" data-kind="role" data-key="${attr(ch.id)}"><img src="${attr(roleImg(ch))}" alt="${attr(ch.name)}"></button><div class="detail-role-caption">${esc(ch.num)} · ${esc(ch.name)}</div></div>`:'';
    const scoreBlock=`<div class="score-compact"><div class="score-left-stack"><div class="score-kpi"><span>建筑分</span><b>${esc(s.base)}</b></div><div class="score-kpi total"><span>总分</span><b>${esc(s.total)}</b></div></div><div class="score-reward-card"><div class="score-reward-head"><span>奖励分</span><b>+${esc(s.bonus)}</b></div>${rewards.length?`<ul class="score-reward-detail">${rewards.map(d=>`<li class="score-reward-row"><span>${esc(d.label)}</span><strong>${d.value>=0?'+':''}${esc(d.value)}</strong></li>`).join('')}</ul>`:'<div class="score-reward-empty">暂无奖励分</div>'}</div></div>`;
    const cardActions=staging?(st.surface==='district'?target:[]):target.filter(a=>a.type==='choose_district');
    $('sheetBody').innerHTML=`${target.length?`<div class="target-context">已选择玩家 <b>${esc(p.name)}</b>。${staging?(st.surface==='district'?'请在下方城区选择目标建筑。':'确认后才记入能力选择，仍可返回重选。'):cardActions.length?'请在下方城区选择目标建筑。':'确认后发动效果。'}</div>`:''}
      <div class="detail-summary"><div class="detail-stat"><span>金币</span><div class="detail-stat-line"><i class="coin-icon"></i><b>${esc(p.gold)}</b></div></div><div class="detail-stat"><span>当前得分</span><div class="detail-stat-line"><i class="score-icon"></i><b>${esc(s.total)}</b></div></div><div class="detail-stat"><span>城区</span><b>${(p.city||[]).length}</b></div><div class="detail-stat"><span>手牌</span><div class="detail-stat-line"><i class="hand-back"></i><b>×${esc(p.handCount)}</b></div></div></div>
      <div class="detail-role-score ${ch?'':'no-role'}">${roleBlock}${scoreBlock}</div>
      <div class="detail-block"><div class="detail-block-title"><span>${cardActions.length?'选择建筑':'公开城区'} · ${(p.city||[]).length} 栋</span><span>${cardActions.length?'点小卡继续':'点击小卡查看高清'}</span></div><div class="detail-cards">${(p.city||[]).map(c=>`<button class="detail-card-btn ${cardActions.some(a=>String(a.uid||a.value)===String(c.uid))?'targetable':''}${staging&&st.multi&&stagePicked(c.uid)?' selected':''}" type="button" data-detail-card="${attr(c.uid)}"><img src="${attr(districtImg(c))}" alt="${attr(c.name)}"><div class="detail-card-name">${esc(c.name)} · ${esc(c.cost)}</div></button>`).join('')}</div></div>
      ${target.length&&!cardActions.length?`<div class="sheet-target-actions"><button class="btn ghost" type="button" id="detailBack">返回重选</button><button class="btn primary" type="button" ${staging?`data-stage-option="${stageIndexOf(p.id)}"`:`id="detailConfirm"`}>确认选择 ${esc(p.name)}</button></div>`:''}`;
    $('sheet').classList.add('show','player-detail-mode');$('mask').classList.add('show','player-detail-mode');
  }
  function handleCard(kind,key){const card=findCard(key,kind);if(kind==='back'){openViewer('back');return;}if(!card)return;
    const stage=stageStep();
    if(kind==='district'&&stage&&stage.surface==='hand'){const i=stageIndexOf(key);if(i>=0)chooseStageOption(i);return;}
    let confirm=null;const choice=choiceItems();if(choice&&choice.kind===kind)confirm=choice.action(card);
    if(kind==='district'){
      const target=legal().find(a=>a.type==='choose_district'&&a.target===M.sheetPlayer&&a.uid===card.uid);
      confirm=target||confirm||legal().find(a=>(a.type==='build'||a.type==='wizard_build')&&a.uid===card.uid);
      if(M.selection){
        if(!selectionAllowed(M.selection.type).has(card.uid)){$('selectedInfo').textContent=card.uid===M.state.turn?.pending?.uid?'这张牌正用于建造，不能用来偿还':'这张牌不可用于当前选择';return;}
        M.selection.uids.has(card.uid)?M.selection.uids.delete(card.uid):M.selection.uids.add(card.uid);render();return;
      }
    }
    const idx=stage&&kind==='role'&&stage.surface==='role'?stageIndexOf(card.num):stage&&kind==='district'&&stage.surface==='district'?stageIndexOf(card.uid):-1;
    const owner=idx>=0&&stage.surface==='district'?stage.options[idx].target:null;
    openViewer(kind,card,confirm,owner?(M.state.players.find(x=>x.id===owner)?.name||''):null,idx);
  }
  function handleGeneric(a){if(a.type==='ability'){if(startStage())return;
      const r=role(M.state?.turn?.charId);M.confirm={action:a,hint:`【${r.name||'角色'}】${r.desc||'发动角色能力'}`};render();return;}
    if(a._targetGroup){M.targetType=a.type;focusArea('players');return;}
    if(a.type==='lab'||a.type==='museum'){M.selection={type:a.type,uids:new Set(),base:a};focusArea('hand');return;}
    if(a.type==='choose_cards'){
      if((a.mode||a.name)==='skip'||(a.mode||a.name)==='use'){action(a);return;}
      M.selection={type:'choose_cards',uids:new Set(),base:a};focusArea('hand');return;
    }
    action(a);
  }
  function confirmSelection(){const sel=M.selection;if(!sel)return;const uids=[...sel.uids];if(sel.type==='choose_cards'){
      const pending=M.state.turn?.pending;
      if(pending?.kind==='bishop_repay'&&uids.length!==pending.amount){$('selectedInfo').textContent=`请选择 ${pending.amount} 张手牌`;return;}
      const chosen=new Set(uids);
      const exact=legal().find(a=>a.type==='choose_cards'&&Array.isArray(a.uids)&&a.uids.length===uids.length&&a.uids.every(uid=>chosen.has(uid)));
      if(!exact){$('selectedInfo').textContent='这组手牌当前不可提交，请重新选择';return;}
      action(exact);return;
    }
    if(uids.length!==1){$('selectedInfo').textContent='请选择一张手牌';return;}
    const field=sel.type==='museum'?'cardUid':'discardUid';
    const exact=legal().find(a=>a.type===sel.type&&a.uid===sel.base.uid&&a[field]===uids[0]);
    if(!exact){$('selectedInfo').textContent='这张手牌当前不可用，请重新选择';return;}
    action(exact);
  }
  document.addEventListener('click',e=>{
    if($('eventOverlay')&&!$('eventOverlay').hidden){if(e.target.id==='eventOk'||e.target.id==='eventOverlay')closeEvent();e.stopPropagation();return;}
    const fold=e.target.closest('[data-fold]');if(fold){if(fold.dataset.fold==='handSection')M.handOpen=!M.handOpen;else M.roleOpen=!M.roleOpen;render();return;}
    const stageOpt=e.target.closest('[data-stage-option]');if(stageOpt){chooseStageOption(Number(stageOpt.dataset.stageOption));return;}
    if(e.target.id==='stageBack'){backStage();return;}
    if(e.target.id==='stageConfirm'){confirmStage();return;}
    const publicCity=e.target.closest('.player-row .city-mini');
    if(publicCity){const st=stageStep();if(st&&st.surface==='district'){handleCard('district',publicCity.dataset.key);return;}
      const row=publicCity.closest('[data-player]');if(row)renderDetail(row.dataset.player);return;}
    const card=e.target.closest('[data-kind]');if(card){e.preventDefault();e.stopPropagation();handleCard(card.dataset.kind,card.dataset.key);return;}
    const detail=e.target.closest('[data-detail-card]');if(detail){const p=M.state.players.find(x=>x.id===M.sheetPlayer),c=p?.city.find(x=>String(x.uid)===detail.dataset.detailCard);if(c){const st=stageStep();if(st&&st.surface==='district'&&stageIndexOf(c.uid)>=0){handleCard('district',String(c.uid));return;}const a=legal().find(x=>x.type==='choose_district'&&x.target===p.id&&x.uid===c.uid);openViewer('district',c,a,p.name);}return;}
    const player=e.target.closest('[data-player]');if(player){const id=player.dataset.player;const st=stageStep();
      if(st&&st.surface==='player'){if(stageIndexOf(id)>=0)renderDetail(id);return;}
      if(M.targetType&&!legal().some(a=>a.type===M.targetType&&a.target===id))return;renderDetail(id);return;}
    const button=e.target.closest('[data-action-index]');if(button){handleGeneric(M.actions[Number(button.dataset.actionIndex)]);return;}
    if(e.target.id==='viewerConfirm'){const v=M.viewer;if(v?.stageOption>=0){closeViewer();chooseStageOption(v.stageOption);}else if(v?.confirm)action(v.confirm);return;}
    if(e.target.id==='viewerBack'||e.target.id==='viewerClose'){closeViewer();return;}
    if(e.target.id==='detailConfirm'){const a=legal().find(x=>x.type===M.targetType&&x.target===M.sheetPlayer);if(a)action(a);return;}
    if(e.target.id==='detailBack'||e.target.id==='closeSheet'||e.target.id==='mask'){closeSheet();return;}
    if(e.target.id==='confirmSelection'){confirmSelection();return;}
    if(e.target.id==='chooseBuild'){focusArea('hand');return;}
    if(e.target.id==='chooseTarget'){focusArea('roles');return;}
    if(e.target.id==='confirmAction'){const c=M.confirm;M.confirm=null;if(c){const r=role(M.state?.turn?.charId);expectEffect(`${myPlayer()?.name||'我'} 发动了【${r.name||'角色'}】能力`);action(c.action);}return;}
    if(e.target.id==='confirmBack'){M.confirm=null;render();return;}
    if(e.target.id==='cancelSelection'){M.selection.uids.clear();render();return;}
  });
  function showSidebar(tab=M.sidebarTab){M.sidebar=true;M.sidebarTab=tab;$('sidebarMask').hidden=false;$('mobileSidebar').hidden=false;$('sidebarToggle').setAttribute('aria-expanded','true');$('sidebarToggle').setAttribute('aria-label','收起侧边栏');$('sidebarToggle').textContent='›';renderSidebar();}
  function hideSidebar(){M.sidebar=false;$('sidebarMask').hidden=true;$('mobileSidebar').hidden=true;$('sidebarToggle').setAttribute('aria-expanded','false');$('sidebarToggle').setAttribute('aria-label','展开侧边栏');$('sidebarToggle').textContent='‹';}
  function renderSidebar(){if(!M.sidebar)return;document.querySelectorAll('[data-sidebar-tab]').forEach(b=>b.classList.toggle('active',b.dataset.sidebarTab===M.sidebarTab));
    const log=M.state?.log||[];
    // 结构与类名对齐 PC 端：战报 .log > div.<type>，聊天 .chat-log > .chat-entry > .name/.text/.ts
    const rows=M.sidebarTab==='log'?[log.length?`<div class="log-list">${log.map(x=>`<div class="${attr(x.type||'info')}">${esc(x.text)}</div>`).join('')}</div>`:'']:M.chat.map(x=>`<div class="chat-entry${x.playerId===M.id?' self':''}"><span class="name">${esc(x.playerName||'玩家')}</span><span class="text">${esc(x.text)}</span><span class="ts">${x.sentAt?new Date(x.sentAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}</span></div>`);
    if(M.sidebarTab==='voice'){
      const roster=V.room?[V.room.localParticipant,...V.room.remoteParticipants.values()]:[];
      $('sidebarContent').innerHTML=`<div class="sidebar-entry">${V.joining?'正在连接语音…':V.room?(V.muted?'已加入 · 静音中':'已加入 · 正在通话'):'未加入语音'}</div>${V.error?`<div class="sidebar-entry">${esc(V.error)}</div>`:''}${roster.map(p=>`<div class="sidebar-entry">${esc(p.name||'玩家')}${p===V.room.localParticipant?'（我）':''}</div>`).join('')}<button class="voice-action" id="voicePrimary" type="button" ${V.joining?'disabled':''}>${V.room?(V.muted?'开麦':'静音'):'加入语音'}</button>${V.room?'<button class="voice-action secondary" id="voiceLeave" type="button">退出语音</button>':''}`;
      $('sidebarChatForm').hidden=true;return;
    }
    $('sidebarContent').innerHTML=rows.join('')||'<div class="sidebar-empty">'+(M.sidebarTab==='log'?'暂无战报':'还没有人发言')+'</div>';
    $('sidebarChatForm').hidden=M.sidebarTab!=='chat'||M.state?.phase==='gameover';
    $('sidebarContent').scrollTop=$('sidebarContent').scrollHeight;
  }
  $('sidebarToggle').onclick=()=>M.sidebar?hideSidebar():showSidebar();$('sidebarClose').onclick=hideSidebar;$('sidebarMask').onclick=hideSidebar;
  document.querySelectorAll('[data-sidebar-tab]').forEach(b=>b.onclick=()=>showSidebar(b.dataset.sidebarTab));
  $('sidebarChatForm').onsubmit=e=>{e.preventDefault();const input=$('sidebarChatInput'),value=input.value.trim();if(value){send({t:'chat',text:value});input.value='';}};
  function loadVoiceSdk(){if(window.LivekitClient)return Promise.resolve(window.LivekitClient);return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='./vendor/livekit-client.umd.min.js';script.onload=()=>window.LivekitClient?resolve(window.LivekitClient):reject(new Error('语音组件加载失败'));script.onerror=()=>reject(new Error('语音组件加载失败'));document.head.appendChild(script);});}
  async function joinVoice(){if(V.room||V.joining)return;V.joining=true;V.error='';renderSidebar();try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器不允许使用麦克风');
      const sdk=await loadVoiceSdk(),saved=session();const res=await fetch((saved?.server||location.origin)+'/api/voice/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:saved.roomId,resumeToken:saved.token})});
      const data=await res.json();if(!res.ok)throw new Error(data.error||'服务器拒绝语音连接');
      const room=new sdk.Room({adaptiveStream:false,dynacast:false,disconnectOnPageLeave:true});
      room.on(sdk.RoomEvent.TrackSubscribed,track=>{if(track.kind!==sdk.Track.Kind.Audio)return;const node=track.attach();node.autoplay=true;node.setAttribute('playsinline','');$('voiceAudio').appendChild(node);});
      room.on(sdk.RoomEvent.TrackUnsubscribed,track=>{track.detach().forEach(node=>node.remove());});
      room.on(sdk.RoomEvent.ParticipantConnected,renderSidebar);room.on(sdk.RoomEvent.ParticipantDisconnected,renderSidebar);
      room.on(sdk.RoomEvent.Disconnected,()=>{V.room=null;V.muted=true;$('voiceAudio').replaceChildren();renderSidebar();});
      await room.connect(data.url,data.token);V.room=room;try{await room.localParticipant.setMicrophoneEnabled(true);V.muted=false;}catch(_){V.muted=true;V.error='麦克风不可用，当前只能收听';}
    }catch(error){V.error=error.message||'加入语音失败';}finally{V.joining=false;renderSidebar();}}
  $('sidebarContent').onclick=async e=>{if(e.target.id==='voicePrimary'){if(!V.room)await joinVoice();else{try{await V.room.localParticipant.setMicrophoneEnabled(V.muted);V.muted=!V.muted;}catch(error){V.error=error.message||'麦克风不可用';}renderSidebar();}}if(e.target.id==='voiceLeave'){V.room?.disconnect();V.room=null;V.muted=true;$('voiceAudio').replaceChildren();renderSidebar();}};
  $('menuButton').onclick=()=>{M.menu=true;$('menuOverlay').hidden=false;const s=M.state;$('roomInfo').textContent=M.room?'房间号 '+M.room+' · '+(s?.roomName||'')+' · 第 '+(s?.round||1)+' 轮 · '+(s?.endDistricts||8)+' 栋结束':'尚未进入房间';};
  const closeMenu=()=>{M.menu=false;$('menuOverlay').hidden=true;};
  $('menuClose').onclick=closeMenu;$('menuCloseBottom').onclick=closeMenu;
  const speeds={slow:['慢速',1300],normal:['标准',820],fast:['快速',330]};
  function syncSpeed(){$('menuSpeed').textContent='电脑速度 · '+speeds[M.speed]?.[0];}syncSpeed();
  $('menuSpeed').onclick=()=>{const order=['slow','normal','fast'];M.speed=order[(order.indexOf(M.speed)+1)%3];localStorage.setItem('citadels.speed',M.speed);send({t:'setPace',pace:speeds[M.speed][1]});syncSpeed();};
  function openReference(title,html){closeMenu();$('referenceTitle').textContent=title;$('referenceBody').innerHTML=html;$('referenceOverlay').hidden=false;}
  function closeReference(){$('referenceOverlay').hidden=true;$('referenceBody').innerHTML='';}
  $('referenceClose').onclick=closeReference;$('referenceOverlay').onclick=e=>{if(e.target.id==='referenceOverlay')closeReference();};
  // 角色 / 建筑一览：直接沿用 PC 端 #modal 的结构与类名（app.js openCharacters / openBuildings）
  $('menuRoles').onclick=()=>{const cards=(M.state?.charDeck?.length?M.state.charDeck:window.CitCards.CHARACTERS).slice().sort((a,b)=>a.num-b.num);
    openReference('角色一览','<div class="section-title">本局角色（按编号）</div><div class="char-grid">'+cards.map(c=>`<button class="ref-card" type="button" data-ref-role="${attr(c.id)}"><img class="rc-art" src="${attr(roleImg(c))}" alt="${attr(c.name)}" loading="lazy" decoding="async"><h4><span class="rc-num">${esc(c.num)}</span>${esc(c.name)}<span class="rc-en">${esc(c.en||'')}</span></h4></button>`).join('')+'</div>');};
  $('menuBuildings').onclick=()=>{const data=window.CitCards,cols=['yellow','blue','green','red','purple'];
    const legend=`<div class="section-title">建筑颜色与收入角色</div><div class="color-legend">${cols.map(k=>{const c=data.COLORS[k];
      return `<span><i class="dot" style="background:${attr(c.hex)}"></i>${esc(c.name)}（${esc(c.en)}）${c.incomeChar?' — 提供 '+esc(c.incomeChar)+' 号角色收入':' — 独特建筑'}</span>`;}).join('')}</div>`;
    const groups=cols.map(k=>{const c=data.COLORS[k];
      return `<div class="color-sub">${esc(c.name)}（${esc(c.en)}）</div><div class="char-grid">`+data.DISTRICTS.filter(d=>d.color===k).sort((a,b)=>a.cost-b.cost).map(d=>`<button class="ref-card c-${k}" type="button" data-ref-district="${attr(d.name)}"><img class="rc-art district-ref-art" src="${attr(districtImg(d))}" alt="${attr(d.name)}" loading="lazy" decoding="async"><h4>${esc(d.name)}<span class="rc-en">${esc(d.en||'')} · ${esc(d.cost)} 金</span></h4>${d.desc?`<p>${esc(d.desc)}</p>`:'<p class="dim">— 无特殊效果，仅计入建筑分</p>'}</button>`).join('')+'</div>';}).join('');
    const scoring=`<div class="section-title">计分方式</div><p class="small">建筑总分（建造费用之和，巨龙门/大学按 8 分计）＋ 五色齐全 +3 ＋ 率先建成 ${esc(M.state?.endDistricts??8)} 栋 +4（其余达标者 +2）＋ 博物馆/美化等特殊加分。</p>`;
    openReference('建筑一览',legend+'<div class="section-title">全部建筑（按颜色，含特殊效果）</div>'+groups+scoring);};
  $('referenceBody').onclick=e=>{const roleButton=e.target.closest('[data-ref-role]'),districtButton=e.target.closest('[data-ref-district]');if(roleButton){const c=(M.state?.charDeck||window.CitCards.CHARACTERS).find(x=>x.id===roleButton.dataset.refRole);if(c)openViewer('role',c);}if(districtButton){const c=window.CitCards.DISTRICTS.find(x=>x.name===districtButton.dataset.refDistrict);if(c)openViewer('district',c);}};
  $('menuRules').onclick=()=>openReference('游戏规则','<div class="section-title">一局总体流程</div><p>随机移除部分角色牌后，由皇冠持有者开始秘密选角。角色按编号依次被叫号并行动。本轮全部角色行动完毕后重洗角色牌，进入下一轮。</p><div class="section-title">每回合</div><p>领取资源：拿 2 枚金币，或抽 2 张建筑牌保留 1 张。之后可建造建筑、使用一次角色能力、领取对应颜色建筑收入，最后结束回合。通常每回合只能建造 1 栋，同名建筑不可重复。</p><div class="section-title">结束与计分</div><p>有人达到本局的建筑数量目标后，在本轮结束时计分。分数包括建筑费用、五色齐全奖励、达标奖励和特殊建筑奖励。总分最高者获胜。</p>');
  $('menuLog').onclick=()=>{closeMenu();showSidebar('log');};$('menuChat').onclick=()=>{closeMenu();showSidebar('chat');};
  $('menuVoice').onclick=()=>{closeMenu();showSidebar('voice');};
  const leaveToLobby=()=>{closeMenu();try{localStorage.removeItem(SESSION);}catch(_){}
    if(M.room&&M.ws?.readyState===1){M.leavePending=true;send({t:'leaveRoom'});setTimeout(()=>{if(M.leavePending)location.replace('./index.html');},1500);}
    else location.replace('./index.html');
  };
  $('menuNewGame').onclick=leaveToLobby;
  $('overExit').onclick=leaveToLobby;
  $('overAgain').onclick=()=>{send({t:'restart'});$('overOverlay').hidden=true;$('selectedInfo').textContent='正在开始新对局…';};
  $('viewer').onclick=e=>{if(e.target.id==='viewer')closeViewer();};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('eventOverlay')&&!$('eventOverlay').hidden){closeEvent();}else if($('viewer').classList.contains('show'))closeViewer();else if(M.stage){backStage();}else if(M.confirm){M.confirm=null;render();}else if(M.focus){M.focus=null;render();}else if(!$('referenceOverlay').hidden)closeReference();else if($('sheet').classList.contains('show'))closeSheet();else if(M.sidebar)hideSidebar();else closeMenu();}});
  setInterval(()=>{if(M.ws?.readyState===1)send({t:'heartbeat',ts:Date.now()});},5000);
  connect();
})();
