import type { ObjectMeta } from '../metadata/types.js';
import type { RecordChange } from '../dml/hooks.js';
import { Errors } from '../util/errors.js';
import { FormulaError } from '../formula/engine.js';
import { buildEvalContext, evaluateCondition } from './criteria.js';

export interface ValidationFailure {
  rule: string;
  message: string;
  field: string | null;
}

/**
 * Run an object's validation rules against one record.
 *
 * Salesforce semantics, which read backwards at first: the formula describes the *error condition*,
 * so a rule fires when its formula evaluates to true.
 */
export function validateRecord(
  obj: ObjectMeta,
  change: RecordChange,
  userId: string
): ValidationFailure | null {
  if (!change.after) return null;
  const ctx = buildEvalContext({ object: obj, record: change.after, before: change.before, userId });

  for (const rule of obj.validationRules) {
    if (!rule.active) continue;
    let fires: boolean;
    try {
      fires = evaluateCondition(rule.formula, ctx);
    } catch (e) {
      if (e instanceof FormulaError) {
        // A broken rule must not silently wave records through.
        throw Errors.validation(`Validation rule ${rule.apiName} could not be evaluated: ${e.message}`);
      }
      throw e;
    }
    if (fires) {
      return { rule: rule.apiName, message: rule.errorMessage, field: rule.errorField ?? null };
    }
  }
  return null;
}

/** Throw the first validation failure across a batch, aborting the whole transaction. */
export function assertValid(obj: ObjectMeta, changes: RecordChange[], userId: string): void {
  for (const change of changes) {
    const failure = validateRecord(obj, change, userId);
    if (failure) {
      throw Errors.validation(failure.message, failure.field ? [failure.field] : []);
    }
  }
}
