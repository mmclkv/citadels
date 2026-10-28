/* Real desktop DOM, WebSocket transport and authoritative C++ Armory actions.
 * Set CITADELS_TEST_GAME_WORKER to a compiled game_engine executable.
 * Optional: PLAYWRIGHT_PATH, PYTHON_PATH, BROWSER_CHANNEL (default msedge).
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const root = path.join(__dirname, '..');
const serverCode = `
import asyncio, os, sys, tempfile
sys.path.insert(0, os.getcwd())
from pathlib import Path
from types import SimpleNamespace
from python_backend.server import PythonServer
from python_backend.game_engine_worker import GameEngineWorker
async def main():
    Path('tmp').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir='tmp') as directory:
        os.environ['CITADELS_ADMIN_FILE'] = str(Path(directory) / 'admin.json')
        os.environ['CITADELS_REPLAY_DIR'] = str(Path(directory) / 'replays')
        os.environ['CITADELS_TRAINING_DATA_DIR'] = str(Path(directory) / 'training')
        os.environ['CITADELS_DISABLE_LOCAL_CODEX'] = '1'
        worker = GameEngineWorker(os.environ['CITADELS_TEST_GAME_WORKER'])
        try:
            app = PythonServer(SimpleNamespace(worker=None, game_worker=worker, running=True))
            server = await asyncio.start_server(app.handle, '127.0.0.1', 0)
            print('PORT=' + str(server.sockets[0].getsockname()[1]), flush=True)
            async with server:
                await server.serve_forever()
        finally:
            worker.close()
asyncio.run(main())
`;

async function main() {
  assert.ok(process.env.CITADELS_TEST_GAME_WORKER, 'Set CITADELS_TEST_GAME_WORKER to the native game engine');
  const server = spawn(process.env.PYTHON_PATH || path.join(root, '.python', 'python.exe'),
    ['-u', '-c', serverCode], { cwd: root, windowsHide: true });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + output)), 90000);
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/PORT=(\d+)/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      server.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + '\n' + output)); });
    });
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    for (const [width, victimName] of [[1280, 'Temple'], [2560, 'Keep']]) {
      const context = await browser.newContext({ viewport: { width, height: 1200 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        const NativeSocket = window.WebSocket;
        window.armorySent = [];
        window.WebSocket = class extends NativeSocket {
          constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
              const message = JSON.parse(event.data);
              if (message.state) window.armoryState = message.state;
            });
          }
          send(data) { window.armorySent.push(JSON.parse(data)); return super.send(data); }
        };
      });
      await page.goto(`http://127.0.0.1:${port}/index.html`);
      await page.waitForFunction(() => typeof document.getElementById('lobby').startDebugGame === 'function');
      const fixture = await page.evaluate(() => {
        const deck = window.CitCards.buildDistrictDeck();
        const take = en => { const index = deck.findIndex(card => card.en === en); if (index < 0) throw new Error(en); return deck.splice(index, 1)[0]; };
        const armory = take('Armory'), keep = take('Keep'), temple = take('Temple');
        const completed = [];
        for (const card of deck.slice()) {
          if (completed.length === 8) break;
          if (!completed.some(other => other.en === card.en)) completed.push(take(card.en));
        }
        const roles = ['assassin', 'thief', 'magician', 'king'];
        const players = roles.map((role, seat) => ({ id: 'armory-seat-' + seat, name: '玩家 ' + (seat + 1), seat,
          isBot: false, gold: 4, hasCrown: seat === 0, chars: [role], played: [], hand: [],
          city: seat === 0 ? [armory] : seat === 1 ? [keep, temple] : seat === 2 ? completed : [] }));
        document.getElementById('lobby').startDebugGame({ phase: 'action', round: 1, rngState: 123456789,
          config: { playerCount: 4, endDistricts: 8, charSetMode: 'base' }, players, deck, discard: [],
          charDeck: roles, callQueue: roles.map((charId, playerIdx) => ({ charId, num: playerIdx + 1, playerIdx })),
          callIdx: 0, turnsCompleted: 0, firstToFinish: -1, draft: null, draftPublic: { faceUp: [], faceDownCount: 0 },
          turn: { playerIdx: 0, charId: 'assassin', num: 1, phase: 'main', takenResources: true, builds: 0, pending: null },
          effects: {}, notices: [], enabledBellTowers: [], firstFinishers: [], observations: [] });
        return { armory: armory.uid, keep: keep.uid, temple: temple.uid };
      });
      await page.waitForFunction(() => window.armoryState?.available?.actions?.some(a => a.name === 'armory'));
      const actions = await page.evaluate(() => window.armoryState.available.actions.filter(a => a.name === 'armory'));
      assert.equal(actions.length, 2, 'Completed cities must not be targetable');
      assert.ok(actions.every(a => a.cardUid && !a.secondaryUid), 'Exercise the actual native wire format');
      const activate = page.locator('#actions button').filter({ hasText: '发动军械库效果' });
      await activate.click();
      const targets = page.locator('#opponents .card.armory-target');
      await targets.first().waitFor();
      assert.equal(await targets.count(), 2);
      assert.equal(await page.locator('#actions button').count(), 1, 'Action bar only offers cancellation');
      assert.equal(await targets.first().evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(126, 220, 255)');
      await page.getByRole('button', { name: '取消发动', exact: true }).click();
      assert.equal(await targets.count(), 0, 'Cancellation clears target borders');
      await activate.click();
      const victimUid = victimName === 'Keep' ? fixture.keep : fixture.temple;
      const victim = page.locator(`#opponents .opp-city .card[data-uid="${victimUid}"]`);
      await victim.hover();
      assert.equal(await page.locator('#char-zoom').isVisible(), false, 'Hover preview must not obstruct a target');
      await victim.click();
      await page.waitForFunction(({ armory, victim }) => {
        const state = window.armoryState;
        return state && !state.players.some(p => p.city.some(c => c.uid === armory || c.uid === victim));
      }, { armory: fixture.armory, victim: victimUid });
      const sent = await page.evaluate(() => window.armorySent.filter(m => m.action?.name === 'armory'));
      assert.equal(sent.length, 1, 'One board click submits one Armory action');
      assert.equal(sent[0].action.cardUid, victimUid);
      assert.equal(sent[0].action.uid, fixture.armory);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${width}px PC board highlights targets and destroys Armory + ${victimName} via real C++/WebSocket`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
