import { registerDmlHooks, type DmlEvent, type DmlHooks } from '../dml/hooks.js';
import { changeBus } from './events.js';
import { writeFeedItems, writeHistory } from './history.js';
import { affectedParents, recomputeRollup, rollupsOver } from './rollups.js';
import { indexRecords, removeFromIndex } from './search.js';

export { changeBus } from './events.js';
export type { ChangeEvent } from './events.js';
export { recomputeRollup, rollupsOver, affectedParents } from './rollups.js';
export { trackedChanges, writeHistory, writeFeedItems } from './history.js';
export { indexRecords, removeFromIndex, indexableText } from './search.js';

/**
 * Everything that must happen alongside a save.
 *
 * All of it runs in the save transaction except the change event, which fires after commit so no
 * subscriber ever learns about a record that is about to be rolled back.
 */
export const effectHooks: DmlHooks = {
  name: 'side-effects',

  async sideEffects(e: DmlEvent) {
    const org = await e.ctx.orgMeta();

    // Rollups on any parent this object feeds, on both sides of a reparent.
    for (const target of rollupsOver(org, e.object)) {
      const parentIds = affectedParents(e.changes, target.relationshipField);
      await recomputeRollup(e.client, org, target, parentIds);
    }

    // A new record initialises its own rollup fields, so they read 0 rather than absent.
    if (e.operation === 'insert') {
      for (const field of e.object.fieldList) {
        if (field.type !== 'RollupSummary' || !field.rollup) continue;
        await recomputeRollup(
          e.client,
          org,
          { parent: e.object, field, relationshipField: field.rollup.relationshipField },
          e.changes.map((c) => c.id)
        );
      }
    }

    await writeHistory(e.client, e.object, e.ctx.userId, e.operation, e.changes);
    await writeFeedItems(e.client, e.object, e.ctx.userId, e.operation, e.changes);

    if (e.operation === 'delete') {
      await removeFromIndex(e.client, e.changes.map((c) => c.id));
    } else {
      await indexRecords(
        e.client,
        e.object,
        e.changes.map((c) => ({ id: c.id, fields: c.after ?? {} }))
      );
    }
  },

  async afterCommit(e: DmlEvent) {
    changeBus.publish({
      orgId: e.ctx.orgId,
      object: e.object.apiName,
      operation: e.operation,
      recordIds: e.changes.map((c) => c.id),
      records: e.changes.map((c) => c.after ?? c.before ?? {}),
      at: new Date().toISOString()
    });
  }
};

export function installEffects(): void {
  registerDmlHooks(effectHooks);
}
