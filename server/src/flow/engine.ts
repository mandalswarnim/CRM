import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import { getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { deleteRecords, insertRecords, updateRecords } from '../dml/pipeline.js';
import { runQuery } from '../soql/execute.js';
import { matchesFilters, type CriteriaFilter } from '../automation/criteria.js';
import { mergeFields } from '../automation/merge.js';
import { generateId, KEY_PREFIXES } from '../util/ids.js';
import { Errors } from '../util/errors.js';
import { runFormula, toFValue, truthy, FNULL } from '../formula/engine.js';
import { FlowScope, resolveExpression, resolveFields } from './scope.js';
import type { DecisionOutcome, FlowDefinition, FlowNode, FlowRunResult } from './types.js';

/** A flow that visits more nodes than this is looping; better to fail than to spin. */
const MAX_ELEMENTS = 2000;

export interface FlowRunOptions {
  /** The record that triggered the flow, exposed as $Record. */
  record?: Record<string, any>;
  /** The record as it was before the save, exposed as $Record__Prior. */
  priorRecord?: Record<string, any> | null;
  inputs?: Record<string, unknown>;
  /** Transaction client, so flow DML joins the triggering save. */
  client?: DbClient;
  /** Before-save flows collect field updates instead of issuing DML. */
  beforeSave?: boolean;
  /** Guards against a subflow cycle. */
  callStack?: string[];
}

interface LoopFrame {
  nodeId: string;
  items: unknown[];
  index: number;
}

/**
 * Interpret a flow.
 *
 * Every element consumed is accounted against the request's governor budget, so a runaway flow is
 * bounded by the same limits as everything else rather than by its own private rules.
 */
export async function runFlow(
  ctx: RequestContext,
  flow: FlowDefinition,
  opts: FlowRunOptions = {}
): Promise<FlowRunResult> {
  const scope = new FlowScope(flow.variables, opts.inputs);
  if (opts.record) scope.set('$Record', { ...opts.record });
  if (opts.priorRecord) scope.set('$Record__Prior', { ...opts.priorRecord });
  scope.set('$User', { Id: ctx.userId });

  const path: string[] = [];
  const loops: LoopFrame[] = [];
  const callStack = opts.callStack ?? [];

  let current = flow.startNode;
  let elements = 0;

  while (current) {
    const node = flow.nodes[current] as FlowNode | undefined;
    if (!node) throw Errors.invalidOperation(`Flow ${flow.apiName} refers to a node that does not exist: ${current}`);

    if (++elements > MAX_ELEMENTS) {
      throw Errors.limitExceeded(`flow elements in ${flow.apiName} (max ${MAX_ELEMENTS})`);
    }
    ctx.limits.checkCpu();
    path.push(current);

    current = (await executeNode(ctx, flow, current, node, scope, loops, opts, callStack)) ?? null;
  }

  const result: FlowRunResult = { variables: scope.snapshot(), path, recordUpdates: {} };

  // A before-save flow reports what it changed rather than writing it; the pipeline merges it.
  if (opts.beforeSave && opts.record) {
    const after = scope.get('$Record') as Record<string, unknown> | null;
    if (after) {
      for (const [key, value] of Object.entries(after)) {
        if (key === 'Id' || key === 'attributes') continue;
        if (JSON.stringify(value) !== JSON.stringify(opts.record[key] ?? null)) result.recordUpdates[key] = value;
      }
    }
  }
  return result;
}

async function executeNode(
  ctx: RequestContext,
  flow: FlowDefinition,
  nodeId: string,
  node: FlowNode,
  scope: FlowScope,
  loops: LoopFrame[],
  opts: FlowRunOptions,
  callStack: string[]
): Promise<string | null | undefined> {
  switch (node.type) {
    case 'assignment': {
      for (const item of node.assignments ?? []) {
        const value = resolveExpression(item.value, scope);
        const existing = scope.get(item.target);
        switch (item.operator ?? 'assign') {
          case 'add':
            scope.set(item.target, Number(existing ?? 0) + Number(value ?? 0));
            break;
          case 'subtract':
            scope.set(item.target, Number(existing ?? 0) - Number(value ?? 0));
            break;
          case 'addItem':
            scope.set(item.target, [...(Array.isArray(existing) ? existing : []), value]);
            break;
          default:
            scope.set(item.target, value);
        }
      }
      return node.next;
    }

    case 'decision': {
      for (const outcome of node.outcomes ?? []) {
        if (evaluateOutcome(outcome, scope)) return outcome.next;
      }
      return node.defaultNext;
    }

    case 'loop': {
      const frame = loops.find((f) => f.nodeId === nodeId);
      if (!frame) {
        const raw = scope.get(node.collection);
        const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        loops.push({ nodeId, items, index: 0 });
        if (!items.length) {
          loops.pop();
          return node.afterLast;
        }
        scope.set(node.loopVariable, items[0]);
        return node.firstNext;
      }
      frame.index++;
      if (frame.index >= frame.items.length) {
        loops.splice(loops.indexOf(frame), 1);
        return node.afterLast;
      }
      scope.set(node.loopVariable, frame.items[frame.index]);
      return node.firstNext;
    }

    case 'getRecords': {
      const org = await ctx.orgMeta();
      const obj = getObject(org, node.object);
      if (!obj) throw Errors.invalidType(node.object);

      const fields = obj.fieldList
        .filter((f) => f.type !== 'Formula' && f.type !== 'Geolocation')
        .map((f) => f.apiName);
      let soql = `SELECT ${[...new Set(['Id', ...fields])].join(', ')} FROM ${obj.apiName}`;
      const where = buildWhere(node.filters ?? [], scope);
      if (where) soql += ` WHERE ${where}`;
      if (node.orderBy) soql += ` ORDER BY ${node.orderBy}`;
      soql += ` LIMIT ${Math.min(node.limit ?? (node.first ? 1 : 200), 200)}`;

      const result = await runQuery(ctx, soql, { client: opts.client });
      scope.set(node.storeIn, node.first ? (result.records[0] ?? null) : result.records);
      return node.next;
    }

    case 'createRecords': {
      const payload = node.from
        ? (scope.get(node.from) as Record<string, unknown>)
        : resolveFields(node.fields ?? {}, scope);
      const records = Array.isArray(payload) ? payload : [payload];
      const saved = await insertRecords(ctx, node.object, records as Record<string, any>[], { client: opts.client });
      const failure = saved.find((s) => !s.success);
      if (failure) throw Errors.validation(failure.errors[0]?.message ?? 'flow create failed');
      if (node.storeIdIn) scope.set(node.storeIdIn, saved.length === 1 ? saved[0].id : saved.map((s) => s.id));
      return node.next;
    }

    case 'updateRecords': {
      const fields = resolveFields(node.fields ?? {}, scope);
      let records: Record<string, any>[];
      if (node.from) {
        const source = scope.get(node.from);
        const list = Array.isArray(source) ? source : source == null ? [] : [source];
        records = list.map((r: any) => ({ ...fields, Id: r?.Id ?? r }));
      } else {
        const id = resolveExpression(node.recordId, scope);
        if (!id) return node.next;
        records = [{ ...fields, Id: id }];
      }
      if (!records.length) return node.next;
      const saved = await updateRecords(ctx, node.object, records, { client: opts.client });
      const failure = saved.find((s) => !s.success);
      if (failure) throw Errors.validation(failure.errors[0]?.message ?? 'flow update failed');
      return node.next;
    }

    case 'deleteRecords': {
      let ids: string[];
      if (node.from) {
        const source = scope.get(node.from);
        const list = Array.isArray(source) ? source : source == null ? [] : [source];
        ids = list.map((r: any) => String(r?.Id ?? r)).filter(Boolean);
      } else {
        const id = resolveExpression(node.recordId, scope);
        ids = id ? [String(id)] : [];
      }
      if (ids.length) await deleteRecords(ctx, node.object, ids, { client: opts.client });
      return node.next;
    }

    case 'email': {
      await queueFlowEmail(ctx, flow, node, scope, opts);
      return node.next;
    }

    case 'postToFeed': {
      const parentId = resolveExpression(node.parentId, scope);
      const body = resolveExpression(node.body, scope);
      if (parentId) {
        await withClient(ctx, opts, (c) =>
          c.query(
            `INSERT INTO feed_item (id, parent_id, type, body, created_by) VALUES ($1,$2,'SystemPost',$3,$4)`,
            [generateId(KEY_PREFIXES.FeedItem), String(parentId), String(body ?? ''), ctx.userId]
          )
        );
      }
      return node.next;
    }

    case 'submitForApproval': {
      // Approval processes land in their own task; the request is recorded so the flow is usable now.
      const recordId = resolveExpression(node.recordId, scope);
      if (recordId) {
        await withClient(ctx, opts, (c) =>
          c.query(
            `INSERT INTO time_trigger_queue (id, kind, source_id, object_api, record_id, fire_at, payload, status)
             VALUES ($1,'submitForApproval',$2,$3,$4, now(), $5, 'Pending')`,
            [
              generateId(KEY_PREFIXES.CronJob),
              flow.id,
              flow.trigger?.objectApi ?? '',
              String(recordId),
              JSON.stringify({ processApiName: node.processApiName ?? null, submittedBy: ctx.userId })
            ]
          )
        );
      }
      return node.next;
    }

    case 'subflow': {
      if (callStack.includes(node.flow)) {
        throw Errors.invalidOperation(`Flow ${node.flow} calls itself: ${[...callStack, node.flow].join(' → ')}`);
      }
      const child = await loadFlow(ctx, node.flow, opts.client);
      if (!child) throw Errors.notFound(`No active flow named ${node.flow}`);
      const inputs = resolveFields(node.inputs ?? {}, scope);
      const result = await runFlow(ctx, child, {
        ...opts,
        inputs,
        callStack: [...callStack, flow.apiName]
      });
      for (const [outer, inner] of Object.entries(node.outputs ?? {})) {
        scope.set(outer, result.variables[inner] ?? null);
      }
      return node.next;
    }

    case 'screen':
      // Screen flows need a UI to pause against; interpreted headlessly they simply continue.
      return node.next;

    default:
      throw Errors.invalidOperation(`Unsupported flow element: ${(node as { type: string }).type}`);
  }
}

function evaluateOutcome(outcome: DecisionOutcome, scope: FlowScope): boolean {
  if (outcome.formula) {
    return truthy(
      runFormula(outcome.formula, {
        get: (path) => {
          const value = scope.get(path.startsWith('$') ? path : `$Record.${path}`);
          return value == null ? FNULL : toFValue(value);
        }
      })
    );
  }
  const conditions = outcome.conditions ?? [];
  if (!conditions.length) return true;

  const record = flattenForFilters(scope, conditions);
  if (outcome.logic === 'or') {
    return conditions.some((condition) => matchesFilters(record, [condition]));
  }
  return matchesFilters(record, conditions);
}

/** Materialise the values a filter set names, so criteria can address any scope path. */
function flattenForFilters(scope: FlowScope, conditions: CriteriaFilter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const condition of conditions) {
    const explicit = scope.get(condition.field);
    out[condition.field] = explicit !== null ? explicit : scope.get(`$Record.${condition.field}`);
  }
  return out;
}

