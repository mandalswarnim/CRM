import type { DbClient } from '../db/index.js';
import { inTransaction } from '../db/index.js';
import { tableFor } from '../metadata/registry.js';
import type { FieldMeta, ObjectMeta, OrgMeta } from '../metadata/types.js';
import { getField, getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { generateId, normalizeId } from '../util/ids.js';
import { SfError, Errors } from '../util/errors.js';
import { runFormula, toFValue, fromFValue, FormulaError } from '../formula/engine.js';
import { coerceValue, composeName, formatAutoNumber, hasCompoundName, isWritable } from './values.js';
import { runStage, type DmlEvent, type DmlOperation, type RecordChange } from './hooks.js';
import {
  assertFieldsEditable,
  assertObjectAccess,
  assertRecordsWritable,
  readPredicateFor,
  stripUnreadableFields
} from '../security/enforce.js';

export interface SaveResult {
  id: string;
  success: boolean;
  created: boolean;
  errors: Array<{ message: string; errorCode: string; fields: string[] }>;
}

export interface DmlOptions {
  /** When true (the default) any failure rolls back the whole request. */
  allOrNone?: boolean;
  /** Bulk "serial mode" style toggle: skip automation hooks for high-volume loads. */
  skipAutomation?: boolean;
  /**
   * Run inside a transaction the caller already opened, instead of opening one.
   * Composite requests use this so several operations commit or roll back together.
   */
  client?: DbClient;
}

/** Run fn on the caller's client if there is one, otherwise in a fresh tenant transaction. */
function withTransaction<T>(
  ctx: RequestContext,
  opts: DmlOptions,
  fn: (c: DbClient) => Promise<T>
): Promise<T> {
  if (opts.client) return fn(opts.client);
  return ctx.tenant((c) => inTransaction(c, () => fn(c)));
}

/** Physical columns that hold field values, keyed by the column name in the data table. */
const COLUMN_OF: Record<string, string> = {
  name: 'name',
  owner_id: 'owner_id',
  record_type_id: 'record_type_id',
  currency_iso_code: 'currency_iso_code'
};

interface StoredRow {
  id: string;
  name: string | null;
  owner_id: string | null;
  record_type_id: string | null;
  currency_iso_code: string | null;
  created_by_id: string | null;
  created_date: string | Date;
  last_modified_by_id: string | null;
  last_modified_date: string | Date;
  is_deleted: boolean;
  deleted_date: string | Date | null;
  fields: Record<string, any>;
}

function parseFields(v: any): Record<string, any> {
  return typeof v === 'string' ? JSON.parse(v) : (v ?? {});
}

/** Flat API-name view of a stored row, as hooks, formulas and the API all expect it. */
export function rowToApi(obj: ObjectMeta, row: StoredRow): Record<string, any> {
  const fields = parseFields(row.fields);
  const out: Record<string, any> = {
    Id: row.id,
    OwnerId: row.owner_id,
    CreatedById: row.created_by_id,
    CreatedDate: row.created_date instanceof Date ? row.created_date.toISOString() : row.created_date,
    LastModifiedById: row.last_modified_by_id,
    LastModifiedDate:
      row.last_modified_date instanceof Date ? row.last_modified_date.toISOString() : row.last_modified_date,
    IsDeleted: row.is_deleted,
    CurrencyIsoCode: row.currency_iso_code
  };
  const nameField = obj.fields.get('name');
  if (nameField) out[nameField.apiName] = row.name;
  if (obj.recordTypes.length) out.RecordTypeId = row.record_type_id;
  for (const [k, v] of Object.entries(fields)) out[k] = v;
  return out;
}

function fieldByApi(obj: ObjectMeta, api: string): FieldMeta | undefined {
  return getField(obj, api);
}

/** Evaluate a field default: a formula if it parses as one, otherwise the literal text. */
function evaluateDefault(f: FieldMeta, ctx: RequestContext): unknown {
  if (!f.defaultValue) return null;
  const raw = f.defaultValue;
  try {
    const v = runFormula(raw, {
      get: (path) => {
        if (path === '$User.Id') return toFValue(ctx.userId, 'Text');
        return toFValue(null);
      },
      isNew: true
    });
    return fromFValue(v);
  } catch (e) {
    if (e instanceof FormulaError) return raw;
    throw e;
  }
}

/**
 * Allocate the next value in an auto-number sequence.
 *
 * UPDATE … RETURNING makes the increment atomic under concurrency: two transactions inserting at
 * once serialise on the row rather than both reading the same value.
 */
async function nextSequence(c: DbClient, key: string): Promise<number> {
  const prefKey = `autoNumberSeq:${key}`;
  const updated = await c.query<{ value: any }>(
    `UPDATE org_pref SET value = to_jsonb((value::text)::bigint + 1) WHERE key = $1 RETURNING value`,
    [prefKey]
  );
  if (updated.rows.length) return Number(updated.rows[0].value);
  await c.query(`INSERT INTO org_pref (key, value) VALUES ($1, '1') ON CONFLICT (key) DO NOTHING`, [prefKey]);
  const again = await c.query<{ value: any }>(
    `UPDATE org_pref SET value = to_jsonb((value::text)::bigint + 1) WHERE key = $1 RETURNING value`,
    [prefKey]
  );
  return again.rows.length ? Number(again.rows[0].value) : 1;
}

/** Split a flat API-name map into physical columns and the JSONB body. */
function partition(obj: ObjectMeta, values: Record<string, unknown>) {
  const columns: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [api, value] of Object.entries(values)) {
    const f = fieldByApi(obj, api);
    if (!f) continue;
    if (f.column && COLUMN_OF[f.column]) columns[f.column] = value;
    else if (!f.column) body[f.apiName] = value;
  }
  return { columns, body };
}

