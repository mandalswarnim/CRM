import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/http/app.js';
import { LimitContext } from '../src/runtime/limits.js';
import { resolveSession } from '../src/auth/sessions.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;
let server: Server;
let base: string;

const USERNAME = 'admin@larkspur.club';
const PASSWORD = 'Larkspur#1905';

beforeAll(async () => {
  org = await testOrg();
  server = createApp(org.db).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function login(username = USERNAME, password = PASSWORD) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
}

describe('service endpoints', () => {
  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('lists API versions unauthenticated', async () => {
    const res = await fetch(`${base}/services/data`);
    expect(res.status).toBe(200);
    const versions = await res.json();
    expect(versions.map((v: any) => v.version)).toContain('61.0');
  });

  it('rejects an unsupported API version', async () => {
    const res = await fetch(`${base}/services/data/v1.0/limits`);
    expect(res.status).toBe(404);
    expect((await res.json())[0].errorCode).toBe('NOT_FOUND');
  });

  it('challenges for credentials before revealing whether a route exists', async () => {
    const res = await fetch(`${base}/services/data/v61.0/nonsense`);
    expect(res.status).toBe(401);
    expect((await res.json())[0].errorCode).toBe('INVALID_SESSION_ID');
  });

  it('returns Salesforce-shaped errors for unknown routes once authenticated', async () => {
    const { accessToken } = await (await login()).json();
    const res = await fetch(`${base}/services/data/v61.0/nonsense`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body[0]).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(body[0]).toHaveProperty('message');
    expect(body[0]).toHaveProperty('fields');
  });
});

describe('login', () => {
  it('issues a token and sets a session cookie', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.tokenType).toBe('Bearer');
    expect(res.headers.get('set-cookie')).toMatch(/sid=/);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  });

  it('rejects a bad password without revealing the user exists', async () => {
    const wrongPassword = await login(USERNAME, 'nope');
    const unknownUser = await login('nobody@example.com', 'nope');
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect((await wrongPassword.json())[0]).toEqual((await unknownUser.json())[0]);
  });

  it('records login history', async () => {
    await login();
    const rows = await org.tenant((c) =>
      c.query(`SELECT status FROM login_history WHERE username = $1 ORDER BY ts DESC LIMIT 1`, [USERNAME])
    );
    expect(rows.rows[0].status).toBe('Success');
  });

  it('stores only a hash of the token', async () => {
    const { accessToken } = await (await login()).json();
    const rows = await org.db.query(`SELECT token_hash FROM sys.sessions WHERE token_hash = $1`, [accessToken]);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('authenticated requests', () => {
  it('resolves the acting user and profile permissions', async () => {
    const { accessToken } = await (await login()).json();
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.userId).toBe(org.adminUserId);
    expect(me.organizationId).toBe(org.orgId);
    expect(me.username).toBe(USERNAME);
    expect(me.permissions.modifyAllData).toBe(true);
    expect(me.timeZone).toBe('Europe/London');
  });

  it('accepts the session cookie as well as a bearer token', async () => {
    const res = await login();
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
  });

  it('refuses unauthenticated access with INVALID_SESSION_ID', async () => {
    const res = await fetch(`${base}/api/auth/me`);
    expect(res.status).toBe(401);
    expect((await res.json())[0].errorCode).toBe('INVALID_SESSION_ID');
  });

  it('refuses a forged token', async () => {
    const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer not-a-real-token' } });
    expect(res.status).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const { accessToken } = await (await login()).json();
    const out = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    expect(out.status).toBe(204);
    const after = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(after.status).toBe(401);
  });

  it('reports governor limits and meters API usage', async () => {
    const { accessToken } = await (await login()).json();
    const res = await fetch(`${base}/services/data/v61.0/limits`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    expect(res.status).toBe(200);
    const limits = await res.json();
    expect(limits.SoqlQueries).toEqual({ Max: 100, Remaining: 100 });
    expect(limits.DmlStatements.Max).toBe(150);
    expect(res.headers.get('sforce-limit-info')).toMatch(/^api-usage=\d+\/\d+$/);
  });
});

describe('request context', () => {
  it('binds the context to one org and carries a limit budget', async () => {
    const { accessToken } = await (await login()).json();
    const ctx = await resolveSession(org.db, accessToken);
    expect(ctx).not.toBeNull();
    expect(ctx!.orgId).toBe(org.orgId);
    expect(ctx!.schema).toBe(org.schema);
    expect(ctx!.isAdmin).toBe(true);

    // The context can only see its own tenant's tables.
    const objects = await ctx!.tenant((c) => c.query(`SELECT count(*)::int AS n FROM object_def`));
    expect(objects.rows[0].n).toBeGreaterThan(0);

    const meta = await ctx!.orgMeta();
    expect(meta.objects.has('account')).toBe(true);
  });

  it('gives a forked context a fresh budget', async () => {
    const { accessToken } = await (await login()).json();
    const ctx = (await resolveSession(org.db, accessToken))!;
    ctx.limits.consume('soqlQueries', 5);
    expect(ctx.limits.remaining('soqlQueries')).toBe(95);
    expect(ctx.fork().limits.remaining('soqlQueries')).toBe(100);
  });
});

describe('governor limits', () => {
  it('counts usage and throws LIMIT_EXCEEDED at the ceiling', () => {
    const limits = new LimitContext({ soqlQueries: 3 });
    limits.consume('soqlQueries');
    limits.consume('soqlQueries', 2);
    expect(limits.usage().soqlQueries).toBe(3);
    expect(() => limits.consume('soqlQueries')).toThrowError(/LIMIT_EXCEEDED|soqlQueries/);
    try {
      limits.consume('soqlQueries');
    } catch (e: any) {
      expect(e.errorCode).toBe('LIMIT_EXCEEDED');
      expect(e.status).toBe(403);
    }
  });

  it('rejects a batch that would breach the ceiling without partially consuming it', () => {
    const limits = new LimitContext({ dmlRows: 10 });
    limits.consume('dmlRows', 8);
    expect(() => limits.consume('dmlRows', 5)).toThrow();
    expect(limits.usage().dmlRows).toBe(8);
  });
});
