import type { DbClient } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { RequestContext } from '../runtime/context.js';

export interface ObjectAccess {
  create: boolean;
  read: boolean;
  edit: boolean;
  remove: boolean;
  viewAll: boolean;
  modifyAll: boolean;
}

export type OrgWideDefault = 'Private' | 'Read' | 'ReadWrite' | 'ControlledByParent';

export interface SharingSetting {
  orgWideDefault: OrgWideDefault;
  grantAccessUsingHierarchies: boolean;
}

/**
 * Everything needed to answer "may this user see this?" without another query.
 *
 * Resolved once per request and cached on the RequestContext, because the SOQL security policy is
 * synchronous by design — it runs inside the compiler, where an await per field would be absurd.
 */
export interface UserAccess {
  userId: string;
  profileId: string | null;
  roleId: string | null;
  /** Profile ∪ permission-set flags: modifyAllData, viewAllData, manageSetup… */
  perms: Record<string, boolean>;
  objects: Map<string, ObjectAccess>;
  /** Explicit field permissions, keyed `object.field` lower-cased. Absent means visible. */
  fields: Map<string, { readable: boolean; editable: boolean }>;
  sharing: Map<string, SharingSetting>;
  /** Groups the user belongs to, directly or through a role or nested group. */
  groupIds: string[];
  /** The user's own role plus every ancestor — who can share down to them. */
  roleAndAncestors: string[];
  /** Roles strictly below the user's, whose owners' records they inherit. */
  subordinateRoleIds: string[];
}

const EMPTY_ACCESS: ObjectAccess = {
  create: false,
  read: false,
  edit: false,
  remove: false,
  viewAll: false,
  modifyAll: false
};

const FULL_ACCESS: ObjectAccess = {
  create: true,
  read: true,
  edit: true,
  remove: true,
  viewAll: true,
  modifyAll: true
};

function fieldKey(objectApi: string, fieldApi: string): string {
  return `${objectApi.toLowerCase()}.${fieldApi.toLowerCase()}`;
}

/** Load a user's effective access from profile, permission sets, roles, groups and sharing settings. */
export async function resolveUserAccess(c: DbClient, userId: string): Promise<UserAccess> {
  const userRes = await c.query<{ fields: any }>(`SELECT fields FROM ${tableFor('User')} WHERE id = $1`, [userId]);
  const userFields = userRes.rows.length
    ? typeof userRes.rows[0].fields === 'string'
      ? JSON.parse(userRes.rows[0].fields)
      : userRes.rows[0].fields
    : {};
  const profileId: string | null = userFields.ProfileId ?? null;
  const roleId: string | null = userFields.UserRoleId ?? null;

  const assignments = await c.query<{ perm_set_id: string }>(
    `SELECT perm_set_id FROM perm_set_assignment WHERE user_id = $1`,
    [userId]
  );
  const parentIds = [profileId, ...assignments.rows.map((r) => r.perm_set_id)].filter((v): v is string => !!v);

  const perms: Record<string, boolean> = {};
  if (parentIds.length) {
    const permRows = await c.query<{ perms: any }>(
      `SELECT perms FROM profile WHERE id = ANY($1)
       UNION ALL
       SELECT perms FROM permission_set WHERE id = ANY($1)`,
      [parentIds]
    );
    for (const row of permRows.rows) {
      const parsed = typeof row.perms === 'string' ? JSON.parse(row.perms) : (row.perms ?? {});
      for (const [k, v] of Object.entries(parsed)) if (v) perms[k] = true;
    }
  }

  const objects = new Map<string, ObjectAccess>();
  if (parentIds.length) {
    const objRows = await c.query<{
      object_api: string;
      can_create: boolean;
      can_read: boolean;
      can_edit: boolean;
      can_delete: boolean;
      view_all: boolean;
      modify_all: boolean;
    }>(`SELECT * FROM object_perm WHERE parent_id = ANY($1)`, [parentIds]);
    for (const row of objRows.rows) {
      const key = row.object_api.toLowerCase();
      const existing = objects.get(key) ?? { ...EMPTY_ACCESS };
      objects.set(key, {
        create: existing.create || row.can_create,
        read: existing.read || row.can_read,
        edit: existing.edit || row.can_edit,
        remove: existing.remove || row.can_delete,
        viewAll: existing.viewAll || row.view_all,
        modifyAll: existing.modifyAll || row.modify_all
      });
    }
  }

  const fields = new Map<string, { readable: boolean; editable: boolean }>();
  if (parentIds.length) {
    const fieldRows = await c.query<{ object_api: string; field_api: string; readable: boolean; editable: boolean }>(
      `SELECT object_api, field_api, readable, editable FROM field_perm WHERE parent_id = ANY($1)`,
      [parentIds]
    );
    for (const row of fieldRows.rows) {
      const key = fieldKey(row.object_api, row.field_api);
      const existing = fields.get(key);
      // Permission sets add: any parent granting access wins over one that denies it.
      fields.set(key, {
        readable: (existing?.readable ?? false) || row.readable,
        editable: (existing?.editable ?? false) || row.editable
      });
    }
  }

  const sharing = new Map<string, SharingSetting>();
  const sharingRows = await c.query<{
    object_api: string;
    internal_access: string;
    grant_access_using_hierarchies: boolean;
  }>(`SELECT * FROM sharing_setting`);
  for (const row of sharingRows.rows) {
    sharing.set(row.object_api.toLowerCase(), {
      orgWideDefault: row.internal_access as OrgWideDefault,
      grantAccessUsingHierarchies: row.grant_access_using_hierarchies
    });
  }

  const roles = await c.query<{ id: string; parent_id: string | null }>(`SELECT id, parent_id FROM role`);
  const parentOf = new Map<string, string | null>(roles.rows.map((r) => [r.id, r.parent_id]));
  const childrenOf = new Map<string, string[]>();
  for (const r of roles.rows) {
    if (!r.parent_id) continue;
    childrenOf.set(r.parent_id, [...(childrenOf.get(r.parent_id) ?? []), r.id]);
  }

  const roleAndAncestors: string[] = [];
  let cursor = roleId;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    roleAndAncestors.push(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }

  const subordinateRoleIds: string[] = [];
  const queue = [...(roleId ? (childrenOf.get(roleId) ?? []) : [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (subordinateRoleIds.includes(next)) continue;
    subordinateRoleIds.push(next);
    queue.push(...(childrenOf.get(next) ?? []));
  }

  const groupIds = await resolveGroupMembership(c, userId, roleAndAncestors, roleId);

  return {
    userId,
    profileId,
    roleId,
    perms,
    objects,
    fields,
    sharing,
    groupIds,
    roleAndAncestors,
    subordinateRoleIds
  };
}

/** Groups containing the user directly, via their role, or via another group that contains them. */
async function resolveGroupMembership(
  c: DbClient,
  userId: string,
  roleAndAncestors: string[],
  roleId: string | null
): Promise<string[]> {
  const groups = await c.query<{ id: string; member_ids: any }>(`SELECT id, member_ids FROM group_def`);
  const members = new Map<string, string[]>();
  for (const row of groups.rows) {
    const list = typeof row.member_ids === 'string' ? JSON.parse(row.member_ids) : (row.member_ids ?? []);
    members.set(row.id, list);
  }

  const belongs = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [groupId, list] of members) {
      if (belongs.has(groupId)) continue;
      const isMember = list.some((entry: string) => {
        if (entry === userId) return true;
        if (entry.startsWith('role:')) {
          const target = entry.slice(5);
          // A role membership covers that role; RoleAndSubordinates entries name it explicitly.
          return target === roleId || roleAndAncestors.includes(target);
        }
        if (entry.startsWith('group:')) return belongs.has(entry.slice(6));
        return false;
      });
      if (isMember) {
        belongs.add(groupId);
        changed = true;
      }
    }
  }
  return [...belongs];
}