/* ------------------------------- validation ------------------------------- */

async function assertLookupsExist(
  c: DbClient,
  org: OrgMeta,
  obj: ObjectMeta,
  values: Record<string, unknown>
): Promise<void> {
  for (const [api, value] of Object.entries(values)) {
    if (value == null) continue;
    const f = fieldByApi(obj, api);
    if (!f || (f.type !== 'Lookup' && f.type !== 'MasterDetail')) continue;
    const id = String(value);

    const targets = !f.referenceTo || f.referenceTo === '*' ? null : f.referenceTo.split(',').map((t) => t.trim());
    let target: ObjectMeta | undefined;
    if (targets && targets.length === 1) {
      target = getObject(org, targets[0]);
    } else {
      // Polymorphic: resolve the object from the id's key prefix.
      target = org.byPrefix.get(id.slice(0, 3));
      if (target && targets && !targets.some((t) => t.toLowerCase() === target!.apiName.toLowerCase())) {
        throw Errors.crossOrg();
      }
    }
    if (!target) throw Errors.crossOrg();
    if (id.slice(0, 3) !== target.keyPrefix) throw Errors.malformedId(f.apiName, id);

    const found = await c.query(`SELECT 1 FROM ${tableFor(target.apiName)} WHERE id = $1 AND is_deleted = false`, [id]);
    if (!found.rows.length) throw Errors.crossOrg();
  }
}

async function assertUnique(
  c: DbClient,
  obj: ObjectMeta,
  values: Record<string, unknown>,
  excludeId: string | null
): Promise<void> {
  for (const f of obj.fieldList) {
    if (!(f.unique || f.externalId) || f.column) continue;
    const value = values[f.apiName];
    if (value == null) continue;
    const params: unknown[] = [String(value)];
    let sql = `SELECT id FROM ${tableFor(obj.apiName)} WHERE fields->>'${f.apiName}' = $1 AND is_deleted = false`;
    if (excludeId) {
      sql += ` AND id <> $2`;
      params.push(excludeId);
    }
    const clash = await c.query(sql, params);
    if (clash.rows.length) {
      throw Errors.duplicateValue(
        `duplicate value found: ${f.apiName} duplicates value on record with id: ${clash.rows[0].id}`
      );
    }
  }
}

function assertRequired(obj: ObjectMeta, values: Record<string, unknown>): void {
  const missing: string[] = [];
  for (const f of obj.fieldList) {
    if (!f.required || !isWritable(f)) continue;
    if (f.isNameField && (obj.nameFieldType === 'AutoNumber' || hasCompoundName(obj))) continue;
    const v = values[f.apiName];
    if (v == null || v === '') missing.push(f.apiName);
  }
  if (missing.length) throw Errors.requiredField(missing);
}

