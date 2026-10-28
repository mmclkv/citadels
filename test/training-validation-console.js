'use strict';
// Exercise the actual console script against its HTML controls, without network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.argv[2] || path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/training.html'), 'utf8');
const elements = new Map();
const paints = [];
const drawing = new Proxy({ measureText: text => ({ width: String(text).length * 6 }),
  createLinearGradient: () => ({ addColorStop() {} }),
  fillText: text => paints.push(String(text)) }, { get: (object, key) => object[key] || (() => {}) });
class Element {
  constructor(tag = 'div', value = '') { this.tagName = tag.toUpperCase(); this.value = value; this.children = []; this.disabled = false; this.checked = false; this.style = {}; this.dataset = {}; this.textContent = ''; this.classList = { add() {}, remove() {}, toggle() {} }; }
  get options() { return this.children.flatMap(c => c.tagName === 'OPTGROUP' ? c.children : c.tagName === 'OPTION' ? [c] : []); }
  get selectedOptions() { return this.options.filter(x => x.value === this.value).slice(0, 1); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0]; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  getBoundingClientRect() { return { width: 640, height: 240 }; }
  getContext() { return drawing; }
  remove() {}
}
for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  const [, tag, attrs, id] = match;
  const value = (attrs.match(/\bvalue="([^"]*)"/) || [,''])[1];
  const element = new Element(tag, value);
  if (tag === 'select') {
    const body = html.slice(match.index + match[0].length).split('</select>')[0];
    for (const option of body.matchAll(/<option\b([^>]*)>([^<]*)/g)) {
      const val = (option[1].match(/value="([^"]*)"/) || [,''])[1];
      const child = new Element('option', val); element.appendChild(child);
      if (option[1].includes('selected') || element.children.length === 1) element.value = val;
    }
  }
  elements.set(id, element);
}
const sandbox = { console, document: { getElementById: id => {
  assert(elements.has(id), `Missing HTML control ${id}`); return elements.get(id);
}, createElement: tag => new Element(tag), createDocumentFragment: () => new Element(), querySelectorAll: () => [] },
  window: { devicePixelRatio: 1, addEventListener() {} }, fetch: () => new Promise(() => {}), setInterval() {}, setTimeout() {}, URL, Date, Math };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'public/training.js'), 'utf8'), sandbox);
assert.equal(elements.get('state-encoding').value, '16');
assert.equal(elements.get('action-encoding').value, '12');
for (const [state, action] of [['14','10'], ['15','11'], ['16','12']]) {
  elements.get('state-encoding').value = state;
  vm.runInContext('updateEncodingUI()', sandbox);
  assert.equal(elements.get('action-encoding').value, action);
}
const point = { game: 200, validationGames: 2, validationDatasetId: 'frozen-A', validationValueLoss: .7,
  validationOwnValueLoss: .6, validationBaselineValueLoss: .5, validationPolicyLoss: 1, validationPolicyKl: .2,
  validationByPlayers: { 4: { value: .7, baseline: .5, samples: 10 } },
  validationByStage: { late: { value: .8, baseline: .5, samples: 4 } } };
sandbox.statusFixture = { state: 'running', running: true, config: { validationGames: 32 }, point,
  history: [{ ...point, game: 100, validationDatasetId: 'older-dataset', validationValueLoss: 100 }, point],
  logs: [], checkpoints: [], profiles: {}, encodingProfiles: {} };
vm.runInContext('render(statusFixture)', sandbox);
assert.equal(elements.get('validation-now').textContent, '2/32 局');
assert.match(elements.get('validation-breakdown').textContent, /尾盘/);
assert(paints.includes('验证价值 MSE')); assert(paints.includes('常数基线'));
assert(!paints.includes('100.00'), 'Do not mix different frozen datasets into a curve');
// During sampling, current point has no validation fields; retain saved curves.
sandbox.statusFixture.point = { game: 201 };
vm.runInContext('render(statusFixture)', sandbox);
assert.equal(elements.get('validation-now').textContent, '2/32 局');
console.log('Console controls, encoding pairs, validation curves, resume history and dataset separation passed');
