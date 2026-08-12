import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { ObjectMeta } from '../metadata/types.js';
import { getField } from '../metadata/types.js';
import type { DmlEvent, RecordChange } from '../dml/hooks.js';
import type { RequestContext } from '../runtime/context.js';
import { insertRecords, updateRecords } from '../dml/pipeline.js';
import { generateId, KEY_PREFIXES } from '../util/ids.js';
import { Errors } from '../util/errors.js';
import { runFormula, fromFValue } from '../formula/engine.js';
import { buildEvalContext, evaluateCondition, matchesFilters, type CriteriaFilter } from './criteria.js';
import { mergeFields } from './merge.js';

export type WorkflowTrigger = 'onCreate' | 'onCreateOrUpdate' | 'onCreateOrUpdateMeetingCriteriaChanged';

export interface FieldUpdateAction {
  type: 'fieldUpdate';
  field: string;
  value?: any;
  formula?: string;
}

export interface EmailAlertAction {
  type: 'emailAlert';
  template: string;
  recipients: Array<{ type: 'email' | 'field' | 'user'; value: string }>;
}

export interface TaskAction {
  type: 'task';
  subject: string;
  status?: string;
  priority?: string;
  dueDays?: number;
  ownerField?: string;
  ownerId?: string;
}

export interface OutboundMessageAction {
  type: 'outboundMessage';
  endpoint: string;
  fields?: string[];
}

export type WorkflowAction = FieldUpdateAction | EmailAlertAction | TaskAction | OutboundMessageAction;

export interface TimeTrigger {
  offsetHours: number;
  /** 'rule' offsets from now; anything else names a date field on the record. */
  base?: string;
  actions: WorkflowAction[];
}

interface WorkflowRuleRow {
  id: string;
  object_api: string;
  api_name: string;
  label: string;
  active: boolean;
  trigger_type: WorkflowTrigger;
  criteria: CriteriaFilter[] | null;
  criteria_formula: string | null;
  actions: WorkflowAction[];
  time_triggers: TimeTrigger[];
}

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Records currently being re-saved by a workflow field update.
 *
 * Without this, a field update would re-enter the save pipeline, re-run the same rule and loop.
 * Validation still runs on the re-save — which is the point — but workflow does not fire twice.
 */
const inFlight = new Set<string>();

function meetsCriteria(rule: WorkflowRuleRow, obj: ObjectMeta, record: Record<string, any>, before: Record<string, any> | null, userId: string): boolean {
  if (rule.criteria_formula) {
    const ctx = buildEvalContext({ object: obj, record, before, userId });
    return evaluateCondition(rule.criteria_formula, ctx);
  }
  const filters = parseJson<CriteriaFilter[]>(rule.criteria, []);
  if (!filters.length) return true;
  return matchesFilters(record, filters);
}

/** Decide whether a rule fires for this change, honouring its trigger type. */
function shouldFire(
  rule: WorkflowRuleRow,
  obj: ObjectMeta,
  change: RecordChange,
  operation: string,
  userId: string
): boolean {
  if (!change.after) return false;
  if (rule.trigger_type === 'onCreate' && operation !== 'insert') return false;

  const nowMatches = meetsCriteria(rule, obj, change.after, change.before, userId);
  if (!nowMatches) return false;

  if (rule.trigger_type === 'onCreateOrUpdateMeetingCriteriaChanged' && operation === 'update' && change.before) {
    // Fire only on the transition into the criteria, not on every subsequent save.
    const previouslyMatched = meetsCriteria(rule, obj, change.before, null, userId);
    if (previouslyMatched) return false;
  }
  return true;
}