function assertRecordType(obj: ObjectMeta, values: Record<string, unknown>): void {
  const rt = values.RecordTypeId;
  if (rt == null) return;
  if (!obj.recordTypes.some((r) => r.id === rt && r.isActive)) {
    throw Errors.invalidValue('RecordTypeId', `record type id ${String(rt)} is not valid for ${obj.apiName}`);
  }
}

/**
 * Reject values the caller is not allowed to write, so a typo in a field name fails loudly rather
 * than being silently dropped into the JSONB body.
 */
function checkWritable(obj: ObjectMeta, input: Record<string, unknown>): void {
  for (const api of Object.keys(input)) {
    if (api === 'Id' || api === 'attributes') continue;
    const f = fieldByApi(obj, api);
    if (!f) throw Errors.invalidField(api, obj.apiName);
    if (!isWritable(f)) throw Errors.notWritable(f.apiName);
  }
}

/* --------------------------------- inserts -------------------------------- */

async function prepareInsert(
  c: DbClient,
  ctx: RequestContext,
  org: OrgMeta,
  obj: ObjectMeta,
  input: Record<string, any>
): Promise<{ id: string; values: Record<string, any> }> {
  checkWritable(obj, input);

  const values: Record<string, any> = {};
  for (const [api, raw] of Object.entries(input)) {
    if (api === 'Id' || api === 'attributes') continue;
    const f = fieldByApi(obj, api)!;
    values[f.apiName] = coerceValue(obj, f, raw);
  }

  for (const f of obj.fieldList) {
    if (values[f.apiName] !== undefined || !isWritable(f)) continue;
    if (f.defaultValue) {
      const d = evaluateDefault(f, ctx);
      if (d != null) values[f.apiName] = coerceValue(obj, f, d);
    } else if ((f.type === 'Picklist' || f.type === 'MultiselectPicklist') && f.picklist) {
      const def = f.picklist.find((p) => p.isDefault && p.isActive);
      if (def) values[f.apiName] = def.value;
    } else if (f.type === 'Checkbox') {
      values[f.apiName] = false;
    }
  }

  if (!values.OwnerId) values.OwnerId = ctx.userId;
  if (!values.CurrencyIsoCode) values.CurrencyIsoCode = org.settings.corporateCurrency;
  if (values.RecordTypeId == null && obj.recordTypes.length) {
    const def = obj.recordTypes.find((r) => r.isDefault && r.isActive);
    if (def) values.RecordTypeId = def.id;
  }

  const nameField = obj.fields.get('name');
  if (nameField) {
    if (hasCompoundName(obj)) {
      values[nameField.apiName] = composeName(obj, values);
    } else if (obj.nameFieldType === 'AutoNumber') {
      const seq = await nextSequence(c, obj.apiName);
      values[nameField.apiName] = formatAutoNumber(obj.autoNumberFormat ?? '{00000000}', seq);
    }
  }

  for (const f of obj.fieldList) {
    if (f.type !== 'AutoNumber' || f.isNameField) continue;
    const seq = await nextSequence(c, `${obj.apiName}.${f.apiName}`);
    values[f.apiName] = formatAutoNumber(f.defaultValue ?? '{00000000}', seq);
  }

  assertRequired(obj, values);
  assertRecordType(obj, values);
  await assertLookupsExist(c, org, obj, values);
  await assertUnique(c, obj, values, null);

  return { id: normalizeId(input.Id) ?? generateId(obj.keyPrefix), values };
}

