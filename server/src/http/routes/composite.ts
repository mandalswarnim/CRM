import { Router } from 'express';
import type { Db, DbClient } from '../../db/index.js';
import { inTransaction } from '../../db/index.js';
import { getObject } from '../../metadata/types.js';
import {
  deleteRecords,
  getRecord,
  insertRecords,
  updateRecords,
  type SaveResult
} from '../../dml/index.js';
import { runQuery } from '../../soql/index.js';
import type { RequestContext } from '../../runtime/context.js';
import { SfError, Errors } from '../../util/errors.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';

interface SubRequest {
  method: string;
  url: string;
  referenceId?: string;
  body?: Record<string, any>;
}

interface SubResponse {
  body: unknown;
  httpHeaders: Record<string, string>;
  httpStatusCode: number;
  referenceId?: string;
}

/** Split `/services/data/v61.0/sobjects/Account/001…?fields=Name` into its parts. */
function parseUrl(url: string): { segments: string[]; query: URLSearchParams } {
  const [path, search] = url.split('?');
  const segments = path.split('/').filter(Boolean);
  const dataIndex = segments.findIndex((s) => s === 'data');
  const rest = dataIndex >= 0 ? segments.slice(dataIndex + 2) : segments;
  return { segments: rest, query: new URLSearchParams(search ?? '') };
}

/**
 * Substitute @{referenceId.Field} against earlier responses.
 *
 * This is what makes a composite request worth having: create an Account and a Contact pointing at
 * it in one round trip, without the client knowing the generated id.
 */
function resolveReferences(value: unknown, responses: Map<string, SubResponse>): unknown {
  if (typeof value === 'string') {
    return value.replace(/@\{([^}]+)\}/g, (whole, expr: string) => {
      const [refId, ...path] = String(expr).split('.');
      const source = responses.get(refId);
      if (!source) return whole;
      let cursor: any = source.body;
      for (const segment of path) {
        if (cursor == null) return '';
        cursor = cursor[segment];
      }
      return cursor == null ? '' : String(cursor);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, responses));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveReferences(v, responses);
    return out;
  }
  return value;
}

function errorResponse(err: unknown, referenceId?: string): SubResponse {
  const e = err instanceof SfError ? err : new SfError('UNKNOWN_EXCEPTION', String((err as Error)?.message ?? err), 500);
  return { body: e.toBody(), httpHeaders: {}, httpStatusCode: e.status, referenceId };
}

/**
 * Execute one sub-request against the engines directly.
 *
 * Dispatching in-process rather than re-entering Express keeps the caller's transaction, request
 * context and governor budget intact — a composite request is one transaction, not several.
 */
async function dispatch(
  ctx: RequestContext,
  sub: SubRequest,
  client: DbClient | undefined,
  version: string
): Promise<SubResponse> {
  const { segments, query } = parseUrl(sub.url);
  const method = sub.method.toUpperCase();
  const ok = (body: unknown, status = 200): SubResponse => ({ body, httpHeaders: {}, httpStatusCode: status, referenceId: sub.referenceId });

  if (segments[0] === 'query' || segments[0] === 'queryAll') {
    if (method !== 'GET') throw Errors.invalidOperation(`${method} is not supported on ${segments[0]}`);
    const soql = query.get('q');
    if (!soql) throw Errors.malformedQuery("The 'q' parameter is required");
    return ok(await runQuery(ctx, soql, { includeDeleted: segments[0] === 'queryAll', apiVersion: version, client }));
  }

  if (segments[0] !== 'sobjects' || !segments[1]) {
    throw Errors.notFound(`Unsupported composite sub-request: ${sub.method} ${sub.url}`);
  }

  const org = await ctx.orgMeta();
  const obj = getObject(org, segments[1]);
  if (!obj) throw Errors.invalidType(segments[1]);
  const recordId = segments[2];

  switch (method) {
    case 'POST': {
      const [result] = await insertRecords(ctx, obj.apiName, [sub.body ?? {}], { client });
      if (!result.success) throw new SfError(result.errors[0].errorCode, result.errors[0].message, 400, result.errors[0].fields);
      return ok({ id: result.id, success: true, errors: [] }, 201);
    }
    case 'GET': {
      if (!recordId) throw Errors.notFound('a record id is required');
      const record = await getRecord(ctx, obj.apiName, recordId);
      if (!record) throw Errors.notFound(`entity is deleted or does not exist: ${recordId}`);
      return ok(record);
    }
    case 'PATCH': {
      if (!recordId) throw Errors.notFound('a record id is required');
      const [result] = await updateRecords(ctx, obj.apiName, [{ ...(sub.body ?? {}), Id: recordId }], { client });
      if (!result.success) throw new SfError(result.errors[0].errorCode, result.errors[0].message, 400, result.errors[0].fields);
      return ok(null, 204);
    }
    case 'DELETE': {
      if (!recordId) throw Errors.notFound('a record id is required');
      const [result] = await deleteRecords(ctx, obj.apiName, [recordId], { client });
      if (!result.success) throw new SfError(result.errors[0].errorCode, result.errors[0].message, 404, result.errors[0].fields);
      return ok(null, 204);
    }
    default:
      throw Errors.invalidOperation(`${method} is not supported`);
  }
}

