import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { getField, getObject } from '../../metadata/types.js';
import { tableFor } from '../../metadata/registry.js';
import { describeGlobal, describeSObject } from '../../metadata/describe.js';
import {
  deleteRecords,
  getRecord,
  insertRecord,
  updateRecord,
  upsertRecord
} from '../../dml/index.js';
import { ensureUserAccess, describePermsView } from '../../security/index.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';
import type { RequestContext } from '../../runtime/context.js';

async function resolve(ctx: RequestContext, name: string) {
  const org = await ctx.orgMeta();
  const obj = getObject(org, name);
  if (!obj) throw Errors.invalidType(name);
  return { org, obj };
}

/** Trim a record to an explicit ?fields= list, keeping attributes. */
function projectFields(record: Record<string, any>, fields?: string): Record<string, any> {
  if (!fields) return record;
  const wanted = new Set(fields.split(',').map((f) => f.trim().toLowerCase()));
  const out: Record<string, any> = { attributes: record.attributes };
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'attributes' && wanted.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

function attributesFor(objectApi: string, id: string, version: string) {
  return { type: objectApi, url: `/services/data/v${version}/sobjects/${objectApi}/${id}` };
}

/** The `/sobjects` family: global describe, per-object describe, and record CRUD. */
export function sobjectRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const org = await ctx.orgMeta();
      const access = await ensureUserAccess(ctx);
      res.json(describeGlobal(org, describePermsView(access), String(req.params.version)));
    })
  );

  r.get(
    '/:object/describe',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { org, obj } = await resolve(ctx, String(req.params.object));
      const access = await ensureUserAccess(ctx);
      const perms = describePermsView(access);
      if (!perms.canRead(obj.apiName)) throw Errors.invalidType(obj.apiName);
      res.json(describeSObject(org, obj, perms, String(req.params.version)));
    })
  );

  r.post(
    '/:object',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      const id = await insertRecord(ctx, obj.apiName, req.body ?? {});
      res.status(201).json({ id, success: true, errors: [] });
    })
  );

  r.get(
    '/:object/:id',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      const record = await getRecord(ctx, obj.apiName, String(req.params.id));
      if (!record) throw Errors.notFound(`Provided external ID field does not exist or is not accessible`);
      res.json(
        projectFields(
          { attributes: attributesFor(obj.apiName, record.Id, String(req.params.version)), ...record },
          req.query.fields as string | undefined
        )
      );
    })
  );

  r.patch(
    '/:object/:id',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      await updateRecord(ctx, obj.apiName, String(req.params.id), req.body ?? {});
      res.status(204).end();
    })
  );

  r.delete(
    '/:object/:id',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      const [result] = await deleteRecords(ctx, obj.apiName, [String(req.params.id)]);
      if (!result.success) {
        throw Errors.notFound(result.errors[0]?.message ?? 'entity is deleted or does not exist');
      }
      res.status(204).end();
    })
  );

  // Upsert by external id. Ordered after /:object/:id so a two-segment path stays a record read.
  r.patch(
    '/:object/:externalIdField/:externalId',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      const result = await upsertRecord(
        ctx,
        obj.apiName,
        String(req.params.externalIdField),
        String(req.params.externalId),
        req.body ?? {}
      );
      if (!result.success) {
        throw Errors.validation(result.errors[0]?.message ?? 'upsert failed', result.errors[0]?.fields ?? []);
      }
      if (result.created) {
        res.status(201).json({ id: result.id, success: true, errors: [], created: true });
      } else {
        res.status(200).json({ id: result.id, success: true, errors: [], created: false });
      }
    })
  );

  r.get(
    '/:object/:externalIdField/:externalId',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { obj } = await resolve(ctx, String(req.params.object));
      const field = getField(obj, String(req.params.externalIdField));
      if (!field) throw Errors.invalidField(String(req.params.externalIdField), obj.apiName);
      if (!field.externalId && !field.unique) {
        throw Errors.invalidOperation(`${field.apiName} is not an External ID or unique field`);
      }

      // Bound parameter, not interpolation: the external id is caller-supplied.
      const matches = await ctx.tenant((c) =>
        c.query<{ id: string }>(
          `SELECT id FROM ${tableFor(obj.apiName)} WHERE fields->>'${field.apiName}' = $1 AND is_deleted = false`,
          [String(req.params.externalId)]
        )
      );
      if (!matches.rows.length) throw Errors.notFound('Provided external ID field does not exist or is not accessible');
      if (matches.rows.length > 1) throw Errors.invalidOperation('Multiple records matched the external id');

      const record = await getRecord(ctx, obj.apiName, matches.rows[0].id);
      if (!record) throw Errors.notFound('Provided external ID field does not exist or is not accessible');
      res.json({ attributes: attributesFor(obj.apiName, record.Id, String(req.params.version)), ...record });
    })
  );

  return r;
}
