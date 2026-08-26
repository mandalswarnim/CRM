import type { DbClient } from '../db/index.js';
import type { ObjectMeta } from '../metadata/types.js';

/**
 * The search index.
 *
 * Each record gets one `tsvector` whose weights encode *which kind of field* a word came from, so
 * SOSL's search groups (`IN NAME FIELDS`, `IN EMAIL FIELDS`, …) are answerable from the same
 * column rather than needing one column per group:
 *
 *   A — the name field          NAME FIELDS / SIDEBAR FIELDS
 *   B — general text            (part of ALL FIELDS only)
 *   C — email fields            EMAIL FIELDS
 *   D — phone fields            PHONE FIELDS
 */

/** Field types indexed at weight B. */
const TEXT_TYPES = new Set([
  'Text',
  'TextArea',
  'LongTextArea',
  'RichText',
  'Url',
  'Picklist',
  'MultiselectPicklist',
  'AutoNumber'
]);

const EMAIL_TYPES = new Set(['Email']);
const PHONE_TYPES = new Set(['Phone']);

export interface IndexableText {
  title: string;
  body: string;
  email: string;
  phone: string;
}

/**
 * A phone number is indexed both as written and as bare digits, so `020 7290 1400`,
 * `02072901400` and `+44 20 7290 1400` all find each other.
 */
function phoneForms(value: string): string[] {
  const digits = value.replace(/\D/g, '');
  const forms = [value];
  if (digits && digits !== value) forms.push(digits);
  // Trailing national form: +442072901400 should also be reachable as 2072901400.
  if (digits.length > 10) forms.push(digits.slice(-10));
  return forms;
}

/**
 * Postgres tokenises `enquiries@bengalclub.in` as a *single* lexeme, so searching for the domain
 * or the local part alone would miss it. Both are indexed alongside the whole address.
 */
function emailForms(value: string): string[] {
  const forms = [value];
  const at = value.lastIndexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (local) forms.push(local);
    if (domain) {
      forms.push(domain);
      // The host is itself one lexeme; the split form makes each label searchable.
      if (domain.includes('.')) forms.push(domain.replace(/\./g, ' '));
    }
  }
  return forms;
}

/** Split one record into the four weight buckets. */
export function indexableText(obj: ObjectMeta, record: Record<string, any>): IndexableText {
  const nameField = obj.fields.get('name');
  const title = nameField ? String(record[nameField.apiName] ?? '') : '';

  const body: string[] = [];
  const email: string[] = [];
  const phone: string[] = [];

  for (const field of obj.fieldList) {
    const value = record[field.apiName];
    if (value === null || value === undefined || value === '') continue;
    const text = String(value);

    if (EMAIL_TYPES.has(field.type)) {
      email.push(...emailForms(text));
      // The local part and domain are useful on their own when searching ALL FIELDS.
      body.push(text.replace(/[@.]/g, ' '));
    } else if (PHONE_TYPES.has(field.type)) {
      phone.push(...phoneForms(text));
    } else if (TEXT_TYPES.has(field.type)) {
      // The name is already weight A; repeating it at B would double-count it in ranking.
      if (nameField && field.apiName === nameField.apiName) continue;
      body.push(text);
    }
  }

  return { title, body: body.join(' '), email: email.join(' '), phone: phone.join(' ') };
}

/** $3 title · $4 stored body (display) · $5 general text · $6 email · $7 phone */
const TSV = `
  setweight(to_tsvector('simple', coalesce($3,'')), 'A') ||
  setweight(to_tsvector('simple', coalesce($5,'')), 'B') ||
  setweight(to_tsvector('simple', coalesce($6,'')), 'C') ||
  setweight(to_tsvector('simple', coalesce($7,'')), 'D')`;

/**
 * Maintain the per-record index on every write.
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
    const { title, body, email, phone } = indexableText(obj, record.fields);
    // The stored `body` keeps every searchable value, so the row remains readable on its own;
    // the weight buckets are passed separately and only shape the tsvector.
    const display = [body, email, phone].filter(Boolean).join(' ');
    await c.query(
      `INSERT INTO search_index (record_id, object_api, title, body, tsv)
       VALUES ($1,$2,$3,$4,${TSV})
       ON CONFLICT (record_id) DO UPDATE
         SET title = EXCLUDED.title, body = EXCLUDED.body, tsv = EXCLUDED.tsv`,
      [record.id, obj.apiName, title, display, body, email, phone]
    );
  }
}

export async function removeFromIndex(c: DbClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await c.query(`DELETE FROM search_index WHERE record_id = ANY($1)`, [ids]);
}