/** Insert a tree of records depth-first, wiring children to the parent id as it goes. */
async function insertTree(
  ctx: RequestContext,
  client: DbClient,
  objectApi: string,
  records: any[],
  results: Array<{ referenceId: string; id: string }>
): Promise<void> {
  const org = await ctx.orgMeta();
  const parent = getObject(org, objectApi);
  if (!parent) throw Errors.invalidType(objectApi);

  for (const record of records) {
    const referenceId = record?.attributes?.referenceId;
    const children: Array<{ relationship: string; records: any[] }> = [];
    const fields: Record<string, any> = {};

    for (const [key, value] of Object.entries(record ?? {})) {
      if (key === 'attributes') continue;
      if (value && typeof value === 'object' && Array.isArray((value as any).records)) {
        children.push({ relationship: key, records: (value as any).records });
      } else {
        fields[key] = value;
      }
    }

    const [saved] = await insertRecords(ctx, parent.apiName, [fields], { client });
    if (!saved.success) {
      throw new SfError(saved.errors[0].errorCode, saved.errors[0].message, 400, saved.errors[0].fields);
    }
    results.push({ referenceId, id: saved.id });

    for (const child of children) {
      const rel = parent.childRelationships.find(
        (r) => (r.relationshipName ?? r.childObject).toLowerCase() === child.relationship.toLowerCase()
      );
      if (!rel) throw Errors.invalidField(child.relationship, parent.apiName);
      const linked = child.records.map((c: any) => ({ ...c, [rel.field]: saved.id }));
      await insertTree(ctx, client, rel.childObject, linked, results);
    }
  }
}

