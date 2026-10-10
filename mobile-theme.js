/* Presentation-only card art for the shared mobile client. No game/action encoding. */
(() => {
  'use strict';
  const T = window.CitadelThemeManager;
  const colors = {yellow:'#a97c15',blue:'#2c5f9c',green:'#2f7a4c',red:'#a53b30',purple:'#653fa0'};
  const names = {yellow:'皇家',blue:'宗教',green:'商业',red:'军事',purple:'独特'};
  const cache = new Map();
  const xml = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function classicAsset(kind, card, variant) {
    // Supplement visible card metadata with the existing rules reference only.
    // Hidden backs never consult a role or display a role's identity.
    const data = window.CitCards || {};
    const reference = kind === 'role' ? (data.CHARACTERS || []).find(c=>c.id===card?.id)
      : kind === 'district' ? (data.DISTRICTS || []).find(c=>c.name===card?.name) : null;
    const c = {...reference,...card};
    const back = kind === 'back';
    const color = back ? '#85643b' : colors[c.color] || '#a97c15';
    const title = back ? '富饶之城' : c.name || '卡牌';
    const subtitle = back ? '身份未公开' : kind === 'role' ? '角色卡' : (names[c.color] || '独特')+'建筑';
    const number = back ? '✦' : kind === 'role' ? c.num : c.cost;
    const description = back ? '' : c.desc || c.ability || (kind==='district'?'无特殊效果，计入建筑分。':'');
    const key = JSON.stringify([kind,variant,title,subtitle,number,color,description]);
    if(cache.has(key)) return cache.get(key);
    const lines = variant === 'full' ? (String(description).match(/.{1,16}/gu) || []) : [];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360" viewBox="0 0 240 360">
      <rect x="2" y="2" width="236" height="356" rx="14" fill="#fdf8ef" stroke="${color}" stroke-width="4"/>
      <rect x="11" y="11" width="218" height="338" rx="9" fill="none" stroke="#dfcdb2"/>
      <path d="M16 75H224M16 327H224" stroke="${color}" stroke-width="2"/>
      <g font-family="PingFang SC,Microsoft YaHei,sans-serif" text-anchor="middle" fill="#33291f">
        <circle cx="120" cy="43" r="22" fill="${color}"/><text x="120" y="51" fill="#fff" font-size="23" font-weight="bold">${xml(number)}</text>
        <text x="120" y="108" font-size="25" font-weight="bold">${xml(title)}</text>
        <text x="120" y="137" font-size="15" fill="${color}">${xml(subtitle)}</text>
        ${lines.slice(0,9).map((line,i)=>`<text x="120" y="${171+i*17}" font-size="12.5">${xml(line)}</text>`).join('')}
        ${variant !== 'full' || back ? `<text x="120" y="239" font-size="64" fill="${color}" opacity=".25">✦</text>` : ''}
        <text x="120" y="344" font-size="12" fill="#6b5c48">${back?'暗置角色牌':kind==='role'?'按编号依次行动':`建造费用 ${xml(c.cost)} 金币`}</text>
      </g></svg>`;
    const asset = 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
    cache.set(key,asset);
    return asset;
  }
  window.CitadelMobileTheme = {
    cardAsset(kind, card, variant='thumb') {
      if(T.is('classic')) return classicAsset(kind,card,variant);
      return kind==='back'?'./assets/themes/neon/card-back.png':kind==='role'
        ? T.roleAsset(card,variant) || classicAsset(kind,card,variant)
        : T.districtAsset(card,variant) || classicAsset(kind,card,variant);
    }
  };
})();
