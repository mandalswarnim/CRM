import type { DbClient } from '../db/index.js';
import { tableFor } from './registry.js';

/**
 * Create the physical data table for an object. Fixed system columns + JSONB body.
 * Called at object creation time — this is how "metadata insert" becomes storage.
 */
export async function createDataTable(c: DbClient, apiName: string): Promise<void> {
  const t = tableFor(apiName);
  await c.query(`
    CREATE TABLE IF NOT EXISTS ${t} (
      id                    char(18) PRIMARY KEY,
      name                  text,
      record_type_id        char(18),
      owner_id              char(18),
      created_by_id         char(18),
      created_date          timestamptz NOT NULL DEFAULT now(),
      last_modified_by_id   char(18),
      last_modified_date    timestamptz NOT NULL DEFAULT now(),
      system_modstamp       timestamptz NOT NULL DEFAULT now(),
      is_deleted            boolean NOT NULL DEFAULT false,
      deleted_date          timestamptz,
      currency_iso_code     text,
      fields                jsonb NOT NULL DEFAULT '{}'
    )`);
  await c.query(`CREATE INDEX IF NOT EXISTS ${t}_fields_gin ON ${t} USING gin (fields jsonb_path_ops)`);
  await c.query(`CREATE INDEX IF NOT EXISTS ${t}_owner_idx ON ${t} (owner_id) WHERE NOT is_deleted`);
  await c.query(`CREATE INDEX IF NOT EXISTS ${t}_name_idx ON ${t} (lower(name)) WHERE NOT is_deleted`);
  await c.query(`CREATE INDEX IF NOT EXISTS ${t}_created_idx ON ${t} (created_date DESC)`);
}

export async function dropDataTable(c: DbClient, apiName: string): Promise<void> {
  await c.query(`DROP TABLE IF EXISTS ${tableFor(apiName)}`);
}

function indexNameFor(table: string, fieldApi: string, unique: boolean): string {
  const safe = fieldApi.toLowerCase().replace(/[^a-z0-9]/g, '_');
  let name = `${table}_f_${safe}${unique ? '_uq' : ''}`;
  if (name.length > 60) name = name.slice(0, 60);
  return name;
}

/** Expression index over a JSONB body field (lookups, unique, external ids). */
export async function createFieldIndex(
  c: DbClient,
  apiName: string,
  fieldApi: string,
  opts: { unique?: boolean } = {}
): Promise<void> {
  const t = tableFor(apiName);
  const idx = indexNameFor(t, fieldApi, !!opts.unique);
  const expr = `(fields->>'${fieldApi.replace(/'/g, "''")}')`;
  if (opts.unique) {
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${t} (${expr}) WHERE ${expr} IS NOT NULL AND NOT is_deleted`
    );
  } else {
    await c.query(`CREATE INDEX IF NOT EXISTS ${idx} ON ${t} (${expr}) WHERE NOT is_deleted`);
  }
}

export async function dropFieldIndex(
  c: DbClient,
  apiName: string,
  fieldApi: string
): Promise<void> {
  const t = tableFor(apiName);
  await c.query(`DROP INDEX IF EXISTS ${indexNameFor(t, fieldApi, true)}`);
  await c.query(`DROP INDEX IF EXISTS ${indexNameFor(t, fieldApi, false)}`);
}
