/* Dependency-free SVG plots for the belief trainer's recorded update metrics. */
(function (global) {
  'use strict';
  const charts = [
    {id:'loss', title:'训练损失', series:[['loss','训练损失','#35dcff']]},
    {id:'joint', title:'验证联合 NLL', series:[['validationJointNll','联合 NLL','#ff4fc7']]},
    {id:'role', title:'验证角色 NLL', series:[['validationRoleNll','角色 NLL','#ffd36a']]},
    {id:'hand', title:'验证手牌 NLL', series:[['validationHandNll','手牌 NLL','#55e69a']]},
    {id:'samples', title:'每次更新的样本量', count:true, series:[['trainSamples','训练样本','#35dcff'],['validationSamples','验证样本','#ffb56b']]},
    {id:'updates', title:'每次更新的梯度步数', count:true, series:[['updates','梯度步数','#b69aff']]}
  ];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function points(history, key) {
    return history.filter(p => p && finite(p.games) && p.games >= 0)
      .map(p => ({games:p.games, value:finite(p[key]) && p[key]>=0 ? p[key] : null})).sort((a,b)=>a.games-b.games);
  }
  function axis(value) {
    const abs=Math.abs(value);
    return abs && (abs<.001 || abs>=100000) ? value.toExponential(1) : Number(value.toFixed(3)).toLocaleString('zh-CN');
  }
  function valueText(value, count) { return count ? value.toLocaleString('zh-CN') : value.toFixed(4); }
  const ns='http://www.w3.org/2000/svg';
  function svgNode(tag, attributes={}, text) {
    const node=document.createElementNS(ns,tag);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,String(value));
    if (text!=null) node.textContent=text;
    return node;
  }
  function plot(card, history) {
    const {svg,definition,readout,latest}=card;
    const width=Math.max(240,svg.clientWidth), height=220;
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.replaceChildren();
    const series=definition.series.map(([key,label,color])=>({key,label,color,points:points(history,key)}));
    const values=series.flatMap(s=>s.points.filter(p=>p.value!=null).map(p=>p.value));
    const description=svgNode('desc',{},'横轴为累计采集对局数；纵轴为'+definition.title+'。缺失值不会当作零值，点击或聚焦数据点查看数值。');
    svg.append(description);
    if (!values.length) {
      latest.textContent='—';readout.textContent=history.length?'暂无有效数据':'等待首次训练更新';
      svg.append(svgNode('text',{x:width/2,y:height/2,'text-anchor':'middle',class:'belief-chart-empty'},readout.textContent));
      return;
    }
    const pad={left:56,right:14,top:18,bottom:40};
    const plotWidth=width-pad.left-pad.right, plotHeight=height-pad.top-pad.bottom;
    const games=series[0].points.map(p=>p.games);
    let minX=Math.min(...games), maxX=Math.max(...games);
    if (minX===maxX) {minX=0;maxX=Math.max(1,maxX);}
    let minY=Math.min(...values), maxY=Math.max(...values);
    const extra=Math.max((maxY-minY)*.1,Math.abs(maxY)*.05,.001);
    minY=Math.max(0,minY-extra);maxY+=extra;
    if (definition.count) {minY=Math.floor(minY);maxY=minY+3*Math.max(1,Math.ceil((maxY-minY)/3));}
    const x=value=>pad.left+(value-minX)/(maxX-minX)*plotWidth;
    const y=value=>pad.top+(maxY-value)/(maxY-minY)*plotHeight;
    for (let i=0;i<=3;i++) {
      const value=minY+(maxY-minY)*i/3, position=y(value);
      svg.append(svgNode('line',{x1:pad.left,x2:width-pad.right,y1:position,y2:position,class:'belief-chart-grid'}));
      svg.append(svgNode('text',{x:pad.left-8,y:position+4,'text-anchor':'end',class:'belief-chart-axis'},axis(value)));
    }
    const tickCount=Math.min(width<400?2:3,Math.max(1,maxX-minX));
    for (let i=0;i<=tickCount;i++) {
      const value=Math.round(minX+(maxX-minX)*i/tickCount);
      svg.append(svgNode('text',{x:x(value),y:height-23,'text-anchor':i===0?'start':i===tickCount?'end':'middle',class:'belief-chart-axis'},axis(value)));
    }
    svg.append(svgNode('text',{x:pad.left+plotWidth/2,y:height-5,'text-anchor':'middle',class:'belief-chart-axis'},'累计对局数'));
    let mostRecent=null;
    const summaries=[];
    for (const line of series) {
      let path='', connected=false, last=null;
      for (const point of line.points) {
        if (point.value==null) {connected=false;continue;}
        path+=(connected?' L':' M')+x(point.games).toFixed(2)+' '+y(point.value).toFixed(2);
        connected=true;last=point;
      }
      svg.append(svgNode('path',{d:path,fill:'none',stroke:line.color,'stroke-width':2,'stroke-linejoin':'round',class:'belief-chart-line','data-series':line.key}));
      for (const point of line.points) {
        if (point.value==null) continue;
        const label=`累计 ${point.games.toLocaleString('zh-CN')} 局 · ${line.label} ${valueText(point.value,definition.count)}`;
        svg.append(svgNode('circle',{cx:x(point.games),cy:y(point.value),r:3,fill:line.color,'aria-hidden':'true'}));
        const hit=svgNode('circle',{cx:x(point.games),cy:y(point.value),r:10,fill:'transparent',tabindex:0,role:'button','aria-label':label,
          'data-series':line.key,'data-game':point.games,'data-value':point.value,class:'belief-chart-point'});
        hit.append(svgNode('title',{},label));
        for (const event of ['pointerenter','focus','click']) hit.addEventListener(event,()=>{readout.textContent=label;});
        hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();readout.textContent=label;}});
        svg.append(hit);
      }
      if (last) {
        summaries.push(`${line.label} ${valueText(last.value,definition.count)}`);
        if (!mostRecent || last.games>=mostRecent.games) mostRecent={...last,label:line.label};
      }
    }
    latest.textContent=summaries.join(' / ');
    readout.textContent=mostRecent ? `累计 ${mostRecent.games.toLocaleString('zh-CN')} 局 · ${mostRecent.label} ${valueText(mostRecent.value,definition.count)}` : '暂无有效数据';
  }
  const mounted=new WeakMap();
  function render(root, history=[], runId='') {
    if (!root) return;
    let state=mounted.get(root);
    if (!state) {
      const cards=charts.map(definition=>{
        const article=document.createElement('article');article.className='belief-chart';
        const title=document.createElement('h3');title.id='belief-chart-title-'+definition.id;title.textContent=definition.title;
        const latest=document.createElement('p');latest.className='belief-chart-latest';
        const legend=document.createElement('div');legend.className='belief-chart-legend';
        for (const [,label,color] of definition.series) {
          const item=document.createElement('span');item.textContent=label;item.style.setProperty('--series-color',color);legend.append(item);
        }
        const svg=svgNode('svg',{role:'group','aria-labelledby':title.id,'data-chart':definition.id});
        const readout=document.createElement('p');readout.className='belief-chart-readout';readout.setAttribute('aria-live','polite');
        article.append(title,latest,legend,svg,readout);root.append(article);
        return {definition,svg,readout,latest};
      });
      state={cards,history:[],signature:'',width:root.clientWidth};mounted.set(root,state);
      const resize=()=>{if(root.clientWidth!==state.width){state.width=root.clientWidth;state.cards.forEach(c=>plot(c,state.history));}};
      if (typeof ResizeObserver!=='undefined') {state.observer=new ResizeObserver(resize);state.observer.observe(root);}
      else global.addEventListener('resize',resize);
    }
    const signature=runId+JSON.stringify(history);
    if (signature===state.signature) return;
    state.signature=signature;state.history=history;
    state.cards.forEach(card=>plot(card,history));
  }
  global.BeliefCharts={render};
})(window);
