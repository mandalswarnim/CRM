import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { ObjectMeta, OrgMeta } from '../metadata/types.js';
import { getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { generateId, KEY_PREFIXES } from '../util/ids.js';
import { Errors } from '../util/errors.js';
import type { SharingPredicate } from '../soql/security.js';
import { objectAccessFor, sharingFor, type UserAccess } from './access.js';

const MAX_PARENT_DEPTH = 5;

/** Allocates bind parameters starting at a caller-chosen index. */
class ParamAllocator {
  readonly params: unknown[] = [];
  constructor(private start: number) {}
  add(value: unknown): string {
    this.params.push(value);
    return `$${this.start + this.params.length - 1}`;
  }
}

/**
 * Row-level visibility as a SQL predicate.
 *
 * Access is the union of: ownership, a downward role-hierarchy grant, and any share row — computed
 * rule shares and manual shares alike. Returning null means "no restriction", which is what an
 * org-wide default of Read/ReadWrite or a View All permission produces.
 */
export function buildSharingPredicate(
  access: UserAccess,
  org: OrgMeta,
  obj: ObjectMeta,
  alias: string,
  nextParam: number,
  opts: { forWrite?: boolean } = {}
): SharingPredicate | null {
  const p = new ParamAllocator(nextParam);
  const sql = predicateFor(access, org, obj, alias, p, 0, !!opts.forWrite);
  if (!sql) return null;
  return { sql, params: p.params };
}

function predicateFor(
  access: UserAccess,
  org: OrgMeta,
  obj: ObjectMeta,
  alias: string,
  p: ParamAllocator,
  depth: number,
  forWrite: boolean
): string | null {
  const objAccess = objectAccessFor(access, obj.apiName);
  if (forWrite ? objAccess.modifyAll : objAccess.viewAll || objAccess.modifyAll) return null;

  const setting = sharingFor(access, obj.apiName, obj.sharingModel);
  // Read access is blanket at Read or above; write access only at ReadWrite.
  if (setting.orgWideDefault === 'ReadWrite') return null;
  if (setting.orgWideDefault === 'Read' && !forWrite) return null;

  if (setting.orgWideDefault === 'ControlledByParent' && depth < MAX_PARENT_DEPTH) {
    const master = obj.fieldList.find((f) => f.isMasterDetail && f.referenceTo);
    const parent = master?.referenceTo ? getObject(org, master.referenceTo.split(',')[0].trim()) : undefined;
    if (master && parent) {
      const parentAlias = `${alias}_p${depth}`;
      const inner = predicateFor(access, org, parent, parentAlias, p, depth + 1, forWrite);
      // A detail record is visible exactly when its master is.
      const fk = master.column ? `${alias}.${master.column}` : `(${alias}.fields->>'${master.apiName}')`;
      const where = [`${parentAlias}.id = ${fk}`, `${parentAlias}.is_deleted = false`];
      if (inner) where.push(inner);
      return `EXISTS (SELECT 1 FROM ${tableFor(parent.apiName)} ${parentAlias} WHERE ${where.join(' AND ')})`;
    }
  }

  const clauses = [`${alias}.owner_id = ${p.add(access.userId)}`];

  if (setting.grantAccessUsingHierarchies && access.subordinateRoleIds.length) {
    clauses.push(
      `${alias}.owner_id IN (SELECT id FROM ${tableFor('User')} WHERE fields->>'UserRoleId' = ANY(${p.add(
        access.subordinateRoleIds
      )}))`
    );
  }

  const shareAlias = `${alias}_rs`;
  const subjects = [`(${shareAlias}.subject_type = 'User' AND ${shareAlias}.subject_id = ${p.add(access.userId)})`];
  if (access.groupIds.length) {
    subjects.push(`(${shareAlias}.subject_type = 'Group' AND ${shareAlias}.subject_id = ANY(${p.add(access.groupIds)}))`);
  }
  if (access.roleId) {
    subjects.push(`(${shareAlias}.subject_type = 'Role' AND ${shareAlias}.subject_id = ${p.add(access.roleId)})`);
  }
  if (access.roleAndAncestors.length) {
    subjects.push(
      `(${shareAlias}.subject_type = 'RoleAndSubordinates' AND ${shareAlias}.subject_id = ANY(${p.add(
        access.roleAndAncestors
      )}))`
    );
  }
  // A Read-only share never confers write access.
  const levelFilter = forWrite ? ` AND ${shareAlias}.access_level IN ('Edit','All')` : '';
  clauses.push(
    `EXISTS (SELECT 1 FROM record_share ${shareAlias} WHERE ${shareAlias}.object_api = ${p.add(obj.apiName)}` +
      ` AND ${shareAlias}.record_id = ${alias}.id${levelFilter} AND (${subjects.join(' OR ')}))`
  );

  return `(${clauses.join(' OR ')})`;
}

/* ---------------------------- computed rule shares --------------------------- */

interface SharingRuleRow {
  id: string;
  object_api: string;
  api_name: string;
  rule_type: 'owner' | 'criteria';
  owned_by: { type: string; id: string } | null;
  criteria: Array<{ field: string; op: string; value: any }> | null;
  share_with: { type: string; id: string };
  access_level: string;
}

function parseJson<T>(v: any): T {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

function matchesCriteria(record: Record<string, any>, criteria: Array<{ field: string; op: string; value: any }>): boolean {
  return criteria.every(({ field, op, value }) => {
    const actual = record[field];
    switch (op) {
      case 'equals':
      case 'eq':
        return String(actual ?? '').toLowerCase() === String(value ?? '').toLowerCase();
      case 'notEquals':
      case 'ne':
        return String(actual ?? '').toLowerCase() !== String(value ?? '').toLowerCase();
      case 'lessThan':
        return Number(actual) < Number(value);
      case 'greaterThan':
        return Number(actual) > Number(value);
      case 'contains':
        return String(actual ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
      case 'startsWith':
        return String(actual ?? '').toLowerCase().startsWith(String(value ?? '').toLowerCase());
      case 'in':
        return Array.isArray(value) && value.map((v) => String(v).toLowerCase()).includes(String(actual ?? '').toLowerCase());
      default:
        return false;
    }
  });
}

/**
 * Recompute rule-derived shares for specific records.
 *
 * Rule shares are materialised rather than evaluated per query: the query path then needs one
 * indexed lookup against record_share instead of interpreting every rule for every row.
 */
export async function computeRuleShares(
  c: DbClient,
  obj: ObjectMeta,
  records: Array<{ id: string; fields: Record<string, any> }>
): Promise<void> {
  if (!records.length) return;
  const ruleRows = await c.query<SharingRuleRow>(`SELECT * FROM sharing_rule WHERE object_api = $1`, [obj.apiName]);
  const ids = records.map((r) => r.id);

  await c.query(`DELETE FROM record_share WHERE object_api = $1 AND record_id = ANY($2) AND row_cause = 'Rule'`, [
    obj.apiName,
    ids
  ]);
  if (!ruleRows.rows.length) return;

  // Owner-based rules need each record owner's role and group membership.
  const ownerIds = [...new Set(records.map((r) => r.fields.OwnerId).filter(Boolean))];
  const ownerRoles = new Map<string, string | null>();
  if (ownerIds.length) {
    const owners = await c.query<{ id: string; fields: any }>(
      `SELECT id, fields FROM ${tableFor('User')} WHERE id = ANY($1)`,
      [ownerIds]
    );
    for (const row of owners.rows) {
      ownerRoles.set(row.id, parseJson<any>(row.fields)?.UserRoleId ?? null);
    }
  }
  const roleRows = await c.query<{ id: string; parent_id: string | null }>(`SELECT id, parent_id FROM role`);
  const parentOf = new Map(roleRows.rows.map((r) => [r.id, r.parent_id]));
  const ancestorsOf = (roleId: string | null): string[] => {
    const out: string[] = [];
    let cursor = roleId;
    while (cursor && !out.includes(cursor)) {
      out.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    return out;
  };
  const groupRows = await c.query<{ id: string; member_ids: any }>(`SELECT id, member_ids FROM group_def`);

  const inserts: Array<[string, string, string, string, string, string]> = [];
  for (const record of records) {
    for (const raw of ruleRows.rows) {
      const rule: SharingRuleRow = {
        ...raw,
        owned_by: raw.owned_by ? parseJson(raw.owned_by) : null,
        criteria: raw.criteria ? parseJson(raw.criteria) : null,
        share_with: parseJson(raw.share_with)
      };

      let applies = false;
      if (rule.rule_type === 'criteria' && rule.criteria) {
        applies = matchesCriteria(record.fields, rule.criteria);
      } else if (rule.rule_type === 'owner' && rule.owned_by) {
        const ownerRole = ownerRoles.get(record.fields.OwnerId) ?? null;
        if (rule.owned_by.type === 'Role') applies = ownerRole === rule.owned_by.id;
        else if (rule.owned_by.type === 'RoleAndSubordinates') applies = ancestorsOf(ownerRole).includes(rule.owned_by.id);
        else if (rule.owned_by.type === 'Group') {
          const group = groupRows.rows.find((g) => g.id === rule.owned_by!.id);
          const members = group ? parseJson<string[]>(group.member_ids) : [];
          applies =
            members.includes(record.fields.OwnerId) ||
            (!!ownerRole && members.includes(`role:${ownerRole}`));
        }
      }
      if (!applies) continue;

      inserts.push([
        generateId(KEY_PREFIXES.SharingRule),
        obj.apiName,
        record.id,
        rule.share_with.type,
        rule.share_with.id,
        rule.access_level
      ]);
    }
  }

  for (const row of inserts) {
    await c.query(
      `INSERT INTO record_share (id, object_api, record_id, subject_type, subject_id, access_level, row_cause)
       VALUES ($1,$2,$3,$4,$5,$6,'Rule')
       ON CONFLICT (object_api, record_id, subject_type, subject_id, row_cause) DO UPDATE SET access_level = EXCLUDED.access_level`,
      row
    );
  }
}

/** Recompute every rule share for an object — used when a sharing rule is created or changed. */
export async function recomputeObjectShares(ctx: RequestContext, objectApi: string): Promise<number> {
  const org = await ctx.orgMeta();
  const obj = getObject(org, objectApi);
  if (!obj) throw Errors.invalidType(objectApi);

  return ctx.tenant(async (c) => {
    const rows = await c.query<{ id: string; owner_id: string; fields: any }>(
      `SELECT id, owner_id, fields FROM ${tableFor(obj.apiName)} WHERE is_deleted = false`
    );
    const records = rows.rows.map((r) => ({
      id: r.id,
      fields: { ...parseJson<Record<string, any>>(r.fields), OwnerId: r.owner_id }
    }));
    await computeRuleShares(c, obj, records);
    return records.length;
  });
}

/* ------------------------------- manual sharing ------------------------------ */

export async function shareRecord(
  ctx: RequestContext,
  objectApi: string,
  recordId: string,
  subject: { type: 'User' | 'Group' | 'Role' | 'RoleAndSubordinates'; id: string },
  accessLevel: 'Read' | 'Edit' | 'All' = 'Read'
): Promise<void> {
  const org = await ctx.orgMeta();
  const obj = getObject(org, objectApi);
  if (!obj) throw Errors.invalidType(objectApi);
  await ctx.tenant((c) =>
    c.query(
      `INSERT INTO record_share (id, object_api, record_id, subject_type, subject_id, access_level, row_cause)
       VALUES ($1,$2,$3,$4,$5,$6,'Manual')
       ON CONFLICT (object_api, record_id, subject_type, subject_id, row_cause) DO UPDATE SET access_level = EXCLUDED.access_level`,
      [generateId(KEY_PREFIXES.SharingRule), obj.apiName, recordId, subject.type, subject.id, accessLevel]
    )
  );
}

export async function unshareRecord(
  ctx: RequestContext,
  objectApi: string,
  recordId: string,
  subject: { type: string; id: string }
): Promise<void> {
  await ctx.tenant((c) =>
    c.query(
      `DELETE FROM record_share WHERE object_api = $1 AND record_id = $2 AND subject_type = $3 AND subject_id = $4 AND row_cause = 'Manual'`,
      [objectApi, recordId, subject.type, subject.id]
    )
  );
}

/** Set an object's org-wide default. */
export async function setOrgWideDefault(
  ctx: RequestContext,
  objectApi: string,
  level: 'Private' | 'Read' | 'ReadWrite' | 'ControlledByParent',
  grantAccessUsingHierarchies = true
): Promise<void> {
  await ctx.tenant((c) =>
    c.query(
      `INSERT INTO sharing_setting (object_api, internal_access, grant_access_using_hierarchies)
       VALUES ($1,$2,$3)
       ON CONFLICT (object_api) DO UPDATE SET internal_access = EXCLUDED.internal_access,
                                             grant_access_using_hierarchies = EXCLUDED.grant_access_using_hierarchies`,
      [objectApi, level, grantAccessUsingHierarchies]
    )
  );
}
