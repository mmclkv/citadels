/* 富饶之城主题管理器：只管理视觉状态，不触碰引擎、AI 或联机状态。 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'citadels.ui.theme';
  const THEMES = {
    classic: { id: 'classic', label: '经典羊皮纸' },
    neon: (root.CitadelThemeManifests && root.CitadelThemeManifests.neon) ||
      { id: 'neon', label: '暗夜赛博霓虹-女性力量', cards: { roles: {}, districts: {} } }
  };
  const listeners = [];
  const textCardCache = new Map();
  const xml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  function textDistrictAsset(district, theme) {
    const reference = ((root.CitCards && root.CitCards.DISTRICTS) || []).find(card =>
      (district.en && card.en === district.en) || card.name === district.name);
    const card = Object.assign({}, reference, district);
    const colors = { yellow: '#dbad43', blue: '#65a8e7', green: '#72bd8c', red: '#e57870', purple: '#b28ce8' };
    const names = { yellow: '皇家', blue: '宗教', green: '商业', red: '军事', purple: '独特' };
    const color = colors[card.color] || colors.purple;
    const description = card.desc || (reference && reference.desc) || '无特殊效果，计入建筑分。';
    const key = JSON.stringify([theme, card.name, card.en, card.color, card.cost, card.scoreValue, description]);
    if (textCardCache.has(key)) return textCardCache.get(key);
    const lines = String(description).split(/\r?\n/).flatMap(line => line.match(/.{1,16}/gu) || ['']);
    const fontSize = Math.min(16, 205 / Math.max(1, lines.length) / 1.5);
    const dark = theme !== 'classic';
    const ink = dark ? '#edf3fa' : '#33291f';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" viewBox="0 0 320 480">
      <rect x="3" y="3" width="314" height="474" rx="16" fill="${dark ? '#0b1422' : '#fdf8ef'}" stroke="${color}" stroke-width="5"/>
      <rect x="13" y="13" width="294" height="454" rx="10" fill="none" stroke="${color}" opacity=".5"/>
      <g font-family="PingFang SC,Microsoft YaHei,sans-serif" fill="${ink}">
        <circle cx="43" cy="43" r="23" fill="${color}"/><text x="43" y="51" text-anchor="middle" fill="#101521" font-size="25" font-weight="bold">${xml(card.cost)}</text>
        <text x="86" y="49" font-size="15" fill="${color}">${xml(names[card.color] || '独特')}建筑</text>
        <text x="160" y="99" text-anchor="middle" font-size="28" font-weight="bold">${xml(card.name || '建筑')}</text>
        <text x="160" y="124" text-anchor="middle" font-size="12" fill="${color}">${xml(card.en || '')}</text>
        <path d="M25 142H295M25 427H295" stroke="${color}"/>
        <text x="25" y="168" font-size="14" font-weight="bold" fill="${color}">建筑效果</text>
        ${lines.map((line, index) => `<text x="25" y="${198 + index * fontSize * 1.5}" font-size="${fontSize}">${xml(line)}</text>`).join('')}
        <text x="160" y="451" text-anchor="middle" font-size="14">建造费用 ${xml(card.cost)} 金币 · 建筑分 ${xml(card.scoreValue == null ? card.cost : card.scoreValue)}</text>
      </g></svg>`;
    const asset = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    textCardCache.set(key, asset);
    return asset;
  }
  const manager = {
    current: 'neon',

    available() { return Object.keys(THEMES); },
    info(id) { return THEMES[id] || THEMES.classic; },
    is(id) { return this.current === id; },
    label(id) { return this.info(id || this.current).label; },

    apply(id, opts) {
      id = THEMES[id] ? id : 'classic';
      const changed = this.current !== id;
      this.current = id;
      if (root.document && root.document.documentElement) {
        root.document.documentElement.setAttribute('data-theme', id);
      }
      if (!(opts && opts.persist === false)) {
        try { root.localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* 隐私模式 */ }
      }
      this.updateControls();
      if (changed || (opts && opts.force)) {
        listeners.slice().forEach(fn => { try { fn(id); } catch (e) { /* 主题切换不应中断对局 */ } });
      }
      return id;
    },

    init() {
      let saved = 'neon';
      try { saved = root.localStorage.getItem(STORAGE_KEY) || 'neon'; } catch (e) { /* 隐私模式 */ }
      return this.apply(saved, { persist: false });
    },

    toggle() {
      const ids = this.available();
      const i = ids.indexOf(this.current);
      return this.apply(ids[(i + 1) % ids.length]);
    },

    onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    updateControls() {
      if (!root.document) return;
      const controls = root.document.querySelectorAll('[data-theme-choice]');
      Array.prototype.forEach.call(controls, el => {
        const selected = el.getAttribute('data-theme-choice') === this.current;
        el.classList.toggle('selected', selected);
        el.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      const labels = root.document.querySelectorAll('[data-theme-label]');
      Array.prototype.forEach.call(labels, el => { el.textContent = this.label(); });
    },

    roleAsset(character, variant) {
      const id = typeof character === 'string' ? character : character && character.id;
      const entry = this.info('neon').cards.roles[id];
      return entry ? entry[variant === 'full' ? 'full' : 'thumb'] : null;
    },

    districtKey(district) {
      const raw = district && (district.assetKey || district.en || district.name);
      if (!raw) return null;
      const safe = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      return 'district_' + safe;
    },

    districtAsset(district, variant) {
      const key = this.districtKey(district);
      const entry = key && this.info('neon').cards.districts[key];
      return (entry && entry[variant === 'full' ? 'full' : 'thumb']) ||
        (district && district.name ? this.districtTextAsset(district) : null);
    },

    districtTextAsset(district) {
      return textDistrictAsset(district || {}, this.current);
    }
  };

  root.CitadelThemeManager = manager;
  manager.init();
})(typeof window !== 'undefined' ? window : this);
