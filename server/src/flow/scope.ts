import type { FlowVariable } from './types.js';

/**
 * Flow variable storage.
 *
 * Paths are dotted (`$Record.Status__c`, `member.Email`), so a scope is a shallow map of named
 * values with path-aware get and set rather than a flat dictionary.
 */
export class FlowScope {
  private values = new Map<string, unknown>();

  constructor(variables: FlowVariable[] = [], inputs: Record<string, unknown> = {}) {
    for (const variable of variables) {
      this.values.set(variable.name, variable.value ?? (variable.isCollection ? [] : null));
    }
    for (const [name, value] of Object.entries(inputs)) this.values.set(name, value);
  }

  has(name: string): boolean {
    return this.values.has(name.split('.')[0]);
  }

  get(path: string): unknown {
    const [head, ...rest] = path.split('.');
    let cursor = this.values.get(head);
    for (const segment of rest) {
      if (cursor == null || typeof cursor !== 'object') return null;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor ?? null;
  }

  set(path: string, value: unknown): void {
    const [head, ...rest] = path.split('.');
    if (!rest.length) {
      this.values.set(head, value);
      return;
    }
    let cursor = this.values.get(head);
    if (cursor == null || typeof cursor !== 'object') {
      cursor = {};
      this.values.set(head, cursor);
    }
    let target = cursor as Record<string, unknown>;
    for (const segment of rest.slice(0, -1)) {
      if (target[segment] == null || typeof target[segment] !== 'object') target[segment] = {};
      target = target[segment] as Record<string, unknown>;
    }
    target[rest[rest.length - 1]] = value;
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

/**
 * Resolve `{!Expression}` references against the scope.
 *
 * A whole-string reference returns the typed value; an embedded one interpolates as text, so
 * `{!count}` yields a number but `"Booked: {!count}"` yields a string.
 */
export function resolveExpression(value: unknown, scope: FlowScope): unknown {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map((v) => resolveExpression(v, scope));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveExpression(v, scope)]));
    }
    return value;
  }

  const whole = /^\{!\s*([^}]+?)\s*\}$/.exec(value);
  if (whole) return scope.get(whole[1]);

  return value.replace(/\{!\s*([^}]+?)\s*\}/g, (_m, path: string) => {
    const resolved = scope.get(path);
    return resolved == null ? '' : String(resolved);
  });
}

/** Resolve a field map, dropping nothing — an explicit null is a deliberate clear. */
export function resolveFields(fields: Record<string, unknown>, scope: FlowScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, resolveExpression(v, scope)]));
}
