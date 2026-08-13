import fs from 'node:fs';
import path from 'node:path';
import type { DbClient } from '../db/index.js';
import { config } from '../config.js';
import { tableFor } from '../metadata/registry.js';
import { getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { purgeRecycleBin, rowToApi } from '../dml/pipeline.js';
import { executeActions, type WorkflowAction } from '../automation/workflow.js';
import { updateRecords } from '../dml/pipeline.js';
import { loadFlow, runFlow } from '../flow/engine.js';
import { dispatchQueuedEmail } from './email.js';

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export interface JobOutcome {
  processed: number;
  failed: number;
}

/* ----------------------------- time-based work ----------------------------- */

/**
 * Fire time-based workflow actions whose moment has come.
 *
 * Each queue row is settled individually: one failing trigger marks itself Failed and leaves the
 * rest to run, because a single bad rule must not stall every reminder in the org.
 */
export async function runDueTimeTriggers(ctx: RequestContext, now = new Date()): Promise<JobOutcome> {
  const outcome: JobOutcome = { processed: 0, failed: 0 };

  const due = await ctx.tenant((c) =>
    c.query<any>(
      `SELECT * FROM time_trigger_queue
        WHERE status = 'Pending' AND fire_at <= $1 AND kind IN ('workflow','outboundMessage')
        ORDER BY fire_at LIMIT 200`,
      [now.toISOString()]
    )
  );

  for (const row of due.rows) {
    try {
      if (row.kind === 'workflow') await fireWorkflowTrigger(ctx, row);
      else await fireOutboundMessage(ctx, row);
      await ctx.tenant((c) => c.query(`UPDATE time_trigger_queue SET status = 'Done' WHERE id = $1`, [row.id]));
      outcome.processed++;
    } catch (err) {
      await ctx.tenant((c) =>
        c.query(`UPDATE time_trigger_queue SET status = 'Failed', payload = payload || $2::jsonb WHERE id = $1`, [
          row.id,
          JSON.stringify({ error: String((err as Error)?.message ?? err) })
        ])
      );
      outcome.failed++;
    }
  }
  return outcome;
}

async function fireWorkflowTrigger(ctx: RequestContext, row: any): Promise<void> {
  const org = await ctx.orgMeta();
  const obj = getObject(org, row.object_api);
  if (!obj) return;
  const actions = parseJson<{ actions?: WorkflowAction[] }>(row.payload, {}).actions ?? [];

  await ctx.tenant(async (c) => {
    const found = await c.query(`SELECT * FROM ${tableFor(obj.apiName)} WHERE id = $1 AND is_deleted = false`, [
      row.record_id
    ]);
    // The record may have been deleted since the trigger was queued; that is not a failure.
    if (!found.rows.length) return;

    const record = rowToApi(obj, found.rows[0] as any);
    const updates = await executeActions(ctx, c, obj, record, actions, row.source_id);
    if (Object.keys(updates).length) {
      await updateRecords(ctx, obj.apiName, [{ ...updates, Id: row.record_id }], { client: c, skipApprovalLock: true });
    }
  });
}

async function fireOutboundMessage(ctx: RequestContext, row: any): Promise<void> {
  const payload = parseJson<{ endpoint?: string; payload?: unknown }>(row.payload, {});
  if (!payload.endpoint) throw new Error('outbound message has no endpoint');

  const response = await fetch(payload.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId: ctx.orgId,
      sobject: row.object_api,
      recordId: row.record_id,
      payload: payload.payload ?? {}
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`endpoint returned ${response.status}`);
}

/* -------------------------------- cron jobs -------------------------------- */

export type CronJobKind = 'scheduledFlow' | 'weeklyExport' | 'purgeRecycleBin' | 'emailDispatch' | 'reportSubscription';

/** Dispatch one due cron job. Unknown kinds raise, so a typo in Setup is visible rather than silent. */
export async function runCronJob(ctx: RequestContext, job: { kind: string; payload: any; name: string }): Promise<number> {
  const payload = parseJson<Record<string, any>>(job.payload, {});

  switch (job.kind) {
    case 'purgeRecycleBin':
      return purgeRecycleBin(ctx, payload.olderThanDays ?? 15);

    case 'emailDispatch':
      return ctx.tenant((c) => dispatchQueuedEmail(c, ctx.orgId, payload.limit ?? 50));

    case 'scheduledFlow': {
      const flow = await loadFlow(ctx, payload.flow);
      if (!flow) throw new Error(`scheduled job "${job.name}" names a flow that is not active: ${payload.flow}`);
      await runFlow(ctx, flow, { inputs: payload.inputs ?? {} });
      return 1;
    }

    case 'weeklyExport':
      return weeklyExport(ctx, payload.objects);

    case 'reportSubscription':
      // Reports arrive with task 25; the job is accepted so schedules can be configured now.
      return 0;

    default:
      throw new Error(`Unknown scheduled job kind: ${job.kind}`);
  }
}

/**
 * Write every record of every queryable object to CSV under DATA_DIR/exports.
 *
 * Deliberately a full dump rather than a delta: this is the "get my data out" guarantee, and a
 * delta that silently misses rows is worse than no export at all.
 */
export async function weeklyExport(ctx: RequestContext, only?: string[]): Promise<number> {
  const org = await ctx.orgMeta();
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(config.dataDir, 'exports', ctx.orgId, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const wanted = only?.length ? new Set(only.map((o) => o.toLowerCase())) : null;
  let files = 0;

  for (const obj of org.objectList) {
    if (!obj.isQueryable) continue;
    if (wanted && !wanted.has(obj.apiName.toLowerCase())) continue;

    const rows = await ctx.tenant((c) =>
      c.query(`SELECT * FROM ${tableFor(obj.apiName)} WHERE is_deleted = false ORDER BY created_date`)
    );
    if (!rows.rows.length) continue;

    const columns = obj.fieldList.filter((f) => f.type !== 'Formula' && f.type !== 'RollupSummary').map((f) => f.apiName);
    const lines = [columns.map(csvCell).join(',')];
    for (const raw of rows.rows) {
      const record = rowToApi(obj, raw as any);
      lines.push(columns.map((col) => csvCell(record[col])).join(','));
    }
    fs.writeFileSync(path.join(dir, `${obj.apiName}.csv`), lines.join('\n'), 'utf8');
    files++;
  }
  return files;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
