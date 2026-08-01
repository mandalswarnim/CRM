import type { DbClient } from '../db/index.js';
import type { ObjectMeta } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';

export type DmlOperation = 'insert' | 'update' | 'delete' | 'undelete';

/** One record's transition through a save: what it was, what it will be. */
export interface RecordChange {
  id: string;
  /** Flat API-name view of the record before this operation (null on insert). */
  before: Record<string, any> | null;
  /** Flat API-name view of the record after this operation (null on delete). */
  after: Record<string, any> | null;
  /** The fields the caller actually supplied, before defaults were applied. */
  input: Record<string, any>;
  /** Hooks may set values here during beforeSave; they are merged before the row is written. */
  updates: Record<string, any>;
}

export interface DmlEvent {
  ctx: RequestContext;
  /** The transaction's client. Hooks must use this, never open their own connection. */
  client: DbClient;
  object: ObjectMeta;
  operation: DmlOperation;
  changes: RecordChange[];
}

/**
 * Extension points in the save order, named for the Salesforce stage they correspond to.
 *
 * The pipeline calls these in order; the automation and side-effect engines register against them
 * as they are built. Everything runs inside the transaction except afterCommit.
 */
export interface DmlHooks {
  name: string;
  /** Before-save flows: fast field updates, no re-validation cost. */
  beforeSave?(e: DmlEvent): Promise<void>;
  /** Validation rules — throw SfError to abort the whole transaction. */
  validate?(e: DmlEvent): Promise<void>;
  /** Assignment rules, after-save flows, workflow rules, approval side effects. */
  afterSave?(e: DmlEvent): Promise<void>;
  /** Rollups, history, feed items, search index, streaming events. Still in-transaction. */
  sideEffects?(e: DmlEvent): Promise<void>;
  /** Fired after COMMIT: email, outbound messages, anything that must not roll back. */
  afterCommit?(e: DmlEvent): Promise<void>;
}

const registered: DmlHooks[] = [];

export function registerDmlHooks(hooks: DmlHooks): void {
  const existing = registered.findIndex((h) => h.name === hooks.name);
  if (existing >= 0) registered[existing] = hooks;
  else registered.push(hooks);
}

export function clearDmlHooks(): void {
  registered.length = 0;
}

export function registeredHooks(): readonly DmlHooks[] {
  return registered;
}

/** Run one stage across every registered hook, in registration order. */
export async function runStage(stage: keyof Omit<DmlHooks, 'name'>, e: DmlEvent): Promise<void> {
  for (const hook of registered) {
    const fn = hook[stage];
    if (fn) await fn.call(hook, e);
  }
}
