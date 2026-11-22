import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { releaseSecurity } from '../dist/security.js';

async function start(t,evalCounter,origin='https://regutrack.example.test') {
  const app=express();
  app.use(releaseSecurity({eval:evalCounter},origin));
  app.post(/.*/,(_req,res)=>res.status(204).end());
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}

test('cross-origin writes are denied before the shared counter and requests receive a fresh ID',async(t)=>{
  let calls=0;
  const base=await start(t,async()=>++calls);
  const cross=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin:'https://other.example.test'}});
  assert.equal(cross.status,403);
  assert.equal(calls,0);
  const own=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{origin:'https://regutrack.example.test'}});
  assert.equal(own.status,204);
  assert.equal(calls,1);
  assert.notEqual(own.headers.get('x-request-id'),cross.headers.get('x-request-id'));
});

test('expensive endpoints use the shared limit and fail closed if Redis is unavailable',async(t)=>{
  const base=await start(t,async()=>26);
  const limited=await fetch(base+'/api/v1/assistant/ask',{method:'POST'});
  assert.equal(limited.status,429);
  assert.equal(limited.headers.get('retry-after'),'60');
  const down=await start(t,async()=>{throw Error('unexpected');});
  const failed=await fetch(down+'/api/v1/auth/login',{method:'POST'});
  assert.equal(failed.status,503);
  assert.deepEqual(await failed.json(),{error:'Request protection is temporarily unavailable'});
});
