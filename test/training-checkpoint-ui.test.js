'use strict';

// Browser-only checkpoint form wiring. Checkpoint storage, validation, and HTTP
// behavior are exercised by python_backend/test_server.py against the Python API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/training.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/training.js'), 'utf8');

test('checkpoint form loads config through the Python checkpoint API', () => {
  for (const id of ['load-checkpoint-config', 'checkpoint-load-message', 'resume-checkpoint']) {
    assert.ok(html.includes(`id="${id}"`), `missing form element ${id}`);
  }
  assert.match(js, /\$\('load-checkpoint-config'\)\.onclick = async/);
  assert.match(js, /\.\/api\/training\/checkpoint\?name=/);
  assert.match(js, /function applyCheckpointConfig\(config\)/);
  assert.match(js, /updateMctsHint\(\)/);
  assert.match(js, /updateCompositionUI\(\)/);
});

test('checkpoint upload uses a file picker and submits the uploaded Python checkpoint name', () => {
  for (const id of ['resume-checkpoint-file', 'resume-checkpoint-name']) {
    assert.ok(html.includes(`id="${id}"`), `missing upload element ${id}`);
  }
  assert.match(js, /const RESUME_MODES =/);
  assert.match(js, /function requestCheckpointFile\(\)/);
  assert.match(js, /\/api\/training\/checkpoint\/upload\?name=/);
  assert.match(js, /resumeCheckpoint: resumeCheckpointName\(\)/);
});