async function writeInsert(
  c: DbClient,
  ctx: RequestContext,
  obj: ObjectMeta,
  id: string,
  values: Record<string, any>
): Promise<void> {
  const { columns, body } = partition(obj, values);
  await c.query(
    `INSERT INTO ${tableFor(obj.apiName)}
       (id, name, owner_id, record_type_id, currency_iso_code, created_by_id, last_modified_by_id, fields)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
    [
      id,
      columns.name ?? null,
      columns.owner_id ?? ctx.userId,
      columns.record_type_id ?? null,
      columns.currency_iso_code ?? null,
      ctx.userId,
      JSON.stringify(body)
    ]
  );
}

/* --------------------------------- updates -------------------------------- */

async function loadRows(c: DbClient, obj: ObjectMeta, ids: string[], includeDeleted = false): Promise<Map<string, StoredRow>> {
  if (!ids.length) return new Map();
  const res = await c.query<StoredRow>(
    `SELECT * FROM ${tableFor(obj.apiName)} WHERE id = ANY($1)${includeDeleted ? '' : ' AND is_deleted = false'} FOR UPDATE`,
    [ids]
  );
  return new Map(res.rows.map((r) => [r.id, r]));
}

async function prepareUpdate(
  c: DbClient,
  ctx: RequestContext,
  org: OrgMeta,
  obj: ObjectMeta,
  existing: StoredRow,
  input: Record<string, any>
): Promise<Record<string, any>> {
  checkWritable(obj, input);
  const merged = rowToApi(obj, existing);

  for (const [api, raw] of Object.entries(input)) {
    if (api === 'Id' || api === 'attributes') continue;
    const f = fieldByApi(obj, api)!;
    merged[f.apiName] = coerceValue(obj, f, raw);
  }

  const nameField = obj.fields.get('name');
  if (nameField && hasCompoundName(obj)) merged[nameField.apiName] = composeName(obj, merged);

  assertRequired(obj, merged);
  assertRecordType(obj, merged);
  await assertLookupsExist(c, org, obj, pick(merged, Object.keys(input)));
  await assertUnique(c, obj, pick(merged, Object.keys(input)), existing.id);
  return merged;
}

function pick(source: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (k in source) out[k] = source[k];
  return out;
}

async function writeUpdate(
  c: DbClient,
  ctx: RequestContext,
  obj: ObjectMeta,
  id: string,
  values: Record<string, any>
): Promise<void> {
  const { columns, body } = partition(obj, values);
  await c.query(
    `UPDATE ${tableFor(obj.apiName)}
        SET name = $2, owner_id = $3, record_type_id = $4, currency_iso_code = $5,
            fields = $6, last_modified_by_id = $7, last_modified_date = now(), system_modstamp = now()
      WHERE id = $1`,
    [
      id,
      columns.name ?? null,
      columns.owner_id ?? null,
      columns.record_type_id ?? null,
      columns.currency_iso_code ?? null,
      JSON.stringify(body),
      ctx.userId
    ]
  );
}

/* --------------------------------- deletes -------------------------------- */

/**
 * Delete a record into the recycle bin, cascading master-detail children and refusing when a
 * restrict-delete child still points at it.
 */
async function deleteCascade(
  c: DbClient,
  ctx: RequestContext,
  org: OrgMeta,
  obj: ObjectMeta,
  ids: string[],
  deletedAt: string,
  seen = new Set<string>()
): Promise<number> {
  if (!ids.length) return 0;
  let count = 0;
  // Guard against a self-referencing master-detail chain recursing forever.
  ids.forEach((id) => seen.add(id));

  for (const rel of obj.childRelationships) {
    const child = getObject(org, rel.childObject);
    if (!child) continue;
    const childRows = await c.query<{ id: string }>(
      `SELECT id FROM ${tableFor(child.apiName)}
        WHERE fields->>'${rel.field}' = ANY($1) AND is_deleted = false`,
      [ids]
    );
    if (!childRows.rows.length) continue;

    if (rel.restrictDelete) {
      throw Errors.deleteFailed(
        `Your attempt to delete a ${obj.label} could not be completed because it is associated with the following ${child.pluralLabel}: ${childRows.rows
          .slice(0, 5)
          .map((r) => r.id)
          .join(', ')}`
      );
    }
    if (rel.cascadeDelete) {
      const childIds = childRows.rows.map((r) => r.id).filter((id) => !seen.has(id));
      childIds.forEach((id) => seen.add(id));
      count += await deleteCascade(c, ctx, org, child, childIds, deletedAt, seen);
    } else {
      // Plain lookup: clear the reference rather than orphan a dangling id.
      await c.query(
        `UPDATE ${tableFor(child.apiName)}
            SET fields = fields - '${rel.field}', last_modified_date = now(), system_modstamp = now()
          WHERE fields->>'${rel.field}' = ANY($1) AND is_deleted = false`,
        [ids]
      );
    }
  }

  const res = await c.query(
    `UPDATE ${tableFor(obj.apiName)}
        SET is_deleted = true, deleted_date = $2, last_modified_by_id = $3,
            last_modified_date = now(), system_modstamp = now()
      WHERE id = ANY($1) AND is_deleted = false`,
    [ids, deletedAt, ctx.userId]
  );
  return count + res.rowCount;
}

/* ------------------------------ public surface ---------------------------- */

function toResult(id: string, created: boolean): SaveResult {
  return { id, success: true, created, errors: [] };
}

function toFailure(id: string, err: unknown): SaveResult {
  const e = err instanceof SfError ? err : new SfError('UNKNOWN_EXCEPTION', String((err as Error)?.message ?? err), 500);
  return { id, success: false, created: false, errors: e.toBody() };
}

async function resolveObject(ctx: RequestContext, objectApi: string): Promise<{ org: OrgMeta; obj: ObjectMeta }> {
  const org = await ctx.orgMeta();
  const obj = getObject(org, objectApi);
  if (!obj) throw Errors.invalidType(objectApi);
  return { org, obj };
}

/**
 * Run the save order for one batch of records against one object.
 *
 * Order follows Salesforce: prepare and system-validate, before-save hooks, validation rules,
 * write, after-save automation, then side effects — all inside one transaction, with after-commit
 * work fired only once the transaction has actually landed.
 */
async function runSave(
  ctx: RequestContext,
  objectApi: string,
  operation: Extract<DmlOperation, 'insert' | 'update'>,
  records: Record<string, any>[],
  opts: DmlOptions
): Promise<SaveResult[]> {
  const allOrNone = opts.allOrNone ?? true;
  const { org, obj } = await resolveObject(ctx, objectApi);

  await assertObjectAccess(ctx, obj, operation === 'insert' ? 'create' : 'edit');
  for (const record of records) {
    await assertFieldsEditable(ctx, obj, Object.keys(record));
  }

  ctx.limits.consume('dmlStatements');
  ctx.limits.consume('dmlRows', records.length);

  const results: SaveResult[] = new Array(records.length);
  let committed: DmlEvent | null = null;

  await withTransaction(ctx, opts, async (c) => {
    {
      const changes: RecordChange[] = [];
      const targetIds = records.map((r) => normalizeId(r.Id) ?? '').filter(Boolean);
      const existingRows = operation === 'update' ? await loadRows(c, obj, targetIds) : new Map<string, StoredRow>();
      if (operation === 'update') await assertRecordsWritable(ctx, c, obj, [...existingRows.keys()]);

      for (let i = 0; i < records.length; i++) {
        const input = records[i];
        const savepoint = `sp_${i}`;
        if (!allOrNone) await c.query(`SAVEPOINT ${savepoint}`);
        try {
          if (operation === 'insert') {
            const { id, values } = await prepareInsert(c, ctx, org, obj, input);
            changes.push({ id, before: null, after: values, input, updates: {} });
            results[i] = toResult(id, true);
          } else {
            const id = normalizeId(input.Id);
            if (!id) throw Errors.malformedId('Id', String(input.Id ?? ''));
            const existing = existingRows.get(id);
            if (!existing) throw Errors.notFound(`Provided external ID field does not exist or is not accessible: ${id}`);
            const before = rowToApi(obj, existing);
            const after = await prepareUpdate(c, ctx, org, obj, existing, input);
            changes.push({ id, before, after, input, updates: {} });
            results[i] = toResult(id, false);
          }
          if (!allOrNone) await c.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (err) {
          if (allOrNone) throw err;
          await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          results[i] = toFailure(normalizeId(input.Id) ?? '', err);
        }
      }

      if (!changes.length) return;
      const event: DmlEvent = { ctx, client: c, object: obj, operation, changes };

      if (!opts.skipAutomation) {
        await runStage('beforeSave', event);
        for (const change of changes) {
          if (!Object.keys(change.updates).length) continue;
          for (const [api, raw] of Object.entries(change.updates)) {
            const f = fieldByApi(obj, api);
            if (!f || !isWritable(f)) throw Errors.notWritable(api);
            change.after![f.apiName] = coerceValue(obj, f, raw);
          }
          change.updates = {};
        }
        await runStage('validate', event);
      }

      for (const change of changes) {
        if (operation === 'insert') await writeInsert(c, ctx, obj, change.id, change.after!);
        else await writeUpdate(c, ctx, obj, change.id, change.after!);
      }

      if (!opts.skipAutomation) {
        await runStage('afterSave', event);
        await runStage('sideEffects', event);
      }
      committed = event;
    }
  });

  // When the caller owns the transaction, after-commit work is theirs to fire once it lands.
  if (committed && !opts.skipAutomation && !opts.client) await runStage('afterCommit', committed);
  return results;
}

export function insertRecords(
  ctx: RequestContext,
  objectApi: string,
  records: Record<string, any>[],
  opts: DmlOptions = {}
): Promise<SaveResult[]> {
  return runSave(ctx, objectApi, 'insert', records, opts);
}

export function updateRecords(
  ctx: RequestContext,
  objectApi: string,
  records: Record<string, any>[],
  opts: DmlOptions = {}
): Promise<SaveResult[]> {
  return runSave(ctx, objectApi, 'update', records, opts);
}

/** Insert one record, returning its id — the shape the REST sObject endpoint wants. */
export async function insertRecord(
  ctx: RequestContext,
  objectApi: string,
  record: Record<string, any>,
  opts: DmlOptions = {}
): Promise<string> {
  const [result] = await insertRecords(ctx, objectApi, [record], opts);
  if (!result.success) throw new SfError(result.errors[0].errorCode, result.errors[0].message, 400, result.errors[0].fields);
  return result.id;
}

export async function updateRecord(
  ctx: RequestContext,
  objectApi: string,
  id: string,
  record: Record<string, any>,
  opts: DmlOptions = {}
): Promise<void> {
  const [result] = await updateRecords(ctx, objectApi, [{ ...record, Id: id }], opts);
  if (!result.success) throw new SfError(result.errors[0].errorCode, result.errors[0].message, 400, result.errors[0].fields);
}

/** Upsert by external id field: matches on the field, inserts when nothing matches. */
export async function upsertRecord(
  ctx: RequestContext,
  objectApi: string,
  externalIdField: string,
  externalId: string,
  record: Record<string, any>,
  opts: DmlOptions = {}
): Promise<SaveResult> {
  const { obj } = await resolveObject(ctx, objectApi);
  const f = fieldByApi(obj, externalIdField);
  if (!f) throw Errors.invalidField(externalIdField, obj.apiName);
  if (!f.externalId && !f.unique) {
    throw Errors.invalidOperation(`${externalIdField} is not an External ID or unique field`);
  }

  const match = await ctx.tenant((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM ${tableFor(obj.apiName)} WHERE fields->>'${f.apiName}' = $1 AND is_deleted = false`,
      [externalId]
    )
  );
  if (match.rows.length > 1) {
    throw new SfError('MULTIPLE_CHOICES', `Multiple records matched the external id ${externalId}`, 300);
  }

  if (match.rows.length === 1) {
    const [result] = await updateRecords(ctx, objectApi, [{ ...record, Id: match.rows[0].id }], opts);
    return result;
  }
  const [result] = await insertRecords(ctx, objectApi, [{ ...record, [f.apiName]: externalId }], opts);
  return result;
}

