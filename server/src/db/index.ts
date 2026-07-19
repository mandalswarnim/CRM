import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, DbClient } from './driver.js';

export { getDb, setDbForTests, createEphemeralDb, createPgDb } from './driver.js';
export type { Db, DbClient, QueryResult } from './driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadSql(name: string): string {
  return fs.readFileSync(path.join(here, name), 'utf8');
}

/** Bootstrap the control-plane schema. Idempotent. */
export async function migrateSystem(db: Db): Promise<void> {
  await db.exec(loadSql('system.sql'));
}

/** Create a tenant schema with the full metadata table set. */
export async function createTenantSchema(db: Db, schemaName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) throw new Error(`Bad schema name ${schemaName}`);
  const sql = loadSql('tenant_template.sql').replaceAll('__SCHEMA__', schemaName);
  await db.exec(sql);
}

export async function dropTenantSchema(db: Db, schemaName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) throw new Error(`Bad schema name ${schemaName}`);
  await db.exec(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
}

/**
 * Run fn against a dedicated client with search_path pinned to the tenant schema
 * (plus sys). ALL tenant-scoped SQL must run through this.
 */
export async function withTenantClient<T>(
  db: Db,
  schemaName: string,
  fn: (c: DbClient) => Promise<T>
): Promise<T> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) throw new Error(`Bad schema name ${schemaName}`);
  return db.withClient(async (c) => {
    await c.query(`SET search_path TO ${schemaName}, sys`);
    try {
      return await fn(c);
    } finally {
      try {
        await c.query(`SET search_path TO public`);
      } catch {
        /* connection may be gone */
      }
    }
  });
}

/** BEGIN/COMMIT wrapper on an already-bound client. */
export async function inTransaction<T>(c: DbClient, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    const out = await fn();
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}
