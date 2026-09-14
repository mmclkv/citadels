// Node-based test-suite runner: avoids bash basename/grep (unavailable in the shim).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
const TEST_DIR = path.join(__dirname, '..', 'test');

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => only.length === 0 || only.some(o => f.includes(o)))
  .sort();

const results = [];
for (const f of files) {
  const full = path.join(TEST_DIR, f);
  const r = spawnSync(NODE, ['--test', full], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  const out = (r.stdout || '') + (r.stderr || '');
  const mFail = out.match(/^# fail (\d+)$/m);
  const mPass = out.match(/^# pass (\d+)$/m);
  const fail = mFail ? Number(mFail[1]) : null;
  const pass = mPass ? Number(mPass[1]) : null;
  const ok = r.status === 0 && (fail === 0 || fail === null);
  results.push({ file: f, status: r.status, pass, fail, ok, tail: out.slice(-1500) });
}

const width = Math.max(...results.map(r => r.file.length), 10);
let totalPass = 0, totalFail = 0, bad = 0;
for (const r of results) {
  totalPass += r.pass || 0;
  totalFail += r.fail || 0;
  if (!r.ok) bad++;
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${r.file.padEnd(width)}  pass=${r.pass} fail=${r.fail} exit=${r.status}`);
}
console.log('');
console.log(`files=${results.length}  failedFiles=${bad}  totalPass=${totalPass}  totalFail=${totalFail}`);

if (bad) {
  console.log('\n===== FAILING DETAIL =====');
  for (const r of results) if (!r.ok) {
    console.log(`\n--- ${r.file} (exit=${r.status}) ---`);
    console.log(r.tail);
  }
}

const outPath = path.join(__dirname, 'suite-result.json');
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nwrote ${outPath}`);
process.exit(bad ? 1 : 0);