/** Move records to the recycle bin, cascading master-detail children. */
export async function deleteRecords(
  ctx: RequestContext,
  objectApi: string,
  ids: string[],
  opts: DmlOptions = {}
): Promise<SaveResult[]> {
  const { org, obj } = await resolveObject(ctx, objectApi);
  await assertObjectAccess(ctx, obj, 'remove');
  ctx.limits.consume('dmlStatements');
  ctx.limits.consume('dmlRows', ids.length);

  const normalized = ids.map((id) => normalizeId(id));
  const results: SaveResult[] = [];
  let committed: DmlEvent | null = null;

  await withTransaction(ctx, opts, async (c) => {
    {
      const valid = normalized.filter((id): id is string => !!id);
      const rows = await loadRows(c, obj, valid);
      await assertRecordsWritable(ctx, c, obj, [...rows.keys()]);
      const changes: RecordChange[] = [];

      for (let i = 0; i < normalized.length; i++) {
        const id = normalized[i];
        if (!id || !rows.has(id)) {
          results.push(toFailure(id ?? String(ids[i]), Errors.notFound(`entity is deleted or does not exist: ${ids[i]}`)));
          continue;
        }
        changes.push({ id, before: rowToApi(obj, rows.get(id)!), after: null, input: {}, updates: {} });
        results.push(toResult(id, false));
      }
      if (!changes.length) return;

      const event: DmlEvent = { ctx, client: c, object: obj, operation: 'delete', changes };
      if (!opts.skipAutomation) await runStage('beforeSave', event);

      await deleteCascade(c, ctx, org, obj, changes.map((ch) => ch.id), new Date().toISOString());

      if (!opts.skipAutomation) {
        await runStage('afterSave', event);
        await runStage('sideEffects', event);
      }
      committed = event;
    }
  });

  if (committed && !opts.skipAutomation && !opts.client) await runStage('afterCommit', committed);
  return results;
}

