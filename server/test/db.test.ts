import { describe, it, expect, beforeAll } from 'vitest';
import { createEphemeralDb, migrateSystem, createTenantSchema, withTenantClient } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { generateId, to18, normalizeId, nextCustomPrefix, KEY_PREFIXES } from '../src/util/ids.js';

let db: Db;

beforeAll(async () => {
  db = await createEphemeralDb();
  await migrateSystem(db);
});

describe('id generation', () => {
  it('creates 18-char ids with the right key prefix', () => {
    const id = generateId('001');
    expect(id).toHaveLength(18);
    expect(id.startsWith('001')).toBe(true);
  });

  it('computes the standard 18-char checksum', () => {
    // Known pair from Salesforce documentation examples.
    expect(to18('001A0000006Vm9r')).toBe('001A0000006Vm9rIAC');
  });

  it('normalizes 15/18 char forms', () => {
    const id = generateId('003');
    expect(normalizeId(id.slice(0, 15))).toBe(id);
    expect(normalizeId(id)).toBe(id);
    expect(normalizeId('nonsense')).toBeNull();
  });

  it('allocates custom prefixes', () => {
    expect(nextCustomPrefix([])).toBe('a00');
    expect(nextCustomPrefix(['a00', 'a01'])).toBe('a02');
  });

  it('has unique standard prefixes', () => {
    const values = Object.values(KEY_PREFIXES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('schema bootstrap', () => {
  it('migrates the system schema idempotently', async () => {
    await migrateSystem(db);
    const res = await db.query(`SELECT count(*)::int AS n FROM sys.orgs`);
    expect(res.rows[0].n).toBe(0);
  });

  it('creates a tenant schema and queries metadata tables', async () => {
    await createTenantSchema(db, 'org_test1');
    await withTenantClient(db, 'org_test1', async (c) => {
      await c.query(
        `INSERT INTO object_def (id, api_name, label, plural_label, key_prefix) VALUES ($1,$2,$3,$4,$5)`,
        [generateId('01I'), 'Account', 'Account', 'Accounts', '001']
      );
      const r = await c.query(`SELECT api_name FROM object_def`);
      expect(r.rows[0].api_name).toBe('Account');
      const search = await c.query(
        `INSERT INTO search_index (record_id, object_api, title, tsv)
         VALUES ($1,'Account','The Larkspur Club', to_tsvector('simple','The Larkspur Club'))`,
        [generateId('001')]
      );
      expect(search.rowCount).toBe(1);
      const hit = await c.query(
        `SELECT record_id FROM search_index WHERE tsv @@ plainto_tsquery('simple','larkspur')`
      );
      expect(hit.rows).toHaveLength(1);
    });
  });

  it('isolates tenants: second schema does not see first schema rows', async () => {
    await createTenantSchema(db, 'org_test2');
    await withTenantClient(db, 'org_test2', async (c) => {
      const r = await c.query(`SELECT count(*)::int AS n FROM object_def`);
      expect(r.rows[0].n).toBe(0);
    });
  });
});
