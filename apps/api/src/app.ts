import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';

const checkNames = ['postgres', 'redis', 'ai', 'storage'] as const;
type CheckName = typeof checkNames[number];
type CheckStatus = 'up' | 'down';
type Checks = Record<Exclude<CheckName,'storage'>, () => Promise<unknown>> & {storage?: () => Promise<unknown>};

function readinessErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'check_failed';
  const details = error as Error & { code?: unknown; status?: number; $metadata?: { httpStatusCode?: number }; cause?: { code?: unknown } };
  const status = details.$metadata?.httpStatusCode ?? details.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600) return `HTTP_${status}`;
  const code = details.code ?? details.cause?.code;
  if (typeof code === 'string' && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code)) return code;
  if (['TimeoutError','AbortError','ZodError','SyntaxError'].includes(error.name)) return error.name;
  return 'check_failed';
}

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

  let previousFailure = '';
  app.get('/api/health/ready', async (_request, response) => {
    const available=checkNames.filter((name)=>checks[name]);
    const failures: Partial<Record<CheckName, string>> = {};
    const results = await Promise.all(available.map(async (name): Promise<[CheckName, CheckStatus]> => {
      try {
        await checks[name]!();
        return [name, 'up'];
      } catch (error) {
        failures[name] = readinessErrorCode(error);
        return [name, 'down'];
      }
    }));

    const ready = results.every(([, status]) => status === 'up');
    if (!ready) response.locals.failedChecks = failures;
    const failedChecks = results.filter(([, status]) => status === 'down').map(([name]) => name);
    const failure = failedChecks.join(',');
    if (failure && failure !== previousFailure) {
      console.warn(JSON.stringify({ event: 'api.readiness.failed', failedChecks }));
    }
    previousFailure = failure;
    const body = readiness.parse({
      status: ready ? 'ready' : 'unavailable',
      checks: Object.fromEntries(results),
    });
    response.status(ready ? 200 : 503).json(body);
  });

  if (identity) app.use('/api/v1', identity);
  return app;
}
