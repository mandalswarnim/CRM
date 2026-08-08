import { registerDmlHooks, type DmlEvent, type DmlHooks } from '../dml/hooks.js';
import { matchesFilters } from '../automation/criteria.js';
import { buildEvalContext, evaluateCondition } from '../automation/criteria.js';
import { loadRecordTriggeredFlows, runFlow } from './engine.js';
import type { FlowDefinition } from './types.js';

export { runFlow, loadFlow, loadRecordTriggeredFlows } from './engine.js';
export { FlowScope, resolveExpression } from './scope.js';
export type * from './types.js';

/** Does this flow's trigger match the operation and the record's state? */
function triggerMatches(flow: FlowDefinition, e: DmlEvent, change: DmlEvent['changes'][number]): boolean {
  const trigger = flow.trigger;
  if (!trigger) return false;

  const on = trigger.on ?? 'createOrUpdate';
  if (on === 'create' && e.operation !== 'insert') return false;
  if (on === 'update' && e.operation !== 'update') return false;
  if (on === 'delete' && e.operation !== 'delete') return false;
  if (on === 'createOrUpdate' && e.operation !== 'insert' && e.operation !== 'update') return false;

  const record = change.after ?? change.before;
  if (!record) return false;

  if (trigger.conditionFormula) {
    return evaluateCondition(
      trigger.conditionFormula,
      buildEvalContext({ object: e.object, record, before: change.before, userId: e.ctx.userId })
    );
  }
  if (trigger.conditions?.length) return matchesFilters(record, trigger.conditions);
  return true;
}

async function runFlowsFor(e: DmlEvent, when: 'before' | 'after'): Promise<void> {
  const flows = await loadRecordTriggeredFlows(e.client, e.object.apiName);
  if (!flows.length) return;

  for (const flow of flows) {
    if ((flow.trigger?.when ?? 'after') !== when) continue;

    for (const change of e.changes) {
      if (!triggerMatches(flow, e, change)) continue;

      const result = await runFlow(e.ctx, flow, {
        record: change.after ?? change.before ?? {},
        priorRecord: change.before,
        client: e.client,
        beforeSave: when === 'before'
      });

      // Before-save flows report changes for the pipeline to merge, so the record is written once
      // rather than saved and then saved again.
      if (when === 'before') Object.assign(change.updates, result.recordUpdates);
    }
  }
}

/**
 * Record-triggered flows, hung on the save order.
 *
 * Before-save flows run at `beforeSave`, where their field updates cost no extra DML; after-save
 * flows run at `afterSave`, where the record exists and can be referenced by anything they create.
 */
export const flowHooks: DmlHooks = {
  name: 'flow',

  async beforeSave(e) {
    if (e.operation === 'delete' || e.operation === 'undelete') return;
    await runFlowsFor(e, 'before');
  },

  async afterSave(e) {
    await runFlowsFor(e, 'after');
  }
};

export function installFlows(): void {
  registerDmlHooks(flowHooks);
}
