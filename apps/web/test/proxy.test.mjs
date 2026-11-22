import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { preview } from 'vite';
import { createApp } from '../../api/dist/app.js';

test('Vite serves ReguTrack and forwards its readiness requests to Express', async (t) => {
  let redisUp = true;
  const api = createApp({
    postgres: async () => {},
    redis: async () => {
      if (!redisUp) throw new Error('Redis unavailable');
    },
    ai: async () => {},
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => api.close(resolve)));
  await once(api, 'listening');
  process.env.API_TARGET = 'http://127.0.0.1:' + api.address().port;

  const web = await preview({ preview: { host: '127.0.0.1', port: 0 } });
  t.after(() => web.close());
  const base = 'http://127.0.0.1:' + web.httpServer.address().port;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>ReguTrack<\/title>/);

  const ready = await fetch(base + '/api/health/ready');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, 'ready');

  redisUp = false;
  const unavailable = await fetch(base + '/api/health/ready');
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).checks.redis, 'down');
});