/** SOQL WHERE fragment for a getRecords filter set, with values bound as literals. */
function buildWhere(filters: CriteriaFilter[], scope: FlowScope): string {
  const parts: string[] = [];
  for (const filter of filters) {
    const raw = resolveExpression(filter.value, scope);
    const literal = (v: unknown) =>
      v === null || v === undefined
        ? 'NULL'
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : `'${String(v).replace(/'/g, "\\'")}'`;
    switch (filter.op) {
      case 'equals':
      case 'eq':
        parts.push(raw == null ? `${filter.field} = NULL` : `${filter.field} = ${literal(raw)}`);
        break;
      case 'notEquals':
      case 'ne':
        parts.push(`${filter.field} != ${literal(raw)}`);
        break;
      case 'lessThan':
        parts.push(`${filter.field} < ${literal(raw)}`);
        break;
      case 'greaterThan':
        parts.push(`${filter.field} > ${literal(raw)}`);
        break;
      case 'lessOrEqual':
        parts.push(`${filter.field} <= ${literal(raw)}`);
        break;
      case 'greaterOrEqual':
        parts.push(`${filter.field} >= ${literal(raw)}`);
        break;
      case 'contains':
        parts.push(`${filter.field} LIKE '%${String(raw).replace(/'/g, "\\'")}%'`);
        break;
      case 'startsWith':
        parts.push(`${filter.field} LIKE '${String(raw).replace(/'/g, "\\'")}%'`);
        break;
      case 'isNull':
        parts.push(raw === false ? `${filter.field} != NULL` : `${filter.field} = NULL`);
        break;
      default:
        break;
    }
  }
  return parts.join(' AND ');
}

