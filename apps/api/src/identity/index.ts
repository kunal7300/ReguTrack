import express, { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import { MulterError } from 'multer';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAuth } from './auth.js';
import { createAdmin } from './admin.js';
import { HttpError } from './store.js';

const handleError: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
  } else if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Invalid request', issues: error.issues.map(({ path, message }) => ({ path, message })) });
  } else if (error?.type === 'entity.parse.failed') {
    response.status(400).json({ error: 'Invalid JSON' });
  } else if (error?.type === 'entity.too.large') {
    response.status(413).json({ error: 'Request too large' });
  } else if (error instanceof MulterError) {
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'PDF exceeds 10 MiB' : 'Invalid upload' });
  } else if (error?.code === '23505') {
    response.status(409).json({ error: 'A record with that identifier already exists' });
  } else {
    console.error('Identity request failed', error instanceof Error ? error.name : 'Unknown error');
    response.status(500).json({ error: 'Internal server error' });
  }
};

export function createIdentity(pool: Pool, jwtSecret: string, secureCookies: boolean,
  extra?: (authenticate: RequestHandler) => Router) {
  const router = Router();
  const auth = createAuth(pool, jwtSecret, secureCookies);
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '16kb' }));
  router.use('/auth', auth.router);
  router.use(createAdmin(pool, auth.authenticate));
  if (extra) router.use(extra(auth.authenticate));
  router.use((_request, response) => {
    response.status(404).json({ error: 'Endpoint not found' });
  });
  router.use(handleError);
  return router;
}
