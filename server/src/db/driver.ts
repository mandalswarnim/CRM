import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends DbClient {
  /** Run fn with a dedicated client (connection) — required for transactions / search_path. */
  withClient<T>(fn: (c: DbClient) => Promise<T>): Promise<T>;
  /** Execute a multi-statement SQL script (DDL). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

/* ---------------------------------- pg ---------------------------------- */

class PgDb implements Db {
  readonly kind = 'pg' as const;
  private pool: any;

  constructor(pool: any) {
    this.pool = pool;
  }

  static async create(dsn: string): Promise<PgDb> {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: dsn, max: config.pgPoolSize });
    // Parse numerics as floats and keep dates as ISO strings for uniform behaviour with PGlite.
    pg.types.setTypeParser(1700, (v: string) => parseFloat(v));
    pg.types.setTypeParser(20, (v: string) => parseInt(v, 10));
    return new PgDb(pool);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async withClient<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn({
        query: async (sql: string, params: unknown[] = []) => {
          const res = await client.query(sql, params);
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        }
      });
    } finally {
      // Reset any session state (search_path) before returning to the pool.
      try {
        await client.query('RESET ALL');
      } catch {
        /* ignore */
      }
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* --------------------------------- PGlite -------------------------------- */

/** Single-connection embedded Postgres; a mutex serialises transactional sections. */
class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  private lite: any;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(lite: any) {
    this.lite = lite;
  }

  static async create(dir: string): Promise<PgliteDb> {
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(dir, { recursive: true });
    const lite = await PGlite.create(dir === ':memory:' ? undefined : dir);
    return new PgliteDb(lite);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.enqueue(async () => {
      const res = await this.lite.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.affectedRows ?? res.rows.length };
    });
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(() => this.lite.exec(sql));
  }

  async withClient<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      fn({
        query: async (sql: string, params: unknown[] = []) => {
          const res = await this.lite.query(sql, params);
          return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
        }
      })
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.lite.close();
  }
}

/* -------------------------------- factory -------------------------------- */

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    dbPromise = config.databaseUrl
      ? PgDb.create(config.databaseUrl)
      : PgliteDb.create(process.env.PGLITE_MEMORY ? ':memory:' : path.join(config.dataDir, 'pglite'));
  }
  return dbPromise;
}

/** For tests: swap in a fresh database. */
export function setDbForTests(db: Db): void {
  dbPromise = Promise.resolve(db);
}

export async function createEphemeralDb(): Promise<Db> {
  return PgliteDb.create(':memory:');
}

export async function createPgDb(dsn: string): Promise<Db> {
  return PgDb.create(dsn);
}
