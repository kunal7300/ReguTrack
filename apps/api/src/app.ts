import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';

const checkNames = ['postgres', 'redis', 'ai', 'storage'] as const;
type CheckName = typeof checkNames[number];
type CheckStatus = 'up' | 'down';
type Checks = Record<Exclude<CheckName,'storage'>, () => Promise<unknown>> & {storage?: () => Promise<unknown>};

const readiness = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.partialRecord(z.enum(checkNames), z.enum(['up', 'down'])),
});

export function createApp(checks: Checks, identity?: Router, options?: { security:RequestHandler; trustedProxy?:boolean }) {
  const app = express();
  app.disable('x-powered-by');
  if (options?.trustedProxy) app.set('trust proxy',1);
  if (options) app.use(options.security);

  app.use('/api/health', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health/live', (_request, response) => {
    response.json({ status: 'ok', service: 'api' });
  });

  app.get('/api/health/ready', async (_request, response) => {
    const available=checkNames.filter((name)=>checks[name]);
    const results = await Promise.all(available.map(async (name): Promise<[CheckName, CheckStatus]> => {
      try {
        await checks[name]!();
        return [name, 'up'];
      } catch {
        return [name, 'down'];
      }
    }));

    const ready = results.every(([, status]) => status === 'up');
    const body = readiness.parse({
      status: ready ? 'ready' : 'unavailable',
      checks: Object.fromEntries(results),
    });
    response.status(ready ? 200 : 503).json(body);
  });

  if (identity) app.use('/api/v1', identity);
  return app;
}
