import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { ObjectMeta } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { Errors } from '../util/errors.js';
import { ensureUserAccess, fieldEditable, fieldReadable, objectAccessFor, type UserAccess } from './access.js';
import { buildSharingPredicate } from './sharing.js';

export type DmlAction = 'create' | 'read' | 'edit' | 'remove';

/**
 * Object-level CRUD gate.
 *
 * Kept separate from the SOQL policy because the failure shapes differ: a query hides what you
 * cannot read (INVALID_TYPE, indistinguishable from absent), while a write tells you plainly that
 * access was refused.
 */
export async function assertObjectAccess(ctx: RequestContext, obj: ObjectMeta, action: DmlAction): Promise<UserAccess> {
  const access = await ensureUserAccess(ctx);
  const allowed = objectAccessFor(access, obj.apiName);
  const ok =
    action === 'create' ? allowed.create : action === 'read' ? allowed.read : action === 'edit' ? allowed.edit : allowed.remove;
  if (!ok) {
    throw Errors.insufficientAccess(
      `insufficient access rights on object: ${obj.apiName} (${action} not permitted for this user)`
    );
  }
  return access;
}

/** Field-level security on write: an uneditable field is refused, never silently dropped. */
export async function assertFieldsEditable(
  ctx: RequestContext,
  obj: ObjectMeta,
  fieldApiNames: string[]
): Promise<void> {
  const access = await ensureUserAccess(ctx);
  for (const api of fieldApiNames) {
    if (api === 'Id' || api === 'attributes') continue;
    if (!fieldEditable(access, obj.apiName, api)) throw Errors.notWritable(api);
  }
}

/** Remove fields the user may not read from an outgoing record. */
export function stripUnreadableFields(access: UserAccess, obj: ObjectMeta, record: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes' || fieldReadable(access, obj.apiName, key)) out[key] = value;
  }
  return out;
}

/**
 * Row-level gate for writes: confirm every id is one the user may edit or delete.
 *
 * Runs as a single query with the sharing predicate injected, so a user cannot modify a record they
 * can merely see — a Read-only share is not a licence to write.
 */
export async function assertRecordsWritable(
  ctx: RequestContext,
  c: DbClient,
  obj: ObjectMeta,
  ids: string[]
): Promise<void> {
  if (!ids.length) return;
  const access = await ensureUserAccess(ctx);
  if (objectAccessFor(access, obj.apiName).modifyAll) return;
  const org = ctx.meta ?? (await ctx.orgMeta());

  const predicate = buildSharingPredicate(access, org, obj, 't', 2, { forWrite: true });
  if (!predicate) return;

  const res = await c.query<{ id: string }>(
    `SELECT t.id FROM ${tableFor(obj.apiName)} t WHERE t.id = ANY($1) AND ${predicate.sql}`,
    [ids, ...predicate.params]
  );
  const writable = new Set(res.rows.map((r) => r.id));
  const refused = ids.filter((id) => !writable.has(id));
  if (refused.length) {
    throw Errors.insufficientAccess(
      `insufficient access rights on object id: ${refused[0]}${refused.length > 1 ? ` (and ${refused.length - 1} more)` : ''}`
    );
  }
}

/** Adapt a resolved access record to the view the describe layer expects. */
export function describePermsView(access: UserAccess) {
  return {
    canRead: (obj: string) => objectAccessFor(access, obj).read,
    canCreate: (obj: string) => objectAccessFor(access, obj).create,
    canEdit: (obj: string) => objectAccessFor(access, obj).edit,
    canDelete: (obj: string) => objectAccessFor(access, obj).remove,
    fieldReadable: (obj: string, field: string) => fieldReadable(access, obj, field),
    fieldEditable: (obj: string, field: string) => fieldEditable(access, obj, field)
  };
}

/** Row-level read predicate for single-record reads, as a WHERE fragment. */
export async function readPredicateFor(
  ctx: RequestContext,
  obj: ObjectMeta,
  alias: string,
  nextParam: number
): Promise<{ sql: string; params: unknown[] } | null> {
  const access = await ensureUserAccess(ctx);
  const org = ctx.meta ?? (await ctx.orgMeta());
  return buildSharingPredicate(access, org, obj, alias, nextParam);
}