async function resolveRecipients(
  c: DbClient,
  obj: ObjectMeta,
  record: Record<string, any>,
  recipients: EmailAlertAction['recipients']
): Promise<string[]> {
  const out: string[] = [];
  for (const recipient of recipients ?? []) {
    if (recipient.type === 'email') {
      out.push(recipient.value);
    } else if (recipient.type === 'field') {
      const value = record[recipient.value];
      if (value) out.push(String(value));
    } else if (recipient.type === 'user') {
      const rows = await c.query<{ fields: any }>(`SELECT fields FROM ${tableFor('User')} WHERE id = $1`, [recipient.value]);
      const fields = rows.rows.length ? parseJson<Record<string, any>>(rows.rows[0].fields, {}) : {};
      if (fields.Email) out.push(String(fields.Email));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

async function queueEmailAlert(
  c: DbClient,
  obj: ObjectMeta,
  record: Record<string, any>,
  action: EmailAlertAction
): Promise<void> {
  const templates = await c.query<{ id: string; subject: string; body_text: string; body_html: string }>(
    `SELECT id, subject, body_text, body_html FROM email_template WHERE api_name = $1`,
    [action.template]
  );
  if (!templates.rows.length) {
    throw Errors.invalidOperation(`Email alert refers to a template that does not exist: ${action.template}`);
  }
  const template = templates.rows[0];
  const to = await resolveRecipients(c, obj, record, action.recipients);
  if (!to.length) return;

  const sources = { object: obj, record };
  await c.query(
    `INSERT INTO email_outbound (id, to_addrs, subject, body_text, body_html, related_id, template_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Queued')`,
    [
      generateId(KEY_PREFIXES.EmailTemplate),
      JSON.stringify(to),
      mergeFields(template.subject ?? '', sources),
      template.body_text ? mergeFields(template.body_text, sources) : null,
      template.body_html ? mergeFields(template.body_html, sources) : null,
      record.Id ?? null,
      template.id
    ]
  );
}

async function createTask(
  ctx: RequestContext,
  client: DbClient,
  obj: ObjectMeta,
  record: Record<string, any>,
  action: TaskAction
): Promise<void> {
  const due = action.dueDays != null ? new Date(Date.now() + action.dueDays * 86400_000).toISOString().slice(0, 10) : null;
  const owner = action.ownerId ?? (action.ownerField ? record[action.ownerField] : null) ?? record.OwnerId ?? ctx.userId;

  await insertRecords(
    ctx,
    'Task',
    [
      {
        Subject: mergeFields(action.subject, { object: obj, record }),
        WhatId: record.Id,
        Status: action.status ?? 'Not Started',
        Priority: action.priority ?? 'Normal',
        ActivityDate: due,
        OwnerId: owner
      }
    ],
    { client, skipAutomation: true }
  );
}

/**
 * Run a set of actions outside the workflow-rule path.
 *
 * Approval processes fire the same action shapes on submit, approve, reject and recall, so the
 * executor is shared rather than reimplemented — one place decides what an "email alert" means.
 * Field updates are returned for the caller to apply, since who writes them differs by caller.
 */
export async function executeActions(
  ctx: RequestContext,
  client: DbClient,
  obj: ObjectMeta,
  record: Record<string, any>,
  actions: WorkflowAction[],
  sourceId: string
): Promise<Record<string, any>> {
  const fieldUpdates: Record<string, any> = {};
  for (const action of actions ?? []) {
    switch (action.type) {
      case 'fieldUpdate': {
        const update = fieldUpdatesFor(obj, action, { id: record.Id, before: null, after: record, input: {}, updates: {} }, ctx.userId);
        fieldUpdates[update.field] = update.value;
        break;
      }
      case 'emailAlert':
        await queueEmailAlert(client, obj, record, action);
        break;
      case 'task':
        await createTask(ctx, client, obj, record, action);
        break;
      case 'outboundMessage':
        await queueOutboundMessage(client, { id: sourceId } as WorkflowRuleRow, obj, record, action);
        break;
    }
  }
  return fieldUpdates;
}

async function queueOutboundMessage(
  c: DbClient,
  rule: WorkflowRuleRow,
  obj: ObjectMeta,
  record: Record<string, any>,
  action: OutboundMessageAction
): Promise<void> {
  const payload = action.fields?.length
    ? Object.fromEntries(action.fields.map((f) => [f, record[f] ?? null]))
    : record;
  // Queued rather than posted: an outbound HTTP call must not happen inside the save transaction.
  await c.query(
    `INSERT INTO time_trigger_queue (id, kind, source_id, object_api, record_id, fire_at, payload, status)
     VALUES ($1,'outboundMessage',$2,$3,$4, now(), $5, 'Pending')`,
    [generateId(KEY_PREFIXES.CronJob), rule.id, obj.apiName, record.Id, JSON.stringify({ endpoint: action.endpoint, payload })]
  );
}

/** Compute the field updates a rule wants, without writing them yet. */
function fieldUpdatesFor(
  obj: ObjectMeta,
  action: FieldUpdateAction,
  change: RecordChange,
  userId: string
): { field: string; value: any } {
  const field = getField(obj, action.field);
  if (!field) throw Errors.invalidField(action.field, obj.apiName);

  if (action.formula) {
    const ctx = buildEvalContext({ object: obj, record: change.after!, before: change.before, userId });
    return { field: field.apiName, value: fromFValue(runFormula(action.formula, ctx)) };
  }
  return { field: field.apiName, value: action.value ?? null };
}

async function scheduleTimeTriggers(
  c: DbClient,
  rule: WorkflowRuleRow,
  obj: ObjectMeta,
  record: Record<string, any>,
  fires: boolean
): Promise<void> {
  const triggers = parseJson<TimeTrigger[]>(rule.time_triggers, []);
  if (!triggers.length) return;

  // Re-evaluated on every save: a record that stops meeting the criteria loses its pending actions,
  // which is what "the renewal reminder stops once they have renewed" means in practice.
  await c.query(
    `DELETE FROM time_trigger_queue WHERE kind = 'workflow' AND source_id = $1 AND record_id = $2 AND status = 'Pending'`,
    [rule.id, record.Id]
  );
  if (!fires) return;

  for (const trigger of triggers) {
    let base: Date | null = new Date();
    if (trigger.base && trigger.base !== 'rule') {
      const raw = record[trigger.base];
      base = raw ? new Date(String(raw).length === 10 ? `${raw}T00:00:00Z` : String(raw)) : null;
    }
    if (!base || Number.isNaN(base.getTime())) continue;

    const fireAt = new Date(base.getTime() + (trigger.offsetHours ?? 0) * 3600_000);
    await c.query(
      `INSERT INTO time_trigger_queue (id, kind, source_id, object_api, record_id, fire_at, payload, status)
       VALUES ($1,'workflow',$2,$3,$4,$5,$6,'Pending')`,
      [
        generateId(KEY_PREFIXES.CronJob),
        rule.id,
        obj.apiName,
        record.Id,
        fireAt.toISOString(),
        JSON.stringify({ actions: trigger.actions })
      ]
    );
  }
}

/** Execute the immediate actions of every rule that fired. */
export async function runWorkflowRules(e: DmlEvent): Promise<void> {
  if (e.operation !== 'insert' && e.operation !== 'update') return;
  const applicable = e.changes.filter((change) => change.after && !inFlight.has(change.id));
  if (!applicable.length) return;

  const rules = await e.client.query<WorkflowRuleRow>(
    `SELECT * FROM workflow_rule WHERE object_api = $1 AND active = true ORDER BY api_name`,
    [e.object.apiName]
  );
  if (!rules.rows.length) return;

  const pendingUpdates = new Map<string, Record<string, any>>();

  for (const change of applicable) {
    for (const raw of rules.rows) {
      const rule: WorkflowRuleRow = {
        ...raw,
        actions: parseJson<WorkflowAction[]>(raw.actions, []),
        criteria: parseJson<CriteriaFilter[] | null>(raw.criteria, null)
      };
      const fires = shouldFire(rule, e.object, change, e.operation, e.ctx.userId);
      await scheduleTimeTriggers(e.client, rule, e.object, change.after!, fires);
      if (!fires) continue;

      for (const action of rule.actions) {
        switch (action.type) {
          case 'fieldUpdate': {
            const update = fieldUpdatesFor(e.object, action, change, e.ctx.userId);
            pendingUpdates.set(change.id, { ...(pendingUpdates.get(change.id) ?? {}), [update.field]: update.value });
            break;
          }
          case 'emailAlert':
            await queueEmailAlert(e.client, e.object, change.after!, action);
            break;
          case 'task':
            await createTask(e.ctx, e.client, e.object, change.after!, action);
            break;
          case 'outboundMessage':
            await queueOutboundMessage(e.client, rule, e.object, change.after!, action);
            break;
        }
      }
    }
  }

  if (!pendingUpdates.size) return;

  // Field updates go back through the save pipeline so they are coerced and re-validated, exactly
  // as Salesforce re-runs validation after a workflow field update.
  const records = [...pendingUpdates.entries()].map(([id, fields]) => ({ Id: id, ...fields }));
  for (const id of pendingUpdates.keys()) inFlight.add(id);
  try {
    await updateRecords(e.ctx, e.object.apiName, records, { client: e.client });
  } finally {
    for (const id of pendingUpdates.keys()) inFlight.delete(id);
  }

  // Reflect the updated values in the in-memory images so later hooks see the final record.
  for (const change of applicable) {
    const updates = pendingUpdates.get(change.id);
    if (updates && change.after) Object.assign(change.after, updates);
  }
}