/* ------------------------------- derived views ------------------------------ */

export function objectAccessFor(access: UserAccess, objectApi: string): ObjectAccess {
  if (access.perms.modifyAllData) return FULL_ACCESS;
  const own = access.objects.get(objectApi.toLowerCase()) ?? { ...EMPTY_ACCESS };
  if (access.perms.viewAllData) return { ...own, read: true, viewAll: true };
  return own;
}

export function fieldReadable(access: UserAccess, objectApi: string, fieldApi: string): boolean {
  if (access.perms.modifyAllData || access.perms.viewAllData) return true;
  const explicit = access.fields.get(fieldKey(objectApi, fieldApi));
  return explicit ? explicit.readable : true;
}

export function fieldEditable(access: UserAccess, objectApi: string, fieldApi: string): boolean {
  if (access.perms.modifyAllData) return true;
  const explicit = access.fields.get(fieldKey(objectApi, fieldApi));
  return explicit ? explicit.editable : true;
}

export function sharingFor(access: UserAccess, objectApi: string, fallback: OrgWideDefault): SharingSetting {
  return access.sharing.get(objectApi.toLowerCase()) ?? { orgWideDefault: fallback, grantAccessUsingHierarchies: true };
}

/* --------------------------------- caching --------------------------------- */

const cache = new Map<string, UserAccess>();

function cacheKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

export function invalidateUserAccess(orgId: string, userId?: string): void {
  if (userId) cache.delete(cacheKey(orgId, userId));
  else for (const key of [...cache.keys()]) if (key.startsWith(`${orgId}:`)) cache.delete(key);
}

/** Resolve and memoise the acting user's access on the request context. */
export async function ensureUserAccess(ctx: RequestContext): Promise<UserAccess> {
  if (ctx.access) return ctx.access;
  const key = cacheKey(ctx.orgId, ctx.userId);
  const cached = cache.get(key);
  if (cached) {
    ctx.setAccess(cached);
    return cached;
  }
  const access = await ctx.tenant((c) => resolveUserAccess(c, ctx.userId));
  cache.set(key, access);
  ctx.setAccess(access);
  return access;
}