/** Restore records from the recycle bin, along with anything cascaded away with them. */
export async function undeleteRecords(
  ctx: RequestContext,
  objectApi: string,
  ids: string[],
  opts: DmlOptions = {}
): Promise<SaveResult[]> {
  const { org, obj } = await resolveObject(ctx, objectApi);
  ctx.limits.consume('dmlStatements');
  ctx.limits.consume('dmlRows', ids.length);

  const results: SaveResult[] = [];
  await ctx.tenant(async (c) => {
    await inTransaction(c, async () => {
      for (const raw of ids) {
        const id = normalizeId(raw);
        const row = id
          ? (await c.query<StoredRow>(`SELECT * FROM ${tableFor(obj.apiName)} WHERE id = $1 AND is_deleted = true`, [id]))
              .rows[0]
          : undefined;
        if (!id || !row) {
          results.push(toFailure(id ?? String(raw), Errors.notFound(`entity is not in the recycle bin: ${raw}`)));
          continue;
        }
        await c.query(
          `UPDATE ${tableFor(obj.apiName)}
              SET is_deleted = false, deleted_date = NULL, last_modified_by_id = $2,
                  last_modified_date = now(), system_modstamp = now()
            WHERE id = $1`,
          [id, ctx.userId]
        );
        // Restore children that were cascaded away in the same delete.
        for (const rel of obj.childRelationships) {
          if (!rel.cascadeDelete) continue;
          const child = getObject(org, rel.childObject);
          if (!child) continue;
          await c.query(
            `UPDATE ${tableFor(child.apiName)}
                SET is_deleted = false, deleted_date = NULL, last_modified_date = now(), system_modstamp = now()
              WHERE fields->>'${rel.field}' = $1 AND is_deleted = true AND deleted_date = $2`,
            [id, row.deleted_date]
          );
        }
        results.push(toResult(id, false));
      }
    });
  });
  return results;
}

