import type { DbClient } from '../db/index.js';
import { inTransaction } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { ObjectMeta } from '../metadata/types.js';
import { getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { updateRecords } from '../dml/pipeline.js';
import { rowToApi } from '../dml/pipeline.js';
import { matchesFilters } from '../automation/criteria.js';
import { buildEvalContext, evaluateCondition } from '../automation/criteria.js';
import { executeActions } from '../automation/workflow.js';
import { generateId, KEY_PREFIXES } from '../util/ids.js';
import { Errors } from '../util/errors.js';
import type {
  ApprovalProcess,
  ApprovalStep,
  ApprovalWorkItem,
  DecisionResult,
  SubmitResult
} from './types.js';

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toProcess(row: any): ApprovalProcess {
  return {
    id: row.id,
    objectApi: row.object_api,
    apiName: row.api_name,
    label: row.label,
    active: row.active,
    entryCriteria: parseJson(row.entry_criteria, null),
    entryFormula: row.entry_formula,
    lockRecord: row.lock_record,
    allowRecall: row.allow_recall,
    steps: parseJson(row.steps, []),
    initialSubmitActions: parseJson(row.initial_submit_actions, []),
    finalApproveActions: parseJson(row.final_approve_actions, []),
    finalRejectActions: parseJson(row.final_reject_actions, []),
    recallActions: parseJson(row.recall_actions, [])
  };
}

function toWorkItem(row: any): ApprovalWorkItem {
  return {
    id: row.id,
    processId: row.process_id,
    objectApi: row.object_api,
    recordId: row.record_id,
    stepIndex: row.step_index,
    stepName: row.step_name,
    status: row.status,
    assignedTo: row.assigned_to,
    submittedBy: row.submitted_by,
    submittedDate: row.submitted_date instanceof Date ? row.submitted_date.toISOString() : row.submitted_date,
    completedDate: row.completed_date instanceof Date ? row.completed_date.toISOString() : row.completed_date,
    actorId: row.actor_id,
    comments: parseJson(row.comments, [])
  };
}

async function loadRecord(c: DbClient, obj: ObjectMeta, recordId: string): Promise<Record<string, any>> {
  const rows = await c.query(`SELECT * FROM ${tableFor(obj.apiName)} WHERE id = $1 AND is_deleted = false`, [recordId]);
  if (!rows.rows.length) throw Errors.notFound(`entity is deleted or does not exist: ${recordId}`);
  return rowToApi(obj, rows.rows[0] as any);
}

/**
 * Resolve a step's approvers.
 *
 * A queue resolves to its members so each gets a work item, which is what makes unanimity and
 * "first response decides" both expressible without special-casing queues later.
 */
async function resolveApprovers(
  c: DbClient,
  step: ApprovalStep,
  record: Record<string, any>,
  submitterId: string
): Promise<string[]> {
  switch (step.approverType) {
    case 'user':
      if (!step.approverId) throw Errors.invalidOperation(`Approval step "${step.name}" names no approver`);
      return [step.approverId];

    case 'manager': {
      const rows = await c.query<{ fields: any }>(`SELECT fields FROM ${tableFor('User')} WHERE id = $1`, [submitterId]);
      const managerId = rows.rows.length ? parseJson<Record<string, any>>(rows.rows[0].fields, {}).ManagerId : null;
      if (!managerId) {
        throw Errors.invalidOperation(
          `Approval step "${step.name}" routes to the submitter's manager, but no manager is set.`
        );
      }
      return [String(managerId)];
    }

    case 'queue': {
      if (!step.approverId) throw Errors.invalidOperation(`Approval step "${step.name}" names no queue`);
      const rows = await c.query<{ member_ids: any }>(`SELECT member_ids FROM group_def WHERE id = $1`, [step.approverId]);
      if (!rows.rows.length) throw Errors.invalidOperation(`Approval step "${step.name}" names a queue that does not exist`);
      const members = parseJson<string[]>(rows.rows[0].member_ids, []);
      const users = members.filter((m) => !m.startsWith('role:') && !m.startsWith('group:'));
      if (!users.length) throw Errors.invalidOperation(`The queue for step "${step.name}" has no members`);
      return users;
    }

    case 'role': {
      if (!step.approverId) throw Errors.invalidOperation(`Approval step "${step.name}" names no role`);
      const rows = await c.query<{ id: string }>(
        `SELECT id FROM ${tableFor('User')} WHERE fields->>'UserRoleId' = $1 AND is_deleted = false`,
        [step.approverId]
      );
      if (!rows.rows.length) throw Errors.invalidOperation(`No users hold the role for step "${step.name}"`);
      return rows.rows.map((r) => r.id);
    }

    default:
      throw Errors.invalidOperation(`Unsupported approver type: ${step.approverType}`);
  }
}

/** The next step at or after `from` whose criteria the record meets; -1 when there are none left. */
function nextApplicableStep(process: ApprovalProcess, record: Record<string, any>, from: number): number {
  for (let i = from; i < process.steps.length; i++) {
    const step = process.steps[i];
    if (!step.criteria?.length || matchesFilters(record, step.criteria)) return i;
  }
  return -1;
}

async function createWorkItems(
  c: DbClient,
  process: ApprovalProcess,
  record: Record<string, any>,
  stepIndex: number,
  submitterId: string
): Promise<string[]> {
  const step = process.steps[stepIndex];
  const approvers = await resolveApprovers(c, step, record, submitterId);
  const ids: string[] = [];

  for (const approver of approvers) {
    const id = generateId(KEY_PREFIXES.ProcessInstanceWorkitem);
    await c.query(
      `INSERT INTO approval_work_item
         (id, process_id, object_api, record_id, step_index, step_name, status, assigned_to, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,'Pending',$7,$8)`,
      [id, process.id, process.objectApi, record.Id, stepIndex, step.name, approver, submitterId]
    );
    ids.push(id);
  }
  return ids;
}

/** Apply field updates produced by approval actions, bypassing the lock they may have set. */
async function applyActionUpdates(
  ctx: RequestContext,
  c: DbClient,
  obj: ObjectMeta,
  recordId: string,
  updates: Record<string, any>
): Promise<void> {
  if (!Object.keys(updates).length) return;
  await updateRecords(ctx, obj.apiName, [{ ...updates, Id: recordId }], { client: c, skipApprovalLock: true });
}

/* -------------------------------- submission ------------------------------- */

export async function submitForApproval(
  ctx: RequestContext,
  objectApi: string,
  recordId: string,
  opts: { processApiName?: string; comment?: string; client?: DbClient } = {}
): Promise<SubmitResult> {
  const org = await ctx.orgMeta();
  const obj = getObject(org, objectApi);
  if (!obj) throw Errors.invalidType(objectApi);

  const run = async (c: DbClient): Promise<SubmitResult> => {
    const record = await loadRecord(c, obj, recordId);

    const pending = await c.query(
      `SELECT 1 FROM approval_work_item WHERE record_id = $1 AND status = 'Pending' LIMIT 1`,
      [recordId]
    );
    if (pending.rows.length) {
      throw Errors.invalidOperation('This record is already in an approval process.');
    }

    const processes = await c.query(
      `SELECT * FROM approval_process WHERE object_api = $1 AND active = true${opts.processApiName ? ' AND api_name = $2' : ''} ORDER BY api_name`,
      opts.processApiName ? [obj.apiName, opts.processApiName] : [obj.apiName]
    );
    if (!processes.rows.length) throw Errors.notFound(`No active approval process for ${obj.apiName}`);

    // The first process whose entry criteria the record meets, as Salesforce does.
    let process: ApprovalProcess | null = null;
    for (const row of processes.rows) {
      const candidate = toProcess(row);
      const entryMet = candidate.entryFormula
        ? evaluateCondition(
            candidate.entryFormula,
            buildEvalContext({ object: obj, record, before: null, userId: ctx.userId })
          )
        : !candidate.entryCriteria?.length || matchesFilters(record, candidate.entryCriteria);
      if (entryMet) {
        process = candidate;
        break;
      }
    }
    if (!process) throw Errors.invalidOperation('This record does not meet the entry criteria of any approval process.');
    if (!process.steps.length) throw Errors.invalidOperation(`Approval process ${process.apiName} has no steps.`);

    const submitUpdates = await executeActions(ctx, c, obj, record, process.initialSubmitActions, process.id);
    await applyActionUpdates(ctx, c, obj, recordId, submitUpdates);
    const afterSubmit = { ...record, ...submitUpdates };

    const stepIndex = nextApplicableStep(process, afterSubmit, 0);
    if (stepIndex === -1) {
      // Every step was skipped: approved outright.
      const updates = await executeActions(ctx, c, obj, afterSubmit, process.finalApproveActions, process.id);
      await applyActionUpdates(ctx, c, obj, recordId, updates);
      return { processId: process.id, workItemIds: [], status: 'Approved', stepName: null };
    }

    const workItemIds = await createWorkItems(c, process, afterSubmit, stepIndex, ctx.userId);
    if (opts.comment) {
      await c.query(
        `UPDATE approval_work_item SET comments = $2 WHERE id = ANY($1)`,
        [workItemIds, JSON.stringify([{ actorId: ctx.userId, comment: opts.comment, at: new Date().toISOString() }])]
      );
    }

    return {
      processId: process.id,
      workItemIds,
      status: 'Pending',
      stepName: process.steps[stepIndex].name
    };
  };

  return opts.client ? run(opts.client) : ctx.tenant((c) => inTransaction(c, () => run(c)));
}

/* --------------------------------- decisions ------------------------------- */

async function loadWorkItem(c: DbClient, workItemId: string): Promise<ApprovalWorkItem> {
  const rows = await c.query(`SELECT * FROM approval_work_item WHERE id = $1`, [workItemId]);
  if (!rows.rows.length) throw Errors.notFound(`No approval work item ${workItemId}`);
  return toWorkItem(rows.rows[0]);
}

async function loadProcess(c: DbClient, processId: string): Promise<ApprovalProcess> {
  const rows = await c.query(`SELECT * FROM approval_process WHERE id = $1`, [processId]);
  if (!rows.rows.length) throw Errors.notFound(`No approval process ${processId}`);
  return toProcess(rows.rows[0]);
}

function assertActorMay(ctx: RequestContext, item: ApprovalWorkItem): void {
  if (item.status !== 'Pending') {
    throw Errors.invalidOperation(`This request has already been ${item.status.toLowerCase()}.`);
  }
  const isAdmin = ctx.perms.modifyAllData === true || (ctx.access as any)?.perms?.approvalAdmin === true;
  if (item.assignedTo !== ctx.userId && !isAdmin) {
    throw Errors.insufficientAccess('You are not an assigned approver for this request.');
  }
}

async function completeItem(
  c: DbClient,
  item: ApprovalWorkItem,
  status: 'Approved' | 'Rejected' | 'Recalled',
  actorId: string,
  comment?: string
): Promise<void> {
  const comments = [...item.comments];
  if (comment) comments.push({ actorId, comment, at: new Date().toISOString() });
  await c.query(
    `UPDATE approval_work_item SET status = $2, actor_id = $3, completed_date = now(), comments = $4 WHERE id = $1`,
    [item.id, status, actorId, JSON.stringify(comments)]
  );
}

export async function approve(
  ctx: RequestContext,
  workItemId: string,
  opts: { comment?: string; client?: DbClient } = {}
): Promise<DecisionResult> {
  const run = async (c: DbClient): Promise<DecisionResult> => {
    const item = await loadWorkItem(c, workItemId);
    assertActorMay(ctx, item);

    const org = await ctx.orgMeta();
    const obj = getObject(org, item.objectApi);
    if (!obj) throw Errors.invalidType(item.objectApi);
    const process = await loadProcess(c, item.processId);
    const step = process.steps[item.stepIndex];

    await completeItem(c, item, 'Approved', ctx.userId, opts.comment);

    // Unanimous steps wait for every assignee; otherwise the first response decides and the
    // remaining work items are closed so nobody acts on a settled request.
    const siblings = await c.query<{ id: string }>(
      `SELECT id FROM approval_work_item
        WHERE record_id = $1 AND process_id = $2 AND step_index = $3 AND status = 'Pending'`,
      [item.recordId, item.processId, item.stepIndex]
    );
    if (step?.unanimity && siblings.rows.length) {
      return { status: 'Pending', stepName: step.name, workItemIds: siblings.rows.map((r) => r.id) };
    }
    if (siblings.rows.length) {
      await c.query(
        `UPDATE approval_work_item SET status = 'Approved', actor_id = $2, completed_date = now() WHERE id = ANY($1)`,
        [siblings.rows.map((r) => r.id), ctx.userId]
      );
    }

    const record = await loadRecord(c, obj, item.recordId);
    const stepUpdates = await executeActions(ctx, c, obj, record, step?.approveActions ?? [], process.id);
    await applyActionUpdates(ctx, c, obj, item.recordId, stepUpdates);
    const afterStep = { ...record, ...stepUpdates };

    const nextIndex = nextApplicableStep(process, afterStep, item.stepIndex + 1);
    if (nextIndex === -1) {
      const updates = await executeActions(ctx, c, obj, afterStep, process.finalApproveActions, process.id);
      await applyActionUpdates(ctx, c, obj, item.recordId, updates);
      return { status: 'Approved', stepName: null, workItemIds: [] };
    }

    const ids = await createWorkItems(c, process, afterStep, nextIndex, item.submittedBy);
    return { status: 'Pending', stepName: process.steps[nextIndex].name, workItemIds: ids };
  };

  return opts.client ? run(opts.client) : ctx.tenant((c) => inTransaction(c, () => run(c)));
}

export async function reject(
  ctx: RequestContext,
  workItemId: string,
  opts: { comment?: string; client?: DbClient } = {}
): Promise<DecisionResult> {
  const run = async (c: DbClient): Promise<DecisionResult> => {
    const item = await loadWorkItem(c, workItemId);
    assertActorMay(ctx, item);

    const org = await ctx.orgMeta();
    const obj = getObject(org, item.objectApi);
    if (!obj) throw Errors.invalidType(item.objectApi);
    const process = await loadProcess(c, item.processId);
    const step = process.steps[item.stepIndex];

    await completeItem(c, item, 'Rejected', ctx.userId, opts.comment);
    // One rejection ends the request; co-assignees should not be left holding a dead item.
    await c.query(
      `UPDATE approval_work_item SET status = 'Rejected', actor_id = $2, completed_date = now()
        WHERE record_id = $1 AND process_id = $3 AND status = 'Pending'`,
      [item.recordId, ctx.userId, item.processId]
    );

    const record = await loadRecord(c, obj, item.recordId);
    const stepUpdates = await executeActions(ctx, c, obj, record, step?.rejectActions ?? [], process.id);
    await applyActionUpdates(ctx, c, obj, item.recordId, stepUpdates);
    const updates = await executeActions(ctx, c, obj, { ...record, ...stepUpdates }, process.finalRejectActions, process.id);
    await applyActionUpdates(ctx, c, obj, item.recordId, updates);

    return { status: 'Rejected', stepName: step?.name ?? null, workItemIds: [] };
  };

  return opts.client ? run(opts.client) : ctx.tenant((c) => inTransaction(c, () => run(c)));
}

export async function recall(
  ctx: RequestContext,
  recordId: string,
  opts: { comment?: string; client?: DbClient } = {}
): Promise<DecisionResult> {
  const run = async (c: DbClient): Promise<DecisionResult> => {
    const items = await c.query(
      `SELECT * FROM approval_work_item WHERE record_id = $1 AND status = 'Pending' ORDER BY submitted_date`,
      [recordId]
    );
    if (!items.rows.length) throw Errors.invalidOperation('This record is not awaiting approval.');
    const first = toWorkItem(items.rows[0]);

    const process = await loadProcess(c, first.processId);
    if (!process.allowRecall) throw Errors.invalidOperation(`Approval process ${process.apiName} does not allow recall.`);

    const isAdmin = ctx.perms.modifyAllData === true;
    if (first.submittedBy !== ctx.userId && !isAdmin) {
      throw Errors.insufficientAccess('Only the submitter may recall this request.');
    }

    for (const row of items.rows) {
      await completeItem(c, toWorkItem(row), 'Recalled', ctx.userId, opts.comment);
    }

    const org = await ctx.orgMeta();
    const obj = getObject(org, first.objectApi);
    if (!obj) throw Errors.invalidType(first.objectApi);
    const record = await loadRecord(c, obj, recordId);
    const updates = await executeActions(ctx, c, obj, record, process.recallActions, process.id);
    await applyActionUpdates(ctx, c, obj, recordId, updates);

    return { status: 'Rejected', stepName: null, workItemIds: [] };
  };

  return opts.client ? run(opts.client) : ctx.tenant((c) => inTransaction(c, () => run(c)));
}

/* ---------------------------------- queries -------------------------------- */

/** Pending work items assigned to a user — their approval inbox. */
export async function pendingForUser(ctx: RequestContext, userId = ctx.userId): Promise<ApprovalWorkItem[]> {
  const rows = await ctx.tenant((c) =>
    c.query(`SELECT * FROM approval_work_item WHERE assigned_to = $1 AND status = 'Pending' ORDER BY submitted_date`, [
      userId
    ])
  );
  return rows.rows.map(toWorkItem);
}

/** Full approval history for a record, newest first. */
export async function historyForRecord(ctx: RequestContext, recordId: string): Promise<ApprovalWorkItem[]> {
  const rows = await ctx.tenant((c) =>
    c.query(`SELECT * FROM approval_work_item WHERE record_id = $1 ORDER BY submitted_date DESC, step_index DESC`, [recordId])
  );
  return rows.rows.map(toWorkItem);
}

/**
 * Records currently locked by a pending approval.
 *
 * Derived from the pending work items rather than stored on the record: a lock flag and the work
 * items it describes would be two sources of truth, and they would drift.
 */
export async function lockedRecordIds(c: DbClient, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await c.query<{ record_id: string }>(
    `SELECT DISTINCT w.record_id
       FROM approval_work_item w
       JOIN approval_process p ON p.id = w.process_id
      WHERE w.record_id = ANY($1) AND w.status = 'Pending' AND p.lock_record = true`,
    [ids]
  );
  return new Set(rows.rows.map((r) => r.record_id));
}
