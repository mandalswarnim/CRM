import type { DbClient } from '../db/index.js';
import type { ObjectMeta } from '../metadata/types.js';
import type { RecordChange } from '../dml/hooks.js';
import { generateId, KEY_PREFIXES } from '../util/ids.js';

/** Stringify for the history/feed audit trail, which stores values as text. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface TrackedChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Fields that changed and are marked for history tracking. */
export function trackedChanges(obj: ObjectMeta, change: RecordChange): TrackedChange[] {
  if (!change.before || !change.after) return [];
  const out: TrackedChange[] = [];
  for (const field of obj.fieldList) {
    if (!field.trackHistory) continue;
    const before = asText(change.before[field.apiName]);
    const after = asText(change.after[field.apiName]);
    if (before !== after) out.push({ field: field.apiName, oldValue: before, newValue: after });
  }
  return out;
}

/**
 * Write field-history rows. Creates and deletes are recorded as whole-record events.
 *
 * Objects default to history-enabled, so the gate that matters is whether any field is actually
 * tracked: without this, every insert on every object would write a history row for nothing.
 */
export async function writeHistory(
  c: DbClient,
  obj: ObjectMeta,
  userId: string,
  operation: string,
  changes: RecordChange[]
): Promise<number> {
  if (!obj.historyEnabled || !obj.fieldList.some((f) => f.trackHistory)) return 0;
  let written = 0;

  for (const change of changes) {
    if (operation === 'insert') {
      await c.query(
        `INSERT INTO record_history (object_api, record_id, field_api, old_value, new_value, changed_by)
         VALUES ($1,$2,'Created',NULL,NULL,$3)`,
        [obj.apiName, change.id, userId]
      );
      written++;
      continue;
    }
    if (operation === 'delete') {
      await c.query(
        `INSERT INTO record_history (object_api, record_id, field_api, old_value, new_value, changed_by)
         VALUES ($1,$2,'Deleted',NULL,NULL,$3)`,
        [obj.apiName, change.id, userId]
      );
      written++;
      continue;
    }
    for (const tracked of trackedChanges(obj, change)) {
      await c.query(
        `INSERT INTO record_history (object_api, record_id, field_api, old_value, new_value, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [obj.apiName, change.id, tracked.field, tracked.oldValue, tracked.newValue, userId]
      );
      written++;
    }
  }
  return written;
}

/** Post tracked-change items to the record's feed, for objects with the feed enabled. */
export async function writeFeedItems(
  c: DbClient,
  obj: ObjectMeta,
  userId: string,
  operation: string,
  changes: RecordChange[]
): Promise<number> {
  if (!obj.feedEnabled || operation !== 'update') return 0;
  let written = 0;

  for (const change of changes) {
    const tracked = trackedChanges(obj, change);
    if (!tracked.length) continue;
    await c.query(
      `INSERT INTO feed_item (id, parent_id, type, body, payload, created_by)
       VALUES ($1,$2,'TrackedChange',$3,$4,$5)`,
      [
        generateId(KEY_PREFIXES.FeedItem),
        change.id,
        tracked.map((t) => `${t.field} changed from ${t.oldValue ?? '—'} to ${t.newValue ?? '—'}`).join('; '),
        JSON.stringify({ changes: tracked }),
        userId
      ]
    );
    written++;
  }
  return written;
}