/** Read one record as a flat API-name map, or null when it does not exist. */
export async function getRecord(
  ctx: RequestContext,
  objectApi: string,
  id: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<Record<string, any> | null> {
  const { obj } = await resolveObject(ctx, objectApi);
  const access = await assertObjectAccess(ctx, obj, 'read');
  const normalized = normalizeId(id);
  if (!normalized) throw Errors.malformedId('Id', id);

  // Row-level sharing is enforced in the query, not after it: an unreadable record must be
  // indistinguishable from one that does not exist.
  const predicate = await readPredicateFor(ctx, obj, 't', 2);
  ctx.limits.consume('soqlQueries');
  const res = await ctx.tenant((c) =>
    c.query<StoredRow>(
      `SELECT t.* FROM ${tableFor(obj.apiName)} t WHERE t.id = $1${
        opts.includeDeleted ? '' : ' AND t.is_deleted = false'
      }${predicate ? ` AND ${predicate.sql}` : ''}`,
      [normalized, ...(predicate?.params ?? [])]
    )
  );
  if (!res.rows.length) return null;
  ctx.limits.consume('queryRows');
  return stripUnreadableFields(access, obj, rowToApi(obj, res.rows[0]));
}

/** Permanently remove recycle-bin records older than the retention window. */
export async function purgeRecycleBin(ctx: RequestContext, olderThanDays = 15): Promise<number> {
  const org = await ctx.orgMeta();
  let purged = 0;
  await ctx.tenant(async (c) => {
    for (const obj of org.objectList) {
      const res = await c.query(
        `DELETE FROM ${tableFor(obj.apiName)}
          WHERE is_deleted = true AND deleted_date < now() - ($1 || ' days')::interval`,
        [String(olderThanDays)]
      );
      purged += res.rowCount;
    }
  });
  return purged;
}
