'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
class El{constructor(t){this.tagName=(t||'div').toUpperCase();this._cls='';this.children=[];this.dataset={};this._html='';this._text='';this.hidden=false;this.style={};this.value='';this.title='';this.scrollTop=0;this.scrollHeight=100;this.classList={add:c=>{const s=new Set(this._cls.split(' ').filter(Boolean));s.add(c);this._cls=[...s].join(' ');},remove:c=>{const s=new Set(this._cls.split(' ').filter(Boolean));s.delete(c);this._cls=[...s].join(' ');},contains:c=>this._cls.split(' ').includes(c),toggle:c=>{this.classList.contains(c)?this.classList.remove(c):this.classList.add(c);}};}
get className(){return this._cls;}set className(v){this._cls=v||'';}get innerHTML(){return this._html;}set innerHTML(v){this._html=String(v);this.children=[];}get textContent(){return this._text;}set textContent(v){this._text=String(v);}appendChild(c){this.children.push(c);return c;}addEventListener(){}}
const reg={};const getEl=s=>(reg[s]||(reg[s]=new El('div')));
const document={createElement:t=>new El(t),querySelector:getEl,querySelectorAll:s=>s==='.screen'?['home','setup','lobby','game','over'].map(x=>getEl('#screen-'+x)):[],addEventListener:()=>{}};
const sandbox={document,console,setTimeout,clearTimeout,Math,JSON,Date,String,Number,Array,Object,Set,WebSocket:function(){this.readyState=0;this.send=()=>{};this.close=()=>{};},location:{protocol:'http:',host:'localhost:8787'},confirm:()=>true,alert:()=>{}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);
['src/cards.js','src/engine.js','src/ai.js','public/app.js'].forEach(f=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),sandbox,{filename:f}));
const App=sandbox.__CitadelsApp;const drive=App.__local;
// 关键：模拟真人把所有可能的“选择”都做了（含弹窗里选卡），否则会和真实浏览器一样卡在弹窗
function humanAct(s){
  const av=s.available;
  if(av&&av.actions&&av.actions.length){
    const a=av.actions.find(x=>x.type==='draft_pick')||av.actions.find(x=>x.type==='draft_discard')||av.actions.find(x=>x.type==='build')||av.actions.find(x=>x.type==='income')||av.actions.find(x=>x.type==='take_gold')||av.actions.find(x=>x.type==='take_cards')||av.actions.find(x=>x.type==='end_turn')||av.actions[0];
    drive.send(a);return true;
  }
  const t=s.turn;
  if(t&&t.pending&&t.playerId===App.myId){
    if(t.pending.kind==='draw_keep'&&t.pending.cards&&t.pending.cards.length){drive.send({type:'draw_keep',uid:t.pending.cards[0].uid});return true;}
    if(t.pending.kind==='scholar_pick'&&t.pending.cards&&t.pending.cards.length){drive.send({type:'scholar_pick',uid:t.pending.cards[0].uid});return true;}
    if(t.pending.kind==='prophet_give'){const me=s.players.find(p=>p.id===App.myId);if(me.hand.length){drive.send({type:'prophet_give',uid:me.hand[0].uid});return true;}}
    if(t.pending.kind==='museum'&&t.pending.cards&&t.pending.cards.length){drive.send({type:'museum',uid:t.pending.cards[0].uid,cardUid:t.pending.cards[0].uid});return true;}
  }
  return false;
}
function run(n,cs,end){
  getEl('#cfg-players').value=String(n);getEl('#cfg-level').value='normal';getEl('#cfg-end').value=String(end);getEl('#cfg-chars').value=cs;getEl('#cfg-name').value='我';
  getEl('#btn-start-single').onclick();
  let guard=0;
  while(App.state.phase!=='gameover'&&guard<20000){
    guard++;
    if(humanAct(App.state))continue;
    drive.step(); // 轮到电脑：同步推进（真实浏览器里靠 schedule 的 setTimeout 自动推进）
  }
  console.log((n+'人/'+cs+'/'+end+'栋')+' -> phase='+App.state.phase+' 轮次='+(App.state.round||'-')+' steps='+guard+(App.state.phase==='gameover'?' ✓':' ✗'));
}
run(2,'base',8);run(2,'dark',8);run(3,'base',8);run(4,'mixed',8);run(5,'base',7);run(8,'base',8);run(7,'dark',8);