async function queueFlowEmail(
  ctx: RequestContext,
  flow: FlowDefinition,
  node: Extract<FlowNode, { type: 'email' }>,
  scope: FlowScope,
  opts: FlowRunOptions
): Promise<void> {
  const recipients = resolveExpression(node.recipients, scope);
  const to = (Array.isArray(recipients) ? recipients : [recipients]).map(String).filter((v) => v && v !== 'null');
  if (!to.length) return;

  let subject = resolveExpression(node.subject ?? '', scope);
  let body = resolveExpression(node.body ?? '', scope);
  let templateId: string | null = null;

  if (node.template) {
    const rows = await withClient(ctx, opts, (c) =>
      c.query<{ id: string; subject: string; body_text: string }>(
        `SELECT id, subject, body_text FROM email_template WHERE api_name = $1`,
        [node.template!]
      )
    );
    if (!rows.rows.length) throw Errors.invalidOperation(`Flow refers to a template that does not exist: ${node.template}`);
    const record = (scope.get('$Record') as Record<string, any>) ?? {};
    const org = await ctx.orgMeta();
    const obj = flow.trigger?.objectApi ? getObject(org, flow.trigger.objectApi) : undefined;
    templateId = rows.rows[0].id;
    subject = obj ? mergeFields(rows.rows[0].subject ?? '', { object: obj, record }) : rows.rows[0].subject;
    body = obj ? mergeFields(rows.rows[0].body_text ?? '', { object: obj, record }) : rows.rows[0].body_text;
  }

  const relatedTo = resolveExpression(node.relatedTo ?? '', scope);
  await withClient(ctx, opts, (c) =>
    c.query(
      `INSERT INTO email_outbound (id, to_addrs, subject, body_text, related_id, template_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Queued')`,
      [
        generateId(KEY_PREFIXES.EmailTemplate),
        JSON.stringify(to),
        String(subject ?? ''),
        String(body ?? ''),
        relatedTo ? String(relatedTo) : null,
        templateId
      ]
    )
  );
}

