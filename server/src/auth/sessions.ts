import type { Db, DbClient } from '../db/index.js';
import { withTenantClient } from '../db/index.js';
import { config } from '../config.js';
import { tableFor } from '../metadata/registry.js';
import { RequestContext } from '../runtime/context.js';
import type { SessionInfo } from '../runtime/context.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../security/passwords.js';
import { Errors } from '../util/errors.js';

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

export interface LoginMeta {
  ip?: string | null;
  userAgent?: string | null;
  app?: string | null;
}

export interface LoginResult {
  token: string;
  orgId: string;
  userId: string;
  instanceUrl: string;
  issuedAt: number;
  expiresAt: Date;
}

interface OrgRow {
  id: string;
  schema_name: string;
  instance_url: string | null;
}

async function orgForUsername(db: Db, username: string): Promise<{ org: OrgRow; userId: string } | null> {
  const res = await db.query<OrgRow & { user_id: string }>(
    `SELECT o.id, o.schema_name, o.instance_url, d.user_id
       FROM sys.user_directory d
       JOIN sys.orgs o ON o.id = d.org_id
      WHERE lower(d.username) = lower($1)`,
    [username]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return { org: { id: r.id, schema_name: r.schema_name, instance_url: r.instance_url }, userId: r.user_id };
}

async function recordLogin(
  c: DbClient,
  userId: string | null,
  username: string,
  status: 'Success' | 'Failed' | 'Locked',
  meta: LoginMeta
): Promise<void> {
  await c.query(
    `INSERT INTO login_history (user_id, username, status, ip, user_agent, app) VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, username, status, meta.ip ?? null, meta.userAgent ?? null, meta.app ?? null]
  );
}

/**
 * Authenticate a username/password pair and issue an opaque session token.
 *
 * The token is returned to the caller once and stored only as a SHA-256 hash, so a database
 * disclosure does not yield usable sessions. Failures are deliberately indistinguishable:
 * unknown user, wrong password and inactive user all raise INVALID_LOGIN.
 */
export async function login(
  db: Db,
  username: string,
  password: string,
  meta: LoginMeta = {},
  kind: SessionInfo['kind'] = 'ui'
): Promise<LoginResult> {
  const found = await orgForUsername(db, username);
  if (!found) {
    // Equalise timing against the real scrypt path so absent users are not detectable.
    hashPassword(password);
    throw Errors.invalidLogin();
  }
  const { org, userId } = found;

  const authed = await withOrg(db, org, async (c) => {
    const userRes = await c.query<{ id: string; fields: any }>(
      `SELECT id, fields FROM ${tableFor('User')} WHERE id = $1 AND is_deleted = false`,
      [userId]
    );
    if (!userRes.rows.length) {
      await recordLogin(c, null, username, 'Failed', meta);
      return null;
    }
    const user = userRes.rows[0];
    const fields = typeof user.fields === 'string' ? JSON.parse(user.fields) : user.fields;

    const credRes = await c.query<{ password_hash: string; failed_count: number; locked_until: Date | null }>(
      `SELECT password_hash, failed_count, locked_until FROM auth_credential WHERE user_id = $1`,
      [userId]
    );
    if (!credRes.rows.length) {
      await recordLogin(c, userId, username, 'Failed', meta);
      return null;
    }
    const cred = credRes.rows[0];

    if (cred.locked_until && new Date(cred.locked_until).getTime() > Date.now()) {
      await recordLogin(c, userId, username, 'Locked', meta);
      throw Errors.invalidLogin();
    }

    if (!verifyPassword(password, cred.password_hash)) {
      const failed = cred.failed_count + 1;
      const lock = failed >= MAX_FAILED_ATTEMPTS;
      await c.query(
        `UPDATE auth_credential
            SET failed_count = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
          WHERE user_id = $1`,
        [userId, lock ? 0 : failed, lock, String(LOCKOUT_MINUTES)]
      );
      await recordLogin(c, userId, username, 'Failed', meta);
      return null;
    }

    if (fields.IsActive === false) {
      await recordLogin(c, userId, username, 'Failed', meta);
      return null;
    }

    await c.query(`UPDATE auth_credential SET failed_count = 0, locked_until = NULL WHERE user_id = $1`, [userId]);
    await recordLogin(c, userId, username, 'Success', meta);
    return { userId };
  });

  if (!authed) throw Errors.invalidLogin();

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await db.query(
    `INSERT INTO sys.sessions (token_hash, org_id, user_id, kind, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sha256(token), org.id, userId, kind, expiresAt, meta.ip ?? null, meta.userAgent ?? null]
  );

  return {
    token,
    orgId: org.id,
    userId,
    instanceUrl: org.instance_url ?? config.baseUrl,
    issuedAt: Date.now(),
    expiresAt
  };
}

/** Resolve an opaque token into a RequestContext, or null if it is unknown or expired. */
export async function resolveSession(db: Db, token: string): Promise<RequestContext | null> {
  if (!token) return null;
  const tokenHash = sha256(token);
  const res = await db.query<{
    org_id: string;
    user_id: string;
    kind: SessionInfo['kind'];
    scopes: any;
    schema_name: string;
  }>(
    `SELECT s.org_id, s.user_id, s.kind, s.scopes, o.schema_name
       FROM sys.sessions s
       JOIN sys.orgs o ON o.id = s.org_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash]
  );
  if (!res.rows.length) return null;
  const row = res.rows[0];

  // Best-effort activity stamp; never fail a request because this write did not land.
  db.query(`UPDATE sys.sessions SET last_used_at = now() WHERE token_hash = $1`, [tokenHash]).catch(() => undefined);

  const identity = await withOrg(db, { id: row.org_id, schema_name: row.schema_name, instance_url: null }, async (c) => {
    const userRes = await c.query<{ fields: any }>(
      `SELECT fields FROM ${tableFor('User')} WHERE id = $1 AND is_deleted = false`,
      [row.user_id]
    );
    if (!userRes.rows.length) return null;
    const fields = typeof userRes.rows[0].fields === 'string' ? JSON.parse(userRes.rows[0].fields) : userRes.rows[0].fields;
    if (fields.IsActive === false) return null;

    const profileId: string | null = fields.ProfileId ?? null;
    let perms: Record<string, boolean> = {};
    if (profileId) {
      const p = await c.query<{ perms: any }>(`SELECT perms FROM profile WHERE id = $1`, [profileId]);
      if (p.rows.length) perms = typeof p.rows[0].perms === 'string' ? JSON.parse(p.rows[0].perms) : p.rows[0].perms;
    }
    return { profileId, perms };
  });

  if (!identity) return null;

  return new RequestContext({
    db,
    orgId: row.org_id,
    schema: row.schema_name,
    userId: row.user_id,
    profileId: identity.profileId,
    perms: identity.perms,
    session: {
      tokenHash,
      kind: row.kind,
      scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes ?? '[]')
    }
  });
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query(`DELETE FROM sys.sessions WHERE token_hash = $1`, [sha256(token)]);
}

/** Delete expired sessions; called by the scheduler once it exists. */
export async function purgeExpiredSessions(db: Db): Promise<number> {
  const res = await db.query(`DELETE FROM sys.sessions WHERE expires_at < now()`);
  return res.rowCount;
}

function withOrg<T>(db: Db, org: OrgRow, fn: (c: DbClient) => Promise<T>): Promise<T> {
  return withTenantClient(db, org.schema_name, fn);
}
