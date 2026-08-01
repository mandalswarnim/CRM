import type { ObjectMeta } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { setSecurityPolicy, type SecurityPolicy, type SharingPredicate } from '../soql/security.js';
import { ensureUserAccess, fieldReadable, objectAccessFor, type UserAccess } from './access.js';
import { buildSharingPredicate } from './sharing.js';

/**
 * The real security policy for the SOQL compiler.
 *
 * Synchronous by contract, so it relies on the access record and org metadata already being
 * resolved onto the context — the query path awaits both before compiling. If either is missing the
 * policy fails closed for objects and open for nothing else, rather than silently granting access.
 */
export const platformSecurityPolicy: SecurityPolicy = {
  async prepare(ctx: RequestContext): Promise<void> {
    await ensureUserAccess(ctx);
    await ctx.orgMeta();
  },

  canReadObject(ctx: RequestContext, obj: ObjectMeta): boolean {
    const access = ctx.access as UserAccess | null;
    if (!access) return false;
    return objectAccessFor(access, obj.apiName).read;
  },

  canReadField(ctx: RequestContext, obj: ObjectMeta, fieldApiName: string): boolean {
    const access = ctx.access as UserAccess | null;
    if (!access) return false;
    return fieldReadable(access, obj.apiName, fieldApiName);
  },

  sharingPredicate(ctx: RequestContext, obj: ObjectMeta, alias: string, nextParam: number): SharingPredicate | null {
    const access = ctx.access as UserAccess | null;
    if (!access || !ctx.meta) return null;
    return buildSharingPredicate(access, ctx.meta, obj, alias, nextParam);
  }
};

/** Switch the platform from the permissive default to real enforcement. */
export function installPlatformSecurity(): void {
  setSecurityPolicy(platformSecurityPolicy);
}
