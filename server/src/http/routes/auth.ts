import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { config } from '../../config.js';
import { login, logout } from '../../auth/sessions.js';
import { tableFor } from '../../metadata/registry.js';
import { SESSION_COOKIE, asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';

/** Session login for the SPA. OAuth 2.0 for API clients arrives with the compatibility surface. */
export function authRoutes(db: Db): Router {
  const r = Router();

  r.post(
    '/login',
    asyncHandler(async (req, res) => {
      const { username, password } = req.body ?? {};
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw Errors.invalidLogin();
      }
      const result = await login(db, username, password, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        app: 'Meridian Web'
      });

      res.cookie(SESSION_COOKIE, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.baseUrl.startsWith('https://'),
        expires: result.expiresAt,
        path: '/'
      });
      res.json({
        accessToken: result.token,
        instanceUrl: result.instanceUrl,
        id: `${result.instanceUrl}/id/${result.orgId}/${result.userId}`,
        tokenType: 'Bearer',
        issuedAt: String(result.issuedAt)
      });
    })
  );

  r.post(
    '/logout',
    authenticate(db, { optional: true }),
    asyncHandler(async (req, res) => {
      if (req.sessionToken) await logout(db, req.sessionToken);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    })
  );

  r.get(
    '/me',
    authenticate(db),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const user = await ctx.tenant(async (c) => {
        const rows = await c.query<{ id: string; name: string; fields: any }>(
          `SELECT id, name, fields FROM ${tableFor('User')} WHERE id = $1`,
          [ctx.userId]
        );
        if (!rows.rows.length) throw Errors.invalidSession();
        const row = rows.rows[0];
        return { id: row.id, name: row.name, fields: typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields };
      });

      res.json({
        userId: ctx.userId,
        organizationId: ctx.orgId,
        username: user.fields.Username,
        displayName: user.name,
        email: user.fields.Email,
        profileId: ctx.profileId,
        permissions: ctx.perms,
        locale: user.fields.LocaleSidKey ?? 'en_GB',
        timeZone: user.fields.TimeZoneSidKey ?? 'Europe/London',
        currency: user.fields.DefaultCurrencyIsoCode ?? 'GBP'
      });
    })
  );

  return r;
}
