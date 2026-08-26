import type { RequestContext } from '../runtime/context.js';
import type { ObjectMeta } from '../metadata/types.js';
import type { Condition, SoqlQuery } from '../soql/ast.js';
import { runQueryAst, getSecurityPolicy } from '../soql/index.js';
import { Errors } from '../util/errors.js';
import type { SearchExpr, SearchGroup, SoslQuery } from './ast.js';
import { parseSosl } from './parser.js';
import { RANK_WEIGHTS, toTsQuery, weightMask } from './tsquery.js';

/**
 * How many index rows one search may consider.
 *
 * The index knows nothing about sharing, so candidates are resolved from it first and then filtered
 * by re-querying each object through the SOQL compiler. Rows the user cannot see drop out at that
 * second stage, which is why the scan reaches beyond the caller's LIMIT.
 */
const SCAN_CAP = 2000;

/** Salesforce's default when a search states no LIMIT. */
const DEFAULT_LIMIT = 200;

export interface SearchRecord {
  attributes: { type: string; url: string | null };
  [field: string]: any;
}

export interface SearchResultBody {
  searchRecords: SearchRecord[];
}

interface Candidate {
  id: string;
  objectApi: string;
  rank: number;
}

/**
 * Resolve candidate record ids from the index.
 *
 * Object-level readability is applied here so a user cannot learn that a term appears on an object
 * they have no access to at all.
 */
async function findCandidates(
  ctx: RequestContext,
  find: SearchExpr,
  group: SearchGroup,
  objects: ObjectMeta[],
  scanLimit: number
): Promise<Candidate[]> {
  const tsquery = toTsQuery(find);
  const apiNames = objects.map((o) => o.apiName);
  if (!apiNames.length) return [];

  const rows = await ctx.tenant((c) =>
    c.query<{ record_id: string; object_api: string; rank: number }>(
      `SELECT s.record_id, s.object_api,
              ts_rank($1::float4[], s.tsv, q) AS rank
         FROM search_index s, to_tsquery('simple', $2) q
        WHERE s.tsv @@ q
          AND s.object_api = ANY($3)
          AND ts_rank($4::float4[], s.tsv, q) > 0
        ORDER BY rank DESC, s.record_id
        LIMIT $5`,
      [RANK_WEIGHTS, tsquery, apiNames, weightMask(group), scanLimit]
    )
  );

  return rows.rows.map((r) => ({ id: r.record_id, objectApi: r.object_api, rank: Number(r.rank) }));
}

/** AND the caller's own WHERE together with `Id IN (…matched ids…)`. */
function restrictToIds(query: SoqlQuery, ids: string[]): SoqlQuery {
  const idFilter: Condition = {
    kind: 'in',
    path: ['Id'],
    not: false,
    values: ids.map((v) => ({ t: 'string', v }) as const)
  };
  const where: Condition = query.where ? { kind: 'and', items: [query.where, idFilter] } : idFilter;
  return { ...query, where };
}

/** Objects a search may look at when RETURNING is omitted. */
function searchableObjects(org: { objectList: ObjectMeta[] }, ctx: RequestContext): ObjectMeta[] {
  const policy = getSecurityPolicy();
  return org.objectList.filter((o) => o.searchEnabled && policy.canReadObject(ctx, o));
}

/**
 * Run a parsed SOSL search.
 *
 * Two stages by design: the index answers *which records match*, and the SOQL compiler answers
 * *which of those this user may see, and what of them they may read*. Security is never
 * reimplemented here — it is inherited by going back through the ordinary query path.
 */
