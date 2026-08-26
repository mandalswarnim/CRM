import { config } from '../config.js';
import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { FieldMeta, ObjectMeta, OrgMeta } from '../metadata/types.js';
import { getField } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { Errors } from '../util/errors.js';
import { FormulaError, runFormula, toFValue, fromFValue } from '../formula/engine.js';
import type { SoqlQuery } from './ast.js';
import { compileQuery, parentRelationshipName, type CompiledQuery, type OutputColumn } from './compiler.js';
import { parseSoql } from './parser.js';
import { getSecurityPolicy, type SecurityPolicy } from './security.js';

export interface QueryOptions {
  /** queryAll: include records in the recycle bin. */
  includeDeleted?: boolean;
  batchSize?: number;
  policy?: SecurityPolicy;
  apiVersion?: string;
  /** Reuse an open transaction's client (used by FOR UPDATE inside a save). */
  client?: DbClient;
}

export interface QueryResultBody {
  totalSize: number;
  done: boolean;
  records: Record<string, any>[];
  nextRecordsUrl?: string;
}

const DEFAULT_BATCH = 2000;

/* ------------------------------ value shaping ----------------------------- */

function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function toIsoDateTime(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const parsed = Date.parse(String(v));
  return Number.isNaN(parsed) ? String(v) : new Date(parsed).toISOString();
}

