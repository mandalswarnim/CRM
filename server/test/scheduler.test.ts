import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { config } from '../src/config.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, deleteRecords, getRecord, insertRecord } from '../src/dml/index.js';
import { installAutomation } from '../src/automation/index.js';
import {
  dispatchQueuedEmail,
  isValidCron,
  nextRun,
  parseCron,
  runCronJob,
  runDueTimeTriggers,
  tick,
  weeklyExport,
  Scheduler
} from '../src/scheduler/index.js';
import { generateId, KEY_PREFIXES } from '../src/util/ids.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;

function context(): RequestContext {
  return new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId: org.adminUserId,
    perms: ADMIN_PERMS,
    limits: new LimitContext({ dmlRows: 5000, dmlStatements: 5000, soqlQueries: 5000, queryRows: 500000 })
  });
}

const at = (iso: string) => new Date(iso);

async function queueTrigger(row: {
  kind: string;
  objectApi: string;
  recordId: string;
  fireAt: string;
  payload: any;
  sourceId?: string;
}): Promise<string> {
  const id = generateId(KEY_PREFIXES.CronJob);
  await org.tenant((c) =>
    c.query(
      `INSERT INTO time_trigger_queue (id, kind, source_id, object_api, record_id, fire_at, payload, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending')`,
      [id, row.kind, row.sourceId ?? generateId(KEY_PREFIXES.WorkflowRule), row.objectApi, row.recordId, row.fireAt, JSON.stringify(row.payload)]
    )
  );
  return id;
}

const clearQueue = () => org.tenant((c) => c.query(`DELETE FROM time_trigger_queue`));
const clearCron = () => org.tenant((c) => c.query(`DELETE FROM cron_job`));

beforeAll(async () => {
  org = await testOrg();
  installAutomation();

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Renewal__c',
      label: 'Renewal',
      pluralLabel: 'Renewals',
      isCustom: true,
      fields: [
        { apiName: 'Status__c', label: 'Status', type: 'Picklist', picklist: { values: ['Due', 'Reminded', 'Paid'] } },
        { apiName: 'Notes__c', label: 'Notes', type: 'TextArea' }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);
  await clearCron();
});

afterAll(() => {
  clearDmlHooks();
});

