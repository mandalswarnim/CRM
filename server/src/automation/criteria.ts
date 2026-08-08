import type { ObjectMeta } from '../metadata/types.js';
import { getField } from '../metadata/types.js';
import { type EvalContext, runFormula, toFValue, truthy, FNULL } from '../formula/engine.js';

export interface CriteriaFilter {
  field: string;
  op: string;
  value: any;
}

const text = (v: unknown) => String(v ?? '').toLowerCase();

/** Field-filter criteria, AND-joined — the point-and-click alternative to a formula. */
export function matchesFilters(record: Record<string, any>, filters: CriteriaFilter[]): boolean {
  return filters.every(({ field, op, value }) => {
    const actual = record[field];
    switch (op) {
      case 'equals':
      case 'eq':
        return text(actual) === text(value);
      case 'notEquals':
      case 'ne':
        return text(actual) !== text(value);
      case 'lessThan':
        return Number(actual) < Number(value);
      case 'lessOrEqual':
        return Number(actual) <= Number(value);
      case 'greaterThan':
        return Number(actual) > Number(value);
      case 'greaterOrEqual':
        return Number(actual) >= Number(value);
      case 'contains':
        return text(actual).includes(text(value));
      case 'notContains':
        return !text(actual).includes(text(value));
      case 'startsWith':
        return text(actual).startsWith(text(value));
      case 'in':
        return Array.isArray(value) && value.map(text).includes(text(actual));
      case 'notIn':
        return Array.isArray(value) && !value.map(text).includes(text(actual));
      case 'isNull':
        return value === false ? actual != null && actual !== '' : actual == null || actual === '';
      default:
        return false;
    }
  });
}

export interface EvalInput {
  object: ObjectMeta;
  record: Record<string, any>;
  before: Record<string, any> | null;
  userId: string;
  orgName?: string;
}

/**
 * Formula evaluation context for a record being saved.
 *
 * ISCHANGED and PRIORVALUE need the before image, which is why the DML pipeline carries both images
 * through every hook rather than just the new values.
 */
export function buildEvalContext(input: EvalInput): EvalContext {
  const { object, record, before, userId } = input;

  return {
    get(path: string) {
      if (path.startsWith('$User.')) {
        const field = path.slice('$User.'.length);
        return field === 'Id' ? toFValue(userId, 'Text') : FNULL;
      }
      if (path.startsWith('$Organization.')) {
        return path.endsWith('.Name') ? toFValue(input.orgName ?? '', 'Text') : FNULL;
      }
      const direct = record[path];
      if (direct !== undefined) return toFValue(direct, getField(object, path)?.type);
      // Parent traversal is not resolved here: cross-object references need a query, which a
      // validation rule running inside the save must not do implicitly.
      return FNULL;
    },
    prior(field: string) {
      if (!before) return FNULL;
      return toFValue(before[field] ?? null, getField(object, field)?.type);
    },
    isNew: before === null
  };
}

/** Evaluate a boolean formula; a formula that cannot be evaluated is treated as false. */
export function evaluateCondition(formula: string, ctx: EvalContext): boolean {
  return truthy(runFormula(formula, ctx));
}
