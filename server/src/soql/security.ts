import type { ObjectMeta } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';

export interface SharingPredicate {
  /** SQL fragment referencing the row alias, e.g. `t0.owner_id = $1`. */
  sql: string;
  params: unknown[];
}

/**
 * The security rewrite applied to every query before SQL is generated.
 *
 * This is an interface rather than a filter over results on purpose: sharing has to become a
 * predicate inside the SQL, and field-level security has to reject unreadable fields at compile
 * time with INVALID_FIELD, exactly as the Salesforce API does. Bolting either on afterwards would
 * mean rewriting the compiler.
 */
export interface SecurityPolicy {
  /**
   * Resolve whatever the synchronous checks below depend on, before compilation starts.
   * The executor always awaits this, so a policy can load permissions without the compiler
   * having to know that permissions come from the database.
   */
  prepare?(ctx: RequestContext): Promise<void>;
  canReadObject(ctx: RequestContext, obj: ObjectMeta): boolean;
  canReadField(ctx: RequestContext, obj: ObjectMeta, fieldApiName: string): boolean;
  /**
   * Row-level restriction for the object at `alias`, or null when the user sees everything.
   * `nextParam` is the 1-based index the next bind parameter must use.
   */
  sharingPredicate(
    ctx: RequestContext,
    obj: ObjectMeta,
    alias: string,
    nextParam: number
  ): SharingPredicate | null;
}

/** Permissive policy used until the security model lands; the hook exists from day one. */
export const ALLOW_ALL: SecurityPolicy = {
  canReadObject: () => true,
  canReadField: () => true,
  sharingPredicate: () => null
};

let current: SecurityPolicy = ALLOW_ALL;

export function setSecurityPolicy(policy: SecurityPolicy): void {
  current = policy;
}

export function resetSecurityPolicy(): void {
  current = ALLOW_ALL;
}

export function getSecurityPolicy(): SecurityPolicy {
  return current;
}
