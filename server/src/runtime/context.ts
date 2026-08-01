import type { Db, DbClient } from '../db/index.js';
import { withTenantClient } from '../db/index.js';
import { loadOrgMeta } from '../metadata/registry.js';
import type { OrgMeta } from '../metadata/types.js';
import { LimitContext } from './limits.js';

/** Structural type for the resolved access record, to keep runtime free of a security import cycle. */
export interface UserAccessLike {
  userId: string;
  perms: Record<string, boolean>;
}

export interface SessionInfo {
  tokenHash: string;
  kind: 'ui' | 'api' | 'oauth';
  scopes: string[];
}

/**
 * Everything an engine needs to act on behalf of one user in one org for one transaction.
 *
 * Engines take a RequestContext rather than reaching for globals: it is what makes the tenant
 * binding, the acting user and the governor limits impossible to forget.
 */
export class RequestContext {
  readonly db: Db;
  readonly orgId: string;
  readonly schema: string;
  readonly userId: string;
  readonly profileId: string | null;
  /** Profile-level permissions (modifyAllData, viewAllData, manageSetup…). */
  readonly perms: Record<string, boolean>;
  readonly session: SessionInfo | null;
  readonly limits: LimitContext;
  /** Resolved object/field/sharing access, populated once per request by ensureUserAccess. */
  access: any = null;

  constructor(opts: {
    db: Db;
    orgId: string;
    schema: string;
    userId: string;
    profileId?: string | null;
    perms?: Record<string, boolean>;
    session?: SessionInfo | null;
    limits?: LimitContext;
  }) {
    this.db = opts.db;
    this.orgId = opts.orgId;
    this.schema = opts.schema;
    this.userId = opts.userId;
    this.profileId = opts.profileId ?? null;
    this.perms = opts.perms ?? {};
    this.session = opts.session ?? null;
    this.limits = opts.limits ?? new LimitContext();
  }

  setAccess(access: unknown): void {
    this.access = access;
  }

  /** Run fn against a client bound to this org's schema. All tenant SQL goes through here. */
  tenant<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
    return withTenantClient(this.db, this.schema, fn);
  }

  /** Last resolved org metadata, so the synchronous security policy can consult it. */
  meta: OrgMeta | null = null;

  async orgMeta(): Promise<OrgMeta> {
    const meta = await loadOrgMeta(this.db, this.orgId, this.schema);
    this.meta = meta;
    return meta;
  }

  get isAdmin(): boolean {
    return this.perms.modifyAllData === true;
  }

  /** A fresh context for the same user with its own limit budget (used by jobs and async work). */
  fork(): RequestContext {
    return new RequestContext({
      db: this.db,
      orgId: this.orgId,
      schema: this.schema,
      userId: this.userId,
      profileId: this.profileId,
      perms: this.perms,
      session: this.session,
      limits: new LimitContext()
    });
  }
}
