import crypto from 'node:crypto';
import type { Db, DbClient } from '../db/index.js';
import { withTenantClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import { RequestContext } from '../runtime/context.js';
import { LimitContext } from '../runtime/limits.js';
import { ADMIN_PERMS } from '../db/provision.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { nextRun } from './cron.js';
import { runCronJob, runDueTimeTriggers } from './jobs.js';

export interface TickResult {
  orgs: number;
  timeTriggers: number;
  timeTriggerFailures: number;
  cronJobs: number;
  cronFailures: number;
  sessionsPurged: number;
}

/** Stable 64-bit key for an advisory lock, derived from a name. */
function lockKey(name: string): bigint {
  const hash = crypto.createHash('sha256').update(name).digest();
  return hash.readBigInt64BE(0);
}

/**
 * Run fn only if this process wins the named advisory lock.
 *
 * The scheduler runs in every replica; the lock is what makes exactly one of them execute a given
 * job. Holding it occupies a connection for the duration of the work, which is fine against a
 * pooled server — but the embedded driver has exactly one connection, and taking it would leave
 * the work itself with nothing to run on. There is also only ever one process there, so there is
 * nothing to coordinate: the lock is skipped rather than faked.
 */
async function withAdvisoryLock<T>(db: Db, name: string, fn: () => Promise<T>): Promise<T | null> {
  if (db.kind !== 'pg') return fn();

  return db.withClient(async (c: DbClient) => {
    const key = lockKey(name);
    const got = await c.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [key.toString()]);
    if (!got.rows[0]?.locked) return null;
    try {
      return await fn();
    } finally {
      await c.query(`SELECT pg_advisory_unlock($1)`, [key.toString()]).catch(() => undefined);
    }
  });
}

/** A context acting as the org's administrator, for work no user initiated. */
async function systemContext(db: Db, orgId: string, schema: string): Promise<RequestContext | null> {
  const admin = await withTenantClient(db, schema, (c) =>
    c.query<{ id: string }>(
      `SELECT u.id FROM ${tableFor('User')} u
         JOIN profile p ON p.id = u.fields->>'ProfileId'
        WHERE u.is_deleted = false AND (p.perms->>'modifyAllData')::boolean = true
        ORDER BY u.created_date LIMIT 1`
    )
  );
  if (!admin.rows.length) return null;

  return new RequestContext({
    db,
    orgId,
    schema,
    userId: admin.rows[0].id,
    perms: ADMIN_PERMS,
    // Scheduled work is not a user transaction; give it room but keep it bounded.
    limits: new LimitContext({ soqlQueries: 1000, queryRows: 500_000, dmlStatements: 1000, dmlRows: 100_000, cpuMs: 120_000 })
  });
}

/** Due cron jobs for one org, claimed and stamped so a slow job is not started twice. */
async function runDueCronJobs(ctx: RequestContext, now: Date): Promise<{ ran: number; failed: number }> {
  const out = { ran: 0, failed: 0 };

  const due = await ctx.tenant((c) =>
    c.query<any>(
      `SELECT * FROM cron_job WHERE active = true AND (next_run IS NULL OR next_run <= $1) ORDER BY name`,
      [now.toISOString()]
    )
  );

  for (const job of due.rows) {
    const upcoming = nextRun(job.cron_expr, now);
    // Stamp the next run before executing: a job that throws must still move on, or it retries
    // every tick forever.
    await ctx.tenant((c) =>
      c.query(`UPDATE cron_job SET last_run = $2, next_run = $3 WHERE id = $1`, [
        job.id,
        now.toISOString(),
        upcoming ? upcoming.toISOString() : null
      ])
    );

    // A first sighting only establishes the schedule; it does not fire immediately.
    if (job.next_run === null) continue;

    try {
      await runCronJob(ctx, job);
      out.ran++;
    } catch (err) {
      console.error(`[meridian] scheduled job "${job.name}" failed:`, (err as Error)?.message ?? err);
      out.failed++;
    }
  }
  return out;
}

/** One pass over every org: due time triggers, then due cron jobs. */
export async function tick(db: Db, now = new Date()): Promise<TickResult> {
  const result: TickResult = {
    orgs: 0,
    timeTriggers: 0,
    timeTriggerFailures: 0,
    cronJobs: 0,
    cronFailures: 0,
    sessionsPurged: 0
  };

  const orgs = await db.query<{ id: string; schema_name: string }>(`SELECT id, schema_name FROM sys.orgs`);

  for (const org of orgs.rows) {
    const claimed = await withAdvisoryLock(db, `meridian:scheduler:${org.id}`, async () => {
      const ctx = await systemContext(db, org.id, org.schema_name);
      if (!ctx) return null;

      const triggers = await runDueTimeTriggers(ctx, now);
      const cron = await runDueCronJobs(ctx, now);
      return { triggers, cron };
    });

    if (!claimed) continue;
    result.orgs++;
    result.timeTriggers += claimed.triggers.processed;
    result.timeTriggerFailures += claimed.triggers.failed;
    result.cronJobs += claimed.cron.ran;
    result.cronFailures += claimed.cron.failed;
  }

  const purged = await withAdvisoryLock(db, 'meridian:sessions:purge', () => purgeExpiredSessions(db));
  result.sessionsPurged = purged ?? 0;
  return result;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private db: Db,
    private intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000)
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    // Never hold the process open for a tick that has not come.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Skips rather than queues when the previous tick is still going, so ticks cannot pile up. */
  async runOnce(): Promise<TickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await tick(this.db);
    } catch (err) {
      console.error('[meridian] scheduler tick failed:', err);
      return null;
    } finally {
      this.running = false;
    }
  }
}
