import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import { parse as parseCookie } from 'cookie';
import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  account, type Account, argonOptions, audit, type Database, email, getAccount, HttpError, id, transaction,
} from './store.js';

const issuer = 'regutrack';
const audience = 'regutrack-api';
const accessSeconds = 300;
const refreshMs = 7 * 24 * 60 * 60 * 1000;
const cookieName = 'regutrack_refresh';
const cookiePath = '/api/v1/auth';
const credentials = z.strictObject({ email, password: z.string().min(1).max(128) });
const jwtClaims = z.object({ sub: id, sid: id });
const tokenRecord = z.object({
  session_id: id, user_id: id, expires_at: z.date(), used_at: z.date().nullable(), revoked_at: z.date().nullable(),
});
const authResponse = z.object({ accessToken: z.string(), expiresIn: z.number(), user: account });

export async function hashPassword(password: string) {
  return hash(password, { type: argon2id, ...argonOptions });
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

async function issueRefresh(db: Database, userId: string, sessionId: string, expiresAt: Date) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    'INSERT INTO refresh_tokens (token_hash, session_id, user_id, expires_at) VALUES ($1,$2,$3,$4)',
    [tokenHash(token), sessionId, userId, expiresAt],
  );
  return { token, sessionId, expiresAt };
}

async function resolveRefresh(db: Database, digest: string) {
  const { rows } = await db.query(
    'SELECT session_id, user_id, expires_at, used_at, revoked_at FROM refresh_tokens WHERE token_hash = $1', [digest],
  );
  return rows.length ? tokenRecord.parse(rows[0]) : undefined;
}

async function revokeSession(db: Database, sessionId: string) {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
}

function readRefresh(header: string) {
  const token = parseCookie(header)[cookieName];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, 'Sign in required');
  return tokenHash(token);
}

export function requireJson(): RequestHandler {
  return (request, _response, next) => {
    if (!request.is('application/json')) throw new HttpError(415, 'Use application/json');
    next();
  };
}

export function createAuth(pool: Pool, secret: string, secureCookies: boolean) {
  const router = Router();
  const signingKey = Buffer.from(secret, 'hex');
  const cookie: CookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: cookiePath };
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));

  async function sendSession(
    response: Response, user: Account, refresh: Awaited<ReturnType<typeof issueRefresh>>,
  ) {
    const accessToken = await new SignJWT({ sid: refresh.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id).setIssuer(issuer).setAudience(audience)
      .setIssuedAt().setExpirationTime(`${accessSeconds}s`).sign(signingKey);
    response.cookie(cookieName, refresh.token, { ...cookie, expires: refresh.expiresAt });
    response.json(authResponse.parse({ accessToken, expiresIn: accessSeconds, user }));
  }

  const authenticate: RequestHandler = async (request, response, next) => {
    const header = request.get('authorization')?.match(/^Bearer (\S+)$/i);
    if (!header) throw new HttpError(401, 'Sign in required');

    let claims: z.infer<typeof jwtClaims>;
    try {
      const { payload } = await jwtVerify(header[1], signingKey, {
        algorithms: ['HS256'], issuer, audience, requiredClaims: ['exp', 'iat'],
      });
      claims = jwtClaims.parse(payload);
    } catch {
      throw new HttpError(401, 'Sign in required');
    }

    const session = await pool.query(
      `SELECT 1 FROM refresh_tokens WHERE session_id = $1 AND user_id = $2
       AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [claims.sid, claims.sub],
    );
    const user = session.rowCount ? await getAccount(pool, claims.sub) : undefined;
    if (!user?.active) throw new HttpError(401, 'Sign in required');
    response.locals.user = user;
    next();
  };

  const limit = rateLimit({
    windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in a minute.' },
  });

  router.post('/login', requireJson(), limit, async (request, response) => {
    const input = credentials.parse(request.body);
    const candidate = (await pool.query(
      'SELECT id, password_hash, active FROM users WHERE email = $1', [input.email],
    )).rows[0];
    const valid = await verify(candidate?.password_hash ?? await dummyHash, input.password);
    const session = await transaction(pool, async (db) => {
      const current = candidate && (await db.query(
        'SELECT active, password_hash FROM users WHERE id = $1 AND email = $2 FOR UPDATE', [candidate.id, input.email],
      )).rows[0];
      if (!valid || !current?.active || current.password_hash !== candidate.password_hash) {
        await audit(db, candidate?.id ?? null, 'auth.login_failed', 'user', candidate?.id ?? null);
        return;
      }
      const user = account.parse(await getAccount(db, candidate.id));
      const refresh = await issueRefresh(db, user.id, randomUUID(), new Date(Date.now() + refreshMs));
      await audit(db, user.id, 'auth.login', 'session', refresh.sessionId);
      return { user, refresh };
    });
    if (!session) throw new HttpError(401, 'Invalid email or password');
    await sendSession(response, session.user, session.refresh);
  });

  router.post('/refresh', requireJson(), async (request, response) => {
    const digest = readRefresh(request.get('cookie') ?? '');
    const session = await transaction(pool, async (db) => {
      const initial = await resolveRefresh(db, digest);
      if (!initial) return;
      const { rows: [locked] } = await db.query('SELECT active FROM users WHERE id = $1 FOR UPDATE', [initial.user_id]);
      const token = await resolveRefresh(db, digest);
      if (!token || token.revoked_at || token.expires_at.getTime() <= Date.now() || !locked?.active) return;
      if (token.used_at) {
        await revokeSession(db, token.session_id);
        await audit(db, token.user_id, 'auth.refresh_reuse', 'session', token.session_id);
        return;
      }
      await db.query('UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1', [digest]);
      const user = account.parse(await getAccount(db, token.user_id));
      const refresh = await issueRefresh(db, user.id, token.session_id, token.expires_at);
      return { user, refresh };
    });
    if (!session) {
      response.clearCookie(cookieName, cookie);
      throw new HttpError(401, 'Sign in required');
    }
    await sendSession(response, session.user, session.refresh);
  });

  router.post('/logout', requireJson(), async (request, response) => {
    const header = request.get('cookie') ?? '';
    if (parseCookie(header)[cookieName]) {
      const digest = readRefresh(header);
      await transaction(pool, async (db) => {
        const token = await resolveRefresh(db, digest);
        if (!token) return;
        await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [token.user_id]);
        const current = await resolveRefresh(db, digest);
        if (!current || current.revoked_at) return;
        await revokeSession(db, token.session_id);
        await audit(db, token.user_id, 'auth.logout', 'session', token.session_id);
      });
    }
    response.clearCookie(cookieName, cookie).status(204).end();
  });

  router.get('/me', authenticate, (_request, response) => {
    response.json(account.parse(response.locals.user));
  });
  return { router, authenticate };
}
