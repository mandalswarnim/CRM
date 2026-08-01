import { registerDmlHooks, type DmlHooks } from '../dml/hooks.js';
import { invalidateUserAccess } from './access.js';
import { computeRuleShares } from './sharing.js';
import { installPlatformSecurity } from './policy.js';

export {
  resolveUserAccess,
  ensureUserAccess,
  invalidateUserAccess,
  objectAccessFor,
  fieldReadable,
  fieldEditable,
  sharingFor
} from './access.js';
export type { UserAccess, ObjectAccess, SharingSetting, OrgWideDefault } from './access.js';
export {
  buildSharingPredicate,
  computeRuleShares,
  recomputeObjectShares,
  shareRecord,
  unshareRecord,
  setOrgWideDefault
} from './sharing.js';
export { platformSecurityPolicy, installPlatformSecurity } from './policy.js';
export {
  assertObjectAccess,
  assertFieldsEditable,
  assertRecordsWritable,
  stripUnreadableFields,
  readPredicateFor,
  describePermsView
} from './enforce.js';

/**
 * Keep computed sharing in step with the data.
 *
 * Runs in sideEffects, inside the transaction: a record and the shares derived from it must become
 * visible together or not at all.
 */
export const sharingHooks: DmlHooks = {
  name: 'sharing',
  async sideEffects(e) {
    if (e.operation === 'delete' || e.operation === 'undelete') return;
    await computeRuleShares(
      e.client,
      e.object,
      e.changes.map((change) => ({ id: change.id, fields: change.after ?? {} }))
    );
  },
  async afterCommit(e) {
    // Changing a user, profile or permission set invalidates cached access for the org.
    if (['User', 'Profile', 'PermissionSet'].includes(e.object.apiName)) {
      invalidateUserAccess(e.ctx.orgId);
    }
  }
};

/** Turn on real enforcement: the SOQL policy plus sharing maintenance on every save. */
export function installSecurity(): void {
  installPlatformSecurity();
  registerDmlHooks(sharingHooks);
}
