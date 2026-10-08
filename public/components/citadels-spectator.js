/* Shared read-only perspective control for desktop and mobile games. */
(() => {
  'use strict';
  class CitadelsSpectator extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({mode: 'open'});
      root.innerHTML = `<style>
        :host { display:block; margin:8px 12px; }
        :host([hidden]) { display:none; }
        label { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font:14px sans-serif; }
        select { max-width:100%; padding:7px; border:1px solid #9b834b; border-radius:6px; background:#fff7e3; color:#302718; }
        small { opacity:.75; }
      </style><label>观战视角 <select aria-label="观战视角"></select><small>仅查看，无法操作</small></label>`;
      root.querySelector('select').onchange = event => {
        if (this.send) this.send({t:'spectatePlayer', playerId:event.target.value});
      };
    }
    update(state, send) {
      this.hidden = !state?.spectating;
      this.send = send;
      if (this.hidden) return;
      const select = this.shadowRoot.querySelector('select');
      const players = state.players || [];
      const key = JSON.stringify(players.map(p => [p.id, p.name, p.seat]));
      if (this.roster !== key) {
        this.roster = key;
        select.replaceChildren(...players.map(p => {
          const option = document.createElement('option');
          option.value = p.id;
          option.textContent = `座位 ${p.seat + 1} · ${p.name}`;
          return option;
        }));
      }
      select.value = state.viewPlayerId;
    }
  }
  customElements.define('c-citadels-spectator', CitadelsSpectator);
})();
