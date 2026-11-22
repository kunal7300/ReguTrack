import { createHash,randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';

const increment = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;
const authPath=/^\/api\/v1\/auth\/(?:login|refresh)\/?$/i;
const expensivePath=/^\/api\/v1\/(?:assistant\/(?:ask|documents\/[^/]+\/index)|regulations\/(?:upload|[^/]+\/(?:analyze|compare))|requirements\/[^/]+\/gaps|tasks\/[^/]+\/evidence)\/?$/i;

export function releaseSecurity(redis:Pick<Redis,'eval'>, origin?:string): RequestHandler {
  return async (request,response,next) => {
    const started=performance.now();
    const requestId=randomUUID();
    const path=request.path;
    response.set('X-Request-Id',requestId).set('X-Content-Type-Options','nosniff').set('Referrer-Policy','no-referrer');
    response.on('finish',()=>{
      if (path.startsWith('/api/health/') && response.statusCode<400) return;
      console.info(JSON.stringify({
        event:'http.request',requestId,method:request.method,status:response.statusCode,
        durationMs:Math.round(performance.now()-started),
      }));
    });
    if (['POST','PATCH','PUT','DELETE'].includes(request.method)) {
      const sentOrigin=request.get('origin');
      if (request.get('sec-fetch-site')==='cross-site' || (origin && sentOrigin && sentOrigin!==origin)) {
        response.status(403).json({error:'Cross-origin request denied'});
        return;
      }
    }
    const mutation=['POST','PATCH','PUT','DELETE'].includes(request.method) && path.startsWith('/api/v1/');
    const group=request.method==='POST' && authPath.test(path) ? 'auth'
      : request.method==='POST' && expensivePath.test(path) ? 'processing' : mutation ? 'write' : null;
    if (group) {
      const client=createHash('sha256').update(request.ip ?? 'unknown').digest('hex');
      try {
        const result=await redis.eval(increment,1,'regutrack:rate:'+group+':'+client,60);
        if (typeof result!=='number') throw new Error('Invalid rate counter');
        const max={auth:30,processing:25,write:120}[group];
        if (result>max) {
          response.set('Retry-After','60').status(429).json({error:'Rate limit exceeded. Retry in one minute.'});
          return;
        }
      } catch {
        response.status(503).json({error:'Request protection is temporarily unavailable'});
        return;
      }
    }
    next();
  };
}
