import { registerDmlHooks, type DmlHooks } from '../dml/hooks.js';
import { assertValid } from './validation.js';
import { runWorkflowRules } from './workflow.js';

export { validateRecord, assertValid } from './validation.js';
export type { ValidationFailure } from './validation.js';
export { runWorkflowRules } from './workflow.js';
export type { WorkflowAction, WorkflowTrigger, TimeTrigger } from './workflow.js';
export { matchesFilters, buildEvalContext, evaluateCondition } from './criteria.js';
export type { CriteriaFilter } from './criteria.js';
export { mergeFields } from './merge.js';

/**
 * Point-and-click automation, hung on the save order.
 *
 * Validation runs at the `validate` stage so a failure aborts before anything is written; workflow
 * runs at `afterSave`, once the record exists and can be referenced by tasks and emails.
 */
export const automationHooks: DmlHooks = {
  name: 'automation',

  async validate(e) {
    if (e.operation !== 'insert' && e.operation !== 'update') return;
    assertValid(e.object, e.changes, e.ctx.userId);
  },

  async afterSave(e) {
    await runWorkflowRules(e);
  }
};

export function installAutomation(): void {
  registerDmlHooks(automationHooks);
}
