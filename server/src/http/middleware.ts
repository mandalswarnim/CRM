import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { resolveSession } from '../auth/sessions.js';
import type { RequestContext } from '../runtime/context.js';
import { SfError, Errors } from '../util/errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: RequestContext;
    sessionToken?: string;
  }
}

export const SESSION_COOKIE = 'sid';

/** Minimal cookie header parser — the only cookie we read is the session id. */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function bearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

/** Wrap an async handler so rejections reach the error middleware instead of hanging. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Resolve the caller into a RequestContext, binding the request to exactly one org.
 *
 * Every authenticated route depends on this: the tenant is decided here, once, from the token —
 * never from anything the caller can assert, such as a header or a path segment.
 */
export function authenticate(db: Db, opts: { optional?: boolean } = {}): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const token = bearerToken(req) ?? readCookie(req, SESSION_COOKIE);
    if (!token) {
      if (opts.optional) return next();
      throw Errors.invalidSession();
    }
    const ctx = await resolveSession(db, token);
    if (!ctx) {
      if (opts.optional) return next();
      throw Errors.invalidSession();
    }
    req.ctx = ctx;
    req.sessionToken = token;
    res.setHeader('Sforce-Limit-Info', `api-usage=0/${config.dailyApiRequests}`);
    next();
  });
}

/** The context of an authenticated request; throws rather than returning undefined. */
export function ctxOf(req: Request): RequestContext {
  if (!req.ctx) throw Errors.invalidSession();
  return req.ctx;
}

/** Count API requests per org per day for the /limits endpoint and Sforce-Limit-Info. */
export function meterApiUsage(db: Db): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.ctx?.orgId;
    if (orgId) {
      db.query(
        `INSERT INTO sys.api_usage (org_id, day, requests) VALUES ($1, current_date, 1)
         ON CONFLICT (org_id, day) DO UPDATE SET requests = sys.api_usage.requests + 1`,
        [orgId]
      ).catch(() => undefined);
    }
    next();
  };
}

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(Errors.notFound(`No such resource: ${req.method} ${req.path}`));
  };
}

/** Terminal error middleware: renders every failure in the Salesforce error shape. */
export function errorHandler(): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err, _req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof SfError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    if (err instanceof SyntaxError && 'body' in (err as any)) {
      const e = Errors.jsonParse(err.message);
      res.status(e.status).json(e.toBody());
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV !== 'test') console.error('[meridian] unhandled error:', err);
    res.status(500).json([{ message, errorCode: 'UNKNOWN_EXCEPTION', fields: [] }]);
  };
}
