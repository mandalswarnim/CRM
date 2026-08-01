import type { DbClient } from '../db/index.js';
import type { ObjectMeta } from '../metadata/types.js';

/** Field types whose values are worth putting in the search index. */
const SEARCHABLE_TYPES = new Set([
  'Text',
  'TextArea',
  'LongTextArea',
  'RichText',
  'Email',
  'Phone',
  'Url',
  'Picklist',
  'MultiselectPicklist',
  'AutoNumber'
]);

/** Title and body for one record: the name, plus every searchable field value. */
export function indexableText(obj: ObjectMeta, record: Record<string, any>): { title: string; body: string } {
  const nameField = obj.fields.get('name');
  const title = nameField ? String(record[nameField.apiName] ?? '') : '';
  const parts: string[] = [];
  for (const field of obj.fieldList) {
    if (!SEARCHABLE_TYPES.has(field.type)) continue;
    const value = record[field.apiName];
    if (value === null || value === undefined || value === '') continue;
    parts.push(String(value));
  }
  return { title, body: parts.join(' ') };
}

/**
 * Maintain the per-record tsvector index on every write.
 *
 * Kept in the same transaction as the record: a search hit that resolves to a record that does not
 * exist yet, or misses one that does, is a bug users notice immediately.
 */
export async function indexRecords(
  c: DbClient,
  obj: ObjectMeta,
  records: Array<{ id: string; fields: Record<string, any> }>
): Promise<void> {
  if (!obj.searchEnabled) return;
  for (const record of records) {
    const { title, body } = indexableText(obj, record.fields);
    await c.query(
      `INSERT INTO search_index (record_id, object_api, title, body, tsv)
       VALUES ($1,$2,$3,$4, setweight(to_tsvector('simple', coalesce($3,'')), 'A') ||
                            setweight(to_tsvector('simple', coalesce($4,'')), 'B'))
       ON CONFLICT (record_id) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body, tsv = EXCLUDED.tsv`,
      [record.id, obj.apiName, title, body]
    );
  }
}

export async function removeFromIndex(c: DbClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await c.query(`DELETE FROM search_index WHERE record_id = ANY($1)`, [ids]);
}
