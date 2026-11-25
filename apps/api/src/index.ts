import { Redis } from 'ioredis';
import { HeadBucketCommand,S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { z } from 'zod';
import { createApp } from './app.js';
import { createIdentity } from './identity/index.js';
import { createRegulations } from './regulatory/index.js';
import { createIntelligence } from './intelligence/index.js';
import { createComparisons } from './comparisons/index.js';
import { createGaps } from './gaps/index.js';
import { createWork } from './work/index.js';
import { createEvidence } from './evidence/index.js';
import { visibilityRoutes } from './visibility/index.js';
import { notificationRoutes,startNotifications } from './visibility/notifications.js';
import { createAssistant } from './assistant/index.js';
import { Router } from 'express';
import { releaseSecurity } from './security.js';

const config = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PG_TLS: z.enum(['true','false']).default('false').transform((value)=>value==='true'),
  PUBLIC_ORIGIN: z.url({protocol:/^https$/}).optional().transform((origin)=>origin ? new URL(origin).origin : undefined),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AI_URL: z.url({ protocol: /^https?$/ }),
  JWT_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
  PDF_SERVICE_TOKEN: z.string().min(32),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: z.string().min(8),
  SECURE_COOKIES: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
}).parse(process.env);
if (process.env.NODE_ENV==='production' && (!config.PUBLIC_ORIGIN || !config.SECURE_COOKIES))
  throw new Error('Production requires an HTTPS PUBLIC_ORIGIN and SECURE_COOKIES=true');

const postgres = new Pool({
  host: config.PGHOST,
  port: config.PGPORT,
  ssl: config.PG_TLS ? {rejectUnauthorized:true} : undefined,
  database: config.PGDATABASE,
  user: config.PGUSER,
  password: config.PGPASSWORD,
  connectionTimeoutMillis: 1500,
  query_timeout: 1500,
});
postgres.on('error', () => console.error('Idle PostgreSQL connection failed'));

const redis = new Redis(config.REDIS_URL, {
  connectTimeout: 1500,
  commandTimeout: 1500,
  enableOfflineQueue: false,
});
const storage = new S3Client({endpoint:config.S3_ENDPOINT,region:config.S3_REGION,forcePathStyle:true,
  maxAttempts:1,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});

const aiHealth = z.object({ status: z.literal('ok'), service: z.literal('ai') });
const regulatory = createRegulations(postgres, {
  redisUrl: config.REDIS_URL, aiUrl: config.AI_URL, pdfToken: config.PDF_SERVICE_TOKEN,
  endpoint: config.S3_ENDPOINT, accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY,
  region: config.S3_REGION,
  bucket: 'regulatory-pdfs',
});
const intelligence = createIntelligence(postgres, {
  redisUrl: config.REDIS_URL, aiUrl: config.AI_URL, token: config.PDF_SERVICE_TOKEN,
});
let evidence: ReturnType<typeof createEvidence>;
const closeNotifications = startNotifications(postgres,config.REDIS_URL);
const assistant = createAssistant(postgres,{
  aiUrl:config.AI_URL,token:config.PDF_SERVICE_TOKEN,redisUrl:config.REDIS_URL,
});
const app = createApp({
  postgres: () => postgres.query("SELECT '[0]'::vector, (SELECT count(*) FROM roles)"),
  redis: async () => {
    if (await redis.ping() !== 'PONG') throw new Error('Redis health check failed');
  },
  ai: async () => {
    const response = await fetch(new URL('/health', config.AI_URL), {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw Object.assign(new Error('AI service health check failed'), {status: response.status});
    aiHealth.parse(await response.json());
  },
  storage: async () => {
    try {
      await storage.send(new HeadBucketCommand({Bucket:'regulatory-pdfs'}),{abortSignal:AbortSignal.timeout(1500)});
    } catch (error) {
      if ((error as {$metadata?: {httpStatusCode?:number}}).$metadata?.httpStatusCode !== 404) throw error;
    }
  },
}, createIdentity(postgres, config.JWT_SECRET, config.SECURE_COOKIES,
  (authenticate) => {
    evidence = createEvidence(postgres, {
      endpoint:config.S3_ENDPOINT,accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY,
      region:config.S3_REGION,
      aiUrl:config.AI_URL,token:config.PDF_SERVICE_TOKEN,
    }, authenticate);
    return Router().use(regulatory.router(authenticate), intelligence.router(authenticate),
      createComparisons(postgres, config.AI_URL, config.PDF_SERVICE_TOKEN, authenticate),
      createGaps(postgres, config.AI_URL, config.PDF_SERVICE_TOKEN, authenticate),
      createWork(postgres, authenticate), evidence.router,
      visibilityRoutes(postgres,authenticate), notificationRoutes(postgres,authenticate),assistant.router(authenticate));
  }), {security:releaseSecurity(redis,config.PUBLIC_ORIGIN),trustedProxy:Boolean(config.PUBLIC_ORIGIN)});

const server = app.listen(config.PORT, '0.0.0.0');
function shutdown() {
  server.close(() => {
    redis.disconnect();
    storage.destroy();
    evidence?.close();
    void Promise.allSettled([regulatory.close(), intelligence.close(),closeNotifications(),assistant.close()]).then(() => postgres.end());
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
