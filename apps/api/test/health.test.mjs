import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../dist/app.js';

const healthy = async () => {};

async function start(t, overrides = {}) {
  const server = createApp({ postgres: healthy, redis: healthy, ai: healthy, ...overrides })
    .listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}/api/health`;
}

test('liveness returns the API identity without consulting dependencies', async (t) => {
  let consulted = false;
  const base = await start(t, { postgres: async () => { consulted = true; } });
  const response = await fetch(`${base}/live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', service: 'api' });
  assert.equal(consulted, false);
});

test('readiness reports all dependencies up', async (t) => {
  const base = await start(t);
  const response = await fetch(`${base}/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ready',
    checks: { postgres: 'up', redis: 'up', ai: 'up' },
  });
});

test('readiness reports failed dependencies without exposing error details', async (t) => {
  const base = await start(t, { redis: async () => { throw new Error('private detail'); } });
  const response = await fetch(`${base}/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: 'unavailable',
    checks: { postgres: 'up', redis: 'down', ai: 'up' },
  });
});