/** Coerce a raw database value into the JSON shape the API contract promises for that field type. */
function shapeValue(field: FieldMeta | undefined, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (!field) return raw;
  switch (field.type) {
    case 'Number':
    case 'Currency':
    case 'Percent':
      return typeof raw === 'number' ? raw : Number(raw);
    case 'Checkbox':
      return raw === true || raw === 'true' || raw === 't';
    case 'Date':
      return toIsoDate(raw);
    case 'DateTime':
      return toIsoDateTime(raw);
    case 'RollupSummary': {
      // Counts and sums are numbers on the wire; MIN/MAX may carry the source field's type.
      const spec = field.rollup;
      if (!spec || spec.operation === 'COUNT' || spec.operation === 'SUM') return Number(raw);
      if (field.formulaReturnType === 'Date') return toIsoDate(raw);
      if (field.formulaReturnType === 'DateTime') return toIsoDateTime(raw);
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'MultiselectPicklist':
      return String(raw);
    case 'Geolocation':
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    default:
      return typeof raw === 'object' ? raw : String(raw);
  }
}

function attributesFor(obj: ObjectMeta, id: string | null, apiVersion: string) {
  return {
    type: obj.apiName,
    url: id ? `/services/data/v${apiVersion}/sobjects/${obj.apiName}/${id}` : null
  };
}

/**
 * Evaluate formula fields after the row is assembled.
 *
 * Formulas read from the record that was just shaped, so a formula referencing a parent field
 * works whenever that parent field was also selected — matching the Salesforce requirement that
 * you query what the formula needs.
 */
function evaluateFormulas(record: Record<string, any>, obj: ObjectMeta, columns: OutputColumn[]): void {
  for (const col of columns) {
    if (!col.field?.formula || col.relationshipPath.length) continue;
    try {
      const value = runFormula(col.field.formula, {
        get: (path) => {
          const direct = record[path];
          if (direct !== undefined) return toFValue(direct, getField(obj, path)?.type);
          // Dotted path: walk the nested parent records already shaped onto the row.
          const segments = path.split('.');
          let cursor: any = record;
          for (const segment of segments) {
            if (cursor == null || typeof cursor !== 'object') return toFValue(null);
            cursor = cursor[segment];
          }
          return toFValue(cursor ?? null);
        },
        isNew: false
      });
      record[col.field.apiName] = fromFValue(value);
    } catch (e) {
      if (e instanceof FormulaError) record[col.field.apiName] = null;
      else throw e;
    }
  }
}

/** Build one API record from a database row, nesting parent relationships as they were selected. */
function shapeRecord(
  row: Record<string, any>,
  compiled: CompiledQuery,
  org: OrgMeta,
  apiVersion: string
): Record<string, any> {
  if (compiled.isAggregate) {
    const record: Record<string, any> = { attributes: { type: 'AggregateResult' } };
    compiled.columns.forEach((col, i) => {
      const raw = row[`c${i}`];
      record[col.key] =
        col.item.kind === 'aggregate' && (col.item.fn === 'COUNT' || col.item.fn === 'COUNT_DISTINCT')
          ? Number(raw ?? 0)
          : shapeValue(col.field, raw);
    });
    return record;
  }

  const id = compiled.idColumn >= 0 ? (row[`c${compiled.idColumn}`] as string) : null;
  const record: Record<string, any> = { attributes: attributesFor(compiled.root, id, apiVersion) };

  compiled.columns.forEach((col, i) => {
    const raw = row[`c${i}`];
    const value = shapeValue(col.field, raw);

    if (!col.relationshipPath.length) {
      record[col.field?.apiName ?? col.key] = value;
      return;
    }

    let cursor = record;
    let cursorObj = compiled.root;
    for (const segment of col.relationshipPath) {
      const link = cursorObj.fieldList.find(
        (f) =>
          (f.type === 'Lookup' || f.type === 'MasterDetail') &&
          parentRelationshipName(f).toLowerCase() === segment.toLowerCase()
      );
      const targetName = link?.referenceTo?.split(',')[0]?.trim();
      const target = targetName ? org.objects.get(targetName.toLowerCase()) : undefined;

      if (cursor[segment] == null) {
        cursor[segment] = { attributes: target ? attributesFor(target, null, apiVersion) : { type: segment } };
      }
      cursor = cursor[segment];
      if (target) cursorObj = target;
    }
    cursor[col.field?.apiName ?? col.key] = value;
  });

  // A parent that resolved to nothing is null, not an object of nulls.
  for (const col of compiled.columns) {
    if (!col.relationshipPath.length) continue;
    const top = col.relationshipPath[0];
    const nested = record[top];
    if (nested && typeof nested === 'object') {
      const values = Object.entries(nested).filter(([k]) => k !== 'attributes');
      if (values.length && values.every(([, v]) => v == null)) record[top] = null;
    }
  }

  evaluateFormulas(record, compiled.root, compiled.columns);
  return record;
}

/* -------------------------------- execution ------------------------------- */

async function runCompiled(
  ctx: RequestContext,
  c: DbClient,
  compiled: CompiledQuery,
  org: OrgMeta,
  apiVersion: string
): Promise<Record<string, any>[]> {
  ctx.limits.consume('soqlQueries');
  const res = await c.query(compiled.sql, compiled.params);
  ctx.limits.consume('queryRows', res.rows.length);
  return res.rows.map((row) => shapeRecord(row, compiled, org, apiVersion));
}

/**
 * Run child subqueries batched against the parent ids.
 *
 * One extra statement per relationship rather than per parent row: the alternative, a correlated
 * lateral join, makes the generated SQL far harder to reason about for no practical gain here.
 */
async function attachSubqueries(
  ctx: RequestContext,
  c: DbClient,
  compiled: CompiledQuery,
  org: OrgMeta,
  records: Record<string, any>[],
  opts: QueryOptions
): Promise<void> {
  if (!compiled.subqueries.length || !records.length) return;
  const parentIds = records.map((r) => r.Id).filter(Boolean);
  if (!parentIds.length) return;

  for (const sub of compiled.subqueries) {
    // The child rows have to carry the foreign key so they can be grouped back onto their parent;
    // it is stripped again afterwards when the caller did not ask for it.
    const requestedFk = sub.query.select.some(
      (s) => s.kind === 'field' && s.path.length === 1 && s.path[0].toLowerCase() === sub.relationship.field.toLowerCase()
    );
    const scoped: SoqlQuery = {
      ...sub.query,
      select: requestedFk
        ? sub.query.select
        : [...sub.query.select, { kind: 'field', path: [sub.relationship.field] }],
      from: sub.child.apiName,
      where: {
        kind: 'and',
        items: [
          { kind: 'in', path: [sub.relationship.field], not: false, values: parentIds.map((v) => ({ t: 'string', v })) },
          ...(sub.query.where ? [sub.query.where] : [])
        ]
      },
      includeDeleted: opts.includeDeleted
    };

    const childCompiled = compileQuery(ctx, org, scoped, { policy: opts.policy });
    const childRecords = await runCompiled(ctx, c, childCompiled, org, opts.apiVersion ?? config.defaultApiVersion);

    const byParent = new Map<string, Record<string, any>[]>();
    const relField = sub.relationship.field;
    for (const child of childRecords) {
      const parentId = child[relField];
      if (!parentId) continue;
      const list = byParent.get(parentId) ?? [];
      list.push(child);
      byParent.set(parentId, list);
    }

    if (!requestedFk) {
      for (const child of childRecords) delete child[relField];
    }

    for (const parent of records) {
      const children = byParent.get(parent.Id) ?? [];
      // Salesforce returns null, not an empty envelope, when a child set is empty.
      parent[sub.key] = children.length
        ? { totalSize: children.length, done: true, records: children }
        : null;
    }
  }
}

function encodeLocator(payload: { q: string; offset: number; batch: number; all: boolean }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeLocator(locator: string): { q: string; offset: number; batch: number; all: boolean } {
  try {
    const parsed = JSON.parse(Buffer.from(locator, 'base64url').toString('utf8'));
    if (typeof parsed.q !== 'string' || typeof parsed.offset !== 'number') throw new Error('bad locator');
    return parsed;
  } catch {
    throw Errors.invalidOperation(`invalid query locator: ${locator}`);
  }
}

async function countMatching(ctx: RequestContext, c: DbClient, org: OrgMeta, query: SoqlQuery, opts: QueryOptions): Promise<number> {
  const counted = compileQuery(
    ctx,
    org,
    { ...query, select: [{ kind: 'aggregate', fn: 'COUNT', path: null }], orderBy: undefined, limit: undefined, offset: undefined },
    { policy: opts.policy }
  );
  ctx.limits.consume('soqlQueries');
  const res = await c.query(counted.sql, counted.params);
  return Number(res.rows[0]?.c0 ?? 0);
}

/** Parse, compile and run a SOQL string, returning the Salesforce query response shape. */
export async function runQuery(ctx: RequestContext, soql: string, opts: QueryOptions = {}): Promise<QueryResultBody> {
  const query = parseSoql(soql);
  return executeQuery(ctx, query, soql, 0, opts);
}

/**
 * Run an already-built AST.
 *
 * SOSL needs this: it resolves matching record ids from the search index, then re-queries each
 * object through the ordinary compiler so sharing rewrites and FLS apply to search results exactly
 * as they do to a SOQL query. `source` is only used for the queryMore locator.
 */
export async function runQueryAst(
  ctx: RequestContext,
  query: SoqlQuery,
  source: string,
  opts: QueryOptions = {}
): Promise<QueryResultBody> {
  return executeQuery(ctx, query, source, 0, opts);
}

export async function runQueryMore(ctx: RequestContext, locator: string, opts: QueryOptions = {}): Promise<QueryResultBody> {
  const state = decodeLocator(locator);
  const query = parseSoql(state.q);
  return executeQuery(ctx, query, state.q, state.offset, {
    ...opts,
    batchSize: state.batch,
    includeDeleted: state.all
  });
}

async function executeQuery(
  ctx: RequestContext,
  query: SoqlQuery,
  source: string,
  offset: number,
  opts: QueryOptions
): Promise<QueryResultBody> {
  const policy = opts.policy ?? getSecurityPolicy();
  await policy.prepare?.(ctx);
  const org = await ctx.orgMeta();
  const apiVersion = opts.apiVersion ?? config.defaultApiVersion;
  const batch = Math.min(opts.batchSize ?? DEFAULT_BATCH, 2000);
  const includeDeleted = opts.includeDeleted ?? query.includeDeleted ?? false;

  // The caller's own LIMIT caps the result set; paging happens within it.
  const userLimit = query.limit;
  const remaining = userLimit != null ? Math.max(0, userLimit - offset) : null;
  const pageSize = remaining != null ? Math.min(batch, remaining) : batch;

  const paged: SoqlQuery = {
    ...query,
    includeDeleted,
    limit: pageSize + 1, // one extra row tells us whether more exist
    offset: (query.offset ?? 0) + offset
  };

  const compiled = compileQuery(ctx, org, paged, { policy });

  const run = async (c: DbClient): Promise<QueryResultBody> => {
    const rows = await runCompiled(ctx, c, compiled, org, apiVersion);
    const hasMore = rows.length > pageSize;
    const records = hasMore ? rows.slice(0, pageSize) : rows;

    await attachSubqueries(ctx, c, compiled, org, records, { ...opts, includeDeleted, apiVersion });

    let totalSize = offset + records.length;
    if (hasMore) {
      totalSize =
        userLimit != null
          ? userLimit
          : await countMatching(ctx, c, org, { ...query, includeDeleted }, opts);
    }

    const body: QueryResultBody = { totalSize, done: !hasMore, records };
    if (hasMore) {
      const next = encodeLocator({ q: source, offset: offset + records.length, batch, all: includeDeleted });
      body.nextRecordsUrl = `/services/data/v${apiVersion}/query/${next}`;
    }
    return body;
  };

  return opts.client ? run(opts.client) : ctx.tenant(run);
}

/** Count matching records without materialising them — used by list views and reports. */
export async function runCount(ctx: RequestContext, soql: string, opts: QueryOptions = {}): Promise<number> {
  await (opts.policy ?? getSecurityPolicy()).prepare?.(ctx);
  const org = await ctx.orgMeta();
  const query = parseSoql(soql);
  return ctx.tenant((c) => countMatching(ctx, c, org, { ...query, includeDeleted: opts.includeDeleted ?? false }, opts));
}

/** Convenience for engine code: run a query and return plain records. */
export async function queryRecords(
  ctx: RequestContext,
  soql: string,
  opts: QueryOptions = {}
): Promise<Record<string, any>[]> {
  const result = await runQuery(ctx, soql, opts);
  return result.records;
}

export { tableFor };