function withClient<T>(ctx: RequestContext, opts: FlowRunOptions, fn: (c: DbClient) => Promise<T>): Promise<T> {
  return opts.client ? fn(opts.client) : ctx.tenant(fn);
}

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toDefinition(row: any): FlowDefinition {
  return {
    id: row.id,
    apiName: row.api_name,
    label: row.label,
    version: row.version,
    status: row.status,
    processType: row.process_type,
    trigger: parseJson(row.trigger, null),
    startNode: row.start_node,
    nodes: parseJson(row.nodes, {}),
    variables: parseJson(row.variables, [])
  };
}

/** Load the active version of a flow by API name. */
export async function loadFlow(
  ctx: RequestContext,
  apiName: string,
  client?: DbClient
): Promise<FlowDefinition | null> {
  const rows = await (client
    ? client.query(`SELECT * FROM flow_def WHERE api_name = $1 AND status = 'Active' ORDER BY version DESC LIMIT 1`, [apiName])
    : ctx.tenant((c) =>
        c.query(`SELECT * FROM flow_def WHERE api_name = $1 AND status = 'Active' ORDER BY version DESC LIMIT 1`, [apiName])
      ));
  return rows.rows.length ? toDefinition(rows.rows[0]) : null;
}

/** Active record-triggered flows for an object, in a stable order. */
export async function loadRecordTriggeredFlows(
  client: DbClient,
  objectApi: string
): Promise<FlowDefinition[]> {
  const rows = await client.query(
    `SELECT * FROM flow_def
      WHERE status = 'Active' AND process_type = 'RecordTriggered' AND trigger->>'objectApi' = $1
      ORDER BY api_name, version DESC`,
    [objectApi]
  );
  // One active version per API name; the highest wins.
  const seen = new Set<string>();
  const flows: FlowDefinition[] = [];
  for (const row of rows.rows) {
    if (seen.has(row.api_name)) continue;
    seen.add(row.api_name);
    flows.push(toDefinition(row));
  }
  return flows;
}

export { tableFor };