describe('cron parsing', () => {
  it('parses the five fields', () => {
    const spec = parseCron('30 2 * * *');
    expect(spec.minute.values).toEqual(new Set([30]));
    expect(spec.hour.values).toEqual(new Set([2]));
    expect(spec.dayOfMonth.values).toBeNull();
  });

  it('handles lists, ranges, steps and names', () => {
    expect([...parseCron('0,30 * * * *').minute.values!]).toEqual([0, 30]);
    expect([...parseCron('0 9-11 * * *').hour.values!]).toEqual([9, 10, 11]);
    expect([...parseCron('*/15 * * * *').minute.values!]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('@daily').hour.values!]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    expect(isValidCron('30 2 * *')).toBe(false);
    expect(isValidCron('99 * * * *')).toBe(false);
    expect(isValidCron('* * * * 9')).toBe(false);
    expect(isValidCron('0 0 * * *')).toBe(true);
  });

  it('computes the next run strictly after the given moment', () => {
    expect(nextRun('0 3 * * *', at('2026-08-13T02:00:00Z'))!.toISOString()).toBe('2026-08-13T03:00:00.000Z');
    // Already past today, so tomorrow.
    expect(nextRun('0 3 * * *', at('2026-08-13T03:00:00Z'))!.toISOString()).toBe('2026-08-14T03:00:00.000Z');
    // Sunday 04:00 — the weekly export slot.
    expect(nextRun('0 4 * * 0', at('2026-08-13T00:00:00Z'))!.toISOString()).toBe('2026-08-16T04:00:00.000Z');
  });

  it('treats restricted day-of-month and day-of-week as an either/or, as cron does', () => {
    // The 1st of the month, or any Monday.
    const from = at('2026-08-13T00:00:00Z'); // a Thursday
    expect(nextRun('0 0 1 * 1', from)!.toISOString()).toBe('2026-08-17T00:00:00.000Z'); // Monday first
  });

  it('gives up on an unsatisfiable expression rather than looping', () => {
    expect(nextRun('0 0 30 2 *', at('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('time-based triggers', () => {
  it('fires a due trigger and leaves a future one alone', async () => {
    const ctx = context();
    const due = await insertRecord(ctx, 'Renewal__c', { Name: 'Due now', Status__c: 'Due' });
    const later = await insertRecord(ctx, 'Renewal__c', { Name: 'Not yet', Status__c: 'Due' });

    await queueTrigger({
      kind: 'workflow',
      objectApi: 'Renewal__c',
      recordId: due,
      fireAt: '2026-08-01T00:00:00Z',
      payload: { actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Reminded' }] }
    });
    await queueTrigger({
      kind: 'workflow',
      objectApi: 'Renewal__c',
      recordId: later,
      fireAt: '2027-01-01T00:00:00Z',
      payload: { actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Reminded' }] }
    });

    const outcome = await runDueTimeTriggers(ctx, at('2026-08-13T00:00:00Z'));
    expect(outcome.processed).toBe(1);
    expect((await getRecord(ctx, 'Renewal__c', due))!.Status__c).toBe('Reminded');
    expect((await getRecord(ctx, 'Renewal__c', later))!.Status__c).toBe('Due');

    const remaining = await org.tenant((c) => c.query(`SELECT status FROM time_trigger_queue ORDER BY fire_at`));
    expect(remaining.rows.map((r: any) => r.status)).toEqual(['Done', 'Pending']);
    await clearQueue();
  });

  it('treats a deleted record as nothing to do, not a failure', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Renewal__c', { Name: 'Gone', Status__c: 'Due' });
    await deleteRecords(ctx, 'Renewal__c', [id]);

    await queueTrigger({
      kind: 'workflow',
      objectApi: 'Renewal__c',
      recordId: id,
      fireAt: '2026-08-01T00:00:00Z',
      payload: { actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Reminded' }] }
    });

    const outcome = await runDueTimeTriggers(ctx, at('2026-08-13T00:00:00Z'));
    expect(outcome).toEqual({ processed: 1, failed: 0 });
    await clearQueue();
  });

  it('marks one failing trigger without stalling the others', async () => {
    const ctx = context();
    const good = await insertRecord(ctx, 'Renewal__c', { Name: 'Good', Status__c: 'Due' });

    await queueTrigger({
      kind: 'outboundMessage',
      objectApi: 'Renewal__c',
      recordId: good,
      fireAt: '2026-08-01T00:00:00Z',
      payload: {} // no endpoint: this one must fail
    });
    await queueTrigger({
      kind: 'workflow',
      objectApi: 'Renewal__c',
      recordId: good,
      fireAt: '2026-08-01T00:00:01Z',
      payload: { actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Reminded' }] }
    });

    const outcome = await runDueTimeTriggers(ctx, at('2026-08-13T00:00:00Z'));
    expect(outcome.failed).toBe(1);
    expect(outcome.processed).toBe(1);
    expect((await getRecord(ctx, 'Renewal__c', good))!.Status__c).toBe('Reminded');

    const failed = await org.tenant((c) => c.query(`SELECT payload FROM time_trigger_queue WHERE status = 'Failed'`));
    expect(JSON.stringify(failed.rows[0].payload)).toContain('endpoint');
    await clearQueue();
  });
});

describe('cron jobs', () => {
  it('purges the recycle bin past the retention window', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Renewal__c', { Name: 'Purgeable', Status__c: 'Due' });
    await deleteRecords(ctx, 'Renewal__c', [id]);
    await org.tenant((c) =>
      c.query(`UPDATE d_renewal__c SET deleted_date = now() - interval '30 days' WHERE id = $1`, [id])
    );

    const purged = await runCronJob(ctx, { kind: 'purgeRecycleBin', name: 'Purge', payload: { olderThanDays: 15 } });
    expect(purged).toBeGreaterThan(0);
    expect(await getRecord(ctx, 'Renewal__c', id, { includeDeleted: true })).toBeNull();
  });

  it('runs a scheduled flow', async () => {
    await org.tenant((c) =>
      c.query(
        `INSERT INTO flow_def (id, api_name, label, version, status, process_type, start_node, nodes, variables)
         VALUES ($1,'NightlyTidy','Nightly Tidy',1,'Active','Scheduled','create',$2,'[]')`,
        [
          generateId(KEY_PREFIXES.Flow),
          JSON.stringify({
            create: {
              type: 'createRecords',
              object: 'Renewal__c',
              fields: { Name: 'Created by schedule', Status__c: 'Due' }
            }
          })
        ]
      )
    );

    const ctx = context();
    await runCronJob(ctx, { kind: 'scheduledFlow', name: 'Nightly', payload: { flow: 'NightlyTidy' } });
    const found = await org.tenant((c) => c.query(`SELECT 1 FROM d_renewal__c WHERE name = 'Created by schedule'`));
    expect(found.rows).toHaveLength(1);
  });

  it('reports a job kind it does not know rather than failing silently', async () => {
    await expect(runCronJob(context(), { kind: 'nonsense', name: 'Bad', payload: {} })).rejects.toThrow(/Unknown scheduled job kind/);
  });

  it('exports every object to CSV', async () => {
    const ctx = context();
    await insertRecord(ctx, 'Renewal__c', { Name: 'Exported, "quoted"', Status__c: 'Paid' });

    const files = await weeklyExport(ctx, ['Renewal__c']);
    expect(files).toBe(1);

    const dir = path.join(config.dataDir, 'exports', org.orgId, new Date().toISOString().slice(0, 10));
    const csv = fs.readFileSync(path.join(dir, 'Renewal__c.csv'), 'utf8');
    expect(csv.split('\n')[0]).toContain('Status__c');
    // Commas and quotes in a value must not break the row.
    expect(csv).toContain('"Exported, ""quoted"""');
    fs.rmSync(path.join(config.dataDir, 'exports', org.orgId), { recursive: true, force: true });
  });
});

describe('email dispatch', () => {
  it('writes queued mail to the outbox and marks it sent', async () => {
    const id = generateId(KEY_PREFIXES.EmailTemplate);
    await org.tenant((c) =>
      c.query(
        `INSERT INTO email_outbound (id, to_addrs, subject, body_text, status)
         VALUES ($1,$2,'Your renewal is due','Dear member, your subscription falls due.','Queued')`,
        [id, JSON.stringify(['member@example.com'])]
      )
    );

    const sent = await org.tenant((c) => dispatchQueuedEmail(c, org.orgId));
    expect(sent).toBe(1);

    const file = path.join(config.dataDir, 'outbox', org.orgId, `${id}.eml`);
    const eml = fs.readFileSync(file, 'utf8');
    expect(eml).toContain('To: member@example.com');
    expect(eml).toContain('Subject: Your renewal is due');

    const row = await org.tenant((c) => c.query(`SELECT status, sent_at FROM email_outbound WHERE id = $1`, [id]));
    expect(row.rows[0].status).toBe('Sent');
    expect(row.rows[0].sent_at).toBeTruthy();
    fs.rmSync(path.join(config.dataDir, 'outbox', org.orgId), { recursive: true, force: true });
  });

  it('records a failure instead of retrying forever', async () => {
    const id = generateId(KEY_PREFIXES.EmailTemplate);
    await org.tenant((c) =>
      c.query(`INSERT INTO email_outbound (id, to_addrs, subject, status) VALUES ($1,'[]','No recipients','Queued')`, [id])
    );

    await org.tenant((c) => dispatchQueuedEmail(c, org.orgId));
    const row = await org.tenant((c) => c.query(`SELECT status, error FROM email_outbound WHERE id = $1`, [id]));
    expect(row.rows[0].status).toBe('Failed');
    expect(row.rows[0].error).toContain('no recipients');
  });
});

describe('the tick', () => {
  it('establishes a schedule on first sighting without firing', async () => {
    await clearCron();
    await org.tenant((c) =>
      c.query(
        `INSERT INTO cron_job (id, name, kind, cron_expr, payload, active) VALUES ($1,'Purge','purgeRecycleBin','0 3 * * *','{}',true)`,
        [generateId(KEY_PREFIXES.CronJob)]
      )
    );

    const first = await tick(org.db, at('2026-08-13T03:00:00Z'));
    expect(first.cronJobs).toBe(0); // scheduled, not run

    const job = await org.tenant((c) => c.query(`SELECT next_run, last_run FROM cron_job WHERE name = 'Purge'`));
    expect(job.rows[0].next_run).toBeTruthy();
    expect(job.rows[0].last_run).toBeTruthy();
  });

  it('runs a job once its next_run has passed', async () => {
    await clearCron();
    await org.tenant((c) =>
      c.query(
        `INSERT INTO cron_job (id, name, kind, cron_expr, payload, active, next_run)
         VALUES ($1,'Dispatch','emailDispatch','*/5 * * * *','{}',true,'2026-08-01T00:00:00Z')`,
        [generateId(KEY_PREFIXES.CronJob)]
      )
    );

    const result = await tick(org.db, at('2026-08-13T03:07:00Z'));
    expect(result.cronJobs).toBe(1);
    expect(result.orgs).toBe(1);

    const job = await org.tenant((c) => c.query(`SELECT next_run FROM cron_job WHERE name = 'Dispatch'`));
    expect(new Date(job.rows[0].next_run).toISOString()).toBe('2026-08-13T03:10:00.000Z');
  });

  it('moves a failing job on rather than retrying it every tick', async () => {
    await clearCron();
    await org.tenant((c) =>
      c.query(
        `INSERT INTO cron_job (id, name, kind, cron_expr, payload, active, next_run)
         VALUES ($1,'Broken','nonsense','0 * * * *','{}',true,'2026-08-01T00:00:00Z')`,
        [generateId(KEY_PREFIXES.CronJob)]
      )
    );

    const result = await tick(org.db, at('2026-08-13T03:00:00Z'));
    expect(result.cronFailures).toBe(1);

    const job = await org.tenant((c) => c.query(`SELECT next_run FROM cron_job WHERE name = 'Broken'`));
    expect(new Date(job.rows[0].next_run).getTime()).toBeGreaterThan(at('2026-08-13T03:00:00Z').getTime());
    await clearCron();
  });

  it('ignores inactive jobs', async () => {
    await clearCron();
    await org.tenant((c) =>
      c.query(
        `INSERT INTO cron_job (id, name, kind, cron_expr, payload, active, next_run)
         VALUES ($1,'Dormant','emailDispatch','* * * * *',' {}',false,'2026-08-01T00:00:00Z')`,
        [generateId(KEY_PREFIXES.CronJob)]
      )
    );
    expect((await tick(org.db, at('2026-08-13T03:00:00Z'))).cronJobs).toBe(0);
    await clearCron();
  });

  it('does not let ticks pile up on one another', async () => {
    const scheduler = new Scheduler(org.db, 60_000);
    const [first, second] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    // One of the two is skipped rather than queued behind the other.
    expect([first, second].filter((r) => r === null)).toHaveLength(1);
    scheduler.stop();
  });
});
