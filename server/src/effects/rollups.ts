import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { FieldMeta, ObjectMeta, OrgMeta } from '../metadata/types.js';
import { getField, getObject } from '../metadata/types.js';

/** Which parent objects roll up from this child, and through which field. */
export interface RollupTarget {
  parent: ObjectMeta;
  field: FieldMeta;
  relationshipField: string;
}

export function rollupsOver(org: OrgMeta, child: ObjectMeta): RollupTarget[] {
  const out: RollupTarget[] = [];
  for (const parent of org.objectList) {
    for (const field of parent.fieldList) {
      if (field.type !== 'RollupSummary' || !field.rollup) continue;
      if (field.rollup.childObject.toLowerCase() !== child.apiName.toLowerCase()) continue;
      out.push({ parent, field, relationshipField: field.rollup.relationshipField });
    }
  }
  return out;
}

/** SQL cast for a child field being summed or compared. */
function childValueExpr(child: ObjectMeta, fieldApi: string): string {
  const f = getField(child, fieldApi);
  const raw = f?.column ? `c.${f.column}` : `(c.fields->>'${fieldApi.replace(/'/g, "''")}')`;
  switch (f?.type) {
    case 'Date':
      return `${raw}::date`;
    case 'DateTime':
      return `${raw}::timestamptz`;
    case 'Number':
    case 'Currency':
    case 'Percent':
      return `${raw}::numeric`;
    default:
      return raw;
  }
}

function filterSql(child: ObjectMeta, filters: Array<{ field: string; op: string; value: any }>, params: unknown[]): string {
  const parts: string[] = [];
  for (const filter of filters) {
    const expr = childValueExpr(child, filter.field);
    const bind = () => `$${params.push(filter.value)}`;
    switch (filter.op) {
      case 'equals':
      case 'eq':
        parts.push(`${expr} = ${bind()}`);
        break;
      case 'notEquals':
      case 'ne':
        parts.push(`${expr} <> ${bind()}`);
        break;
      case 'lessThan':
        parts.push(`${expr} < ${bind()}`);
        break;
      case 'greaterThan':
        parts.push(`${expr} > ${bind()}`);
        break;
      case 'isNull':
        parts.push(filter.value === false ? `${expr} IS NOT NULL` : `${expr} IS NULL`);
        break;
      default:
        break;
    }
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/**
 * Recompute one rollup for a set of parent records.
 *
 * Recomputed from the children rather than adjusted incrementally: an increment that drifts is
 * far worse than a recount, and the query is a single indexed aggregate per parent batch.
 */
export async function recomputeRollup(
  c: DbClient,
  org: OrgMeta,
  target: RollupTarget,
  parentIds: string[]
): Promise<void> {
  if (!parentIds.length) return;
  const spec = target.field.rollup!;
  const child = getObject(org, spec.childObject);
  if (!child) return;

  const params: unknown[] = [parentIds];
  const relExpr = `(c.fields->>'${spec.relationshipField.replace(/'/g, "''")}')`;

  let aggregate: string;
  if (spec.operation === 'COUNT') {
    aggregate = 'count(*)';
  } else {
    if (!spec.field) return;
    const value = childValueExpr(child, spec.field);
    aggregate = `${spec.operation.toLowerCase()}(${value})`;
  }

  const where = `${relExpr} = ANY($1) AND c.is_deleted = false${filterSql(child, spec.filters ?? [], params)}`;
  const rows = await c.query<{ parent_id: string; value: any }>(
    `SELECT ${relExpr} AS parent_id, ${aggregate} AS value
       FROM ${tableFor(child.apiName)} c
      WHERE ${where}
      GROUP BY ${relExpr}`,
    params
  );

  const computed = new Map(rows.rows.map((r) => [r.parent_id, r.value]));
  for (const parentId of parentIds) {
    const raw = computed.get(parentId);
    // A parent with no matching children counts zero but sums to null, as Salesforce does.
    const value = raw ?? (spec.operation === 'COUNT' ? 0 : null);
    const json = value === null ? null : JSON.stringify(typeof value === 'object' ? String(value) : value);
    await c.query(
      `UPDATE ${tableFor(target.parent.apiName)}
          SET fields = CASE WHEN $2::text IS NULL THEN fields - $3 ELSE jsonb_set(fields, ARRAY[$3], $2::jsonb) END,
              system_modstamp = now()
        WHERE id = $1`,
      [parentId, json, target.field.apiName]
    );
  }
}

/** Parent ids touched by a change, on both sides of a reparent. */
export function affectedParents(
  changes: Array<{ before: Record<string, any> | null; after: Record<string, any> | null }>,
  relationshipField: string
): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    const before = change.before?.[relationshipField];
    const after = change.after?.[relationshipField];
    if (before) ids.add(String(before));
    if (after) ids.add(String(after));
  }
  return [...ids];
}
