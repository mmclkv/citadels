/* Shared read-only perspective control for desktop and mobile games. */
(() => {
  'use strict';
  class CitadelsSpectator extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({mode: 'open'});
      root.innerHTML = `<style>
        :host { display:block; flex:none; min-width:0; margin:6px 8px; padding:8px; border:1px solid var(--line,#33516a); border-radius:10px; background:var(--paper,#071421); color:var(--ink,#e0ecf6); }
        :host([hidden]) { display:none; }
        label { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font:14px sans-serif; }
        select { flex:1; min-width:0; max-width:100%; padding:7px; border:1px solid #9b834b; border-radius:6px; background:#fff7e3; color:#302718; }
        small { opacity:.75; }
        .players { display:flex; gap:6px; overflow-x:auto; margin-top:7px; padding-bottom:2px; }
        button { flex:none; min-height:34px; padding:5px 10px; border:1px solid #52708a; border-radius:7px; background:transparent; color:inherit; cursor:pointer; }
        button[aria-pressed="true"] { border-color:#d6ab4b; background:#d6ab4b; color:#211906; font-weight:bold; }
        button:focus-visible { outline:2px solid #d6ab4b; outline-offset:2px; }
      </style><label>观战视角 <select aria-label="观战视角"></select><small>仅查看</small></label><div class="players" role="group" aria-label="选择观战玩家"></div>`;
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
        this.shadowRoot.querySelector('.players').replaceChildren(...players.map(p => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.playerId = p.id;
          button.textContent = `${p.seat + 1} · ${p.name}`;
          button.setAttribute('aria-label', `观战 ${p.name} 的视角`);
          button.onclick = () => {
            if (this.send) this.send({t:'spectatePlayer', playerId:p.id});
          };
          return button;
        }));
      }
      select.value = state.viewPlayerId;
      this.shadowRoot.querySelectorAll('[data-player-id]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.playerId === state.viewPlayerId));
      });
    }
  }
  customElements.define('c-citadels-spectator', CitadelsSpectator);
})();