export function compositeRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  // Whole-request atomicity: every sub-request runs on one client inside one transaction.
  r.post(
    '/composite',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const version = String(req.params.version);
      const allOrNone = req.body?.allOrNone !== false;
      const requests: SubRequest[] = req.body?.compositeRequest ?? [];
      if (!Array.isArray(requests) || !requests.length) {
        throw Errors.invalidBatch('compositeRequest must be a non-empty array');
      }

      const responses = new Map<string, SubResponse>();
      const ordered: SubResponse[] = [];

      try {
        await ctx.tenant((c) =>
          inTransaction(c, async () => {
            for (const raw of requests) {
              const sub = resolveReferences(raw, responses) as SubRequest;
              try {
                const response = await dispatch(ctx, sub, c, version);
                ordered.push(response);
                if (sub.referenceId) responses.set(sub.referenceId, response);
              } catch (err) {
                const failure = errorResponse(err, sub.referenceId);
                ordered.push(failure);
                if (allOrNone) throw err;
              }
            }
          })
        );
      } catch (err) {
        if (!allOrNone) throw err;
        // Everything rolled back; report the failure alongside the sub-requests that were rolled back.
        const rolledBack = ordered.map((response, i) =>
          response.httpStatusCode < 400
            ? {
                ...response,
                body: [
                  {
                    message: 'The transaction was rolled back since another operation in the same transaction failed.',
                    errorCode: 'PROCESSING_HALTED',
                    fields: []
                  }
                ],
                httpStatusCode: 400,
                referenceId: requests[i]?.referenceId
              }
            : response
        );
        res.status(200).json({ compositeResponse: rolledBack });
        return;
      }

      res.json({ compositeResponse: ordered });
    })
  );

  // Batch is explicitly not atomic: each request stands alone.
  r.post(
    '/composite/batch',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const version = String(req.params.version);
      const requests: Array<{ method: string; url: string; richInput?: Record<string, any> }> = req.body?.batchRequests ?? [];
      if (!Array.isArray(requests) || !requests.length) {
        throw Errors.invalidBatch('batchRequests must be a non-empty array');
      }

      const results = [];
      let hasErrors = false;
      for (const request of requests) {
        try {
          const response = await dispatch(ctx, { method: request.method, url: request.url, body: request.richInput }, undefined, version);
          results.push({ statusCode: response.httpStatusCode, result: response.body });
        } catch (err) {
          hasErrors = true;
          const failure = errorResponse(err);
          results.push({ statusCode: failure.httpStatusCode, result: failure.body });
        }
      }
      res.json({ hasErrors, results });
    })
  );

  // Collection endpoints: up to 200 records of mixed types in one call.
  r.post(
    '/composite/sobjects',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const results = await saveCollection(ctx, req.body, 'insert');
      res.json(results);
    })
  );

  r.patch(
    '/composite/sobjects',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const results = await saveCollection(ctx, req.body, 'update');
      res.json(results);
    })
  );

  r.delete(
    '/composite/sobjects',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const ids = String(req.query.ids ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (!ids.length) throw Errors.invalidBatch('the ids parameter is required');
      const allOrNone = req.query.allOrNone === 'true';

      const org = await ctx.orgMeta();
      const results: SaveResult[] = [];
      for (const id of ids) {
        const obj = org.byPrefix.get(id.slice(0, 3));
        if (!obj) {
          results.push({ id, success: false, created: false, errors: Errors.malformedId('Id', id).toBody() });
          continue;
        }
        const [result] = await deleteRecords(ctx, obj.apiName, [id], { allOrNone });
        results.push(result);
      }
      res.json(results);
    })
  );

  r.post(
    '/composite/tree/:object',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const records = req.body?.records;
      if (!Array.isArray(records) || !records.length) throw Errors.invalidBatch('records must be a non-empty array');

      const results: Array<{ referenceId: string; id: string }> = [];
      try {
        await ctx.tenant((c) => inTransaction(c, () => insertTree(ctx, c, String(req.params.object), records, results)));
      } catch (err) {
        const e = err instanceof SfError ? err : new SfError('UNKNOWN_EXCEPTION', String(err), 500);
        res.status(400).json({
          hasErrors: true,
          results: [{ referenceId: null, errors: e.toBody() }]
        });
        return;
      }
      res.status(201).json({ hasErrors: false, results });
    })
  );

  return r;
}

/** Shared implementation of POST and PATCH /composite/sobjects, grouped by sObject type. */
async function saveCollection(
  ctx: RequestContext,
  body: any,
  operation: 'insert' | 'update'
): Promise<SaveResult[]> {
  const records: any[] = body?.records ?? [];
  if (!Array.isArray(records) || !records.length) throw Errors.invalidBatch('records must be a non-empty array');
  if (records.length > 200) throw Errors.invalidBatch('a collection may contain at most 200 records');
  const allOrNone = body?.allOrNone === true;

  // Preserve the caller's ordering in the response even though we save grouped by type.
  const byType = new Map<string, Array<{ index: number; record: Record<string, any> }>>();
  const results: SaveResult[] = new Array(records.length);

  records.forEach((record, index) => {
    const type = record?.attributes?.type;
    if (!type) {
      results[index] = {
        id: '',
        success: false,
        created: false,
        errors: Errors.invalidBatch('each record needs attributes.type').toBody()
      };
      return;
    }
    const { attributes, ...fields } = record;
    byType.set(type, [...(byType.get(type) ?? []), { index, record: fields }]);
  });

  for (const [type, entries] of byType) {
    const payload = entries.map((e) => e.record);
    const saved =
      operation === 'insert'
        ? await insertRecords(ctx, type, payload, { allOrNone })
        : await updateRecords(ctx, type, payload, { allOrNone });
    entries.forEach((entry, i) => {
      results[entry.index] = saved[i];
    });
  }

  return results;
}
