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
  const manager = {
    current: 'classic',

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
      let saved = 'classic';
      try { saved = root.localStorage.getItem(STORAGE_KEY) || 'classic'; } catch (e) { /* 隐私模式 */ }
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
      return entry ? entry[variant === 'full' ? 'full' : 'thumb'] : null;
    }
  };

  root.CitadelThemeManager = manager;
  manager.init();
})(typeof window !== 'undefined' ? window : this);