export async function runSoslQuery(ctx: RequestContext, query: SoslQuery): Promise<SearchResultBody> {
  ctx.limits.consume('soslQueries');
  const org = await ctx.orgMeta();
  const policy = getSecurityPolicy();
  await policy.prepare?.(ctx);

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, SCAN_CAP);

  // Which objects, and with which RETURNING body each.
  const targets = new Map<string, SoqlQuery>();
  if (query.returning.length) {
    for (const clause of query.returning) {
      const obj = org.objects.get(clause.objectApi.toLowerCase());
      if (!obj) throw Errors.invalidType(clause.objectApi);
      if (!policy.canReadObject(ctx, obj)) throw Errors.invalidType(clause.objectApi);
      targets.set(obj.apiName, clause.query);
    }
  } else {
    for (const obj of searchableObjects(org, ctx)) {
      targets.set(obj.apiName, { select: [{ kind: 'field', path: ['Id'] }], from: obj.apiName });
    }
  }

  const objects = [...targets.keys()].map((api) => org.objects.get(api.toLowerCase())!);
  const candidates = await findCandidates(ctx, query.find, query.group, objects, SCAN_CAP);
  if (!candidates.length) return { searchRecords: [] };

  // Rank position per id, so the assembled result keeps index order across objects.
  const rankOf = new Map<string, number>();
  candidates.forEach((c, i) => rankOf.set(c.id, i));

  const byObject = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byObject.get(c.objectApi);
    if (list) list.push(c.id);
    else byObject.set(c.objectApi, [c.id]);
  }

  const found: SearchRecord[] = [];
  for (const [objectApi, ids] of byObject) {
    const body = targets.get(objectApi);
    if (!body) continue;
    const result = await runQueryAst(ctx, restrictToIds(body, ids), `SOSL RETURNING ${objectApi}`);
    for (const record of result.records) found.push(record as SearchRecord);
  }

  found.sort((a, b) => (rankOf.get(a.Id) ?? 0) - (rankOf.get(b.Id) ?? 0));
  return { searchRecords: found.slice(0, limit) };
}

/** Parse and run a SOSL string. */
export async function runSosl(ctx: RequestContext, sosl: string): Promise<SearchResultBody> {
  return runSoslQuery(ctx, parseSosl(sosl));
}

// -------------------------------------------------------------------- typeahead

export interface Suggestion {
  id: string;
  objectApi: string;
  title: string;
  /** Populated from the object's icon metadata so the header search box can render a row. */
  icon: string | null;
}

export interface SuggestOptions {
  /** Restrict to these objects; empty means every searchable object the user can read. */
  objects?: string[];
  limit?: number;
}

/**
 * Typeahead for the header search box.
 *
 * A prefix match on the name field only — the user is part-way through typing a record's name, not
 * running a full-text search. Titles come from the index, but every id is confirmed through the
 * SOQL path first so an unshared record can never surface as a suggestion.
 */
export async function suggest(
  ctx: RequestContext,
  term: string,
  opts: SuggestOptions = {}
): Promise<Suggestion[]> {
  ctx.limits.consume('soslQueries');
  const org = await ctx.orgMeta();
  const policy = getSecurityPolicy();
  await policy.prepare?.(ctx);

  const limit = Math.min(opts.limit ?? 20, 100);
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  // Every word is a prefix — "ori cl" should still reach "Oriental Club".
  const find: SearchExpr = {
    kind: 'and',
    items: words.map((w) => ({ kind: 'term', value: w, wildcard: true }) as SearchExpr)
  };

  let objects = searchableObjects(org, ctx);
  if (opts.objects?.length) {
    const wanted = new Set(opts.objects.map((o) => o.toLowerCase()));
    objects = objects.filter((o) => wanted.has(o.apiName.toLowerCase()));
  }

  const candidates = await findCandidates(ctx, find, 'NAME', objects, SCAN_CAP);
  if (!candidates.length) return [];

  const titles = new Map(candidates.map((c) => [c.id, c]));
  const byObject = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byObject.get(c.objectApi);
    if (list) list.push(c.id);
    else byObject.set(c.objectApi, [c.id]);
  }

  const out: Suggestion[] = [];
  for (const [objectApi, ids] of byObject) {
    const obj = org.objects.get(objectApi.toLowerCase());
    if (!obj) continue;
    const nameField = obj.fields.get('name');
    const select: SoqlQuery = {
      select: nameField
        ? [{ kind: 'field', path: ['Id'] }, { kind: 'field', path: [nameField.apiName] }]
        : [{ kind: 'field', path: ['Id'] }],
      from: obj.apiName
    };
    const result = await runQueryAst(ctx, restrictToIds(select, ids), `suggest ${objectApi}`);
    for (const record of result.records) {
      out.push({
        id: record.Id,
        objectApi: obj.apiName,
        title: nameField ? String(record[nameField.apiName] ?? '') : (titles.get(record.Id)?.id ?? ''),
        icon: obj.icon ?? null
      });
    }
  }

  const rankOf = new Map(candidates.map((c, i) => [c.id, i]));
  out.sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0));
  return out.slice(0, limit);
}
