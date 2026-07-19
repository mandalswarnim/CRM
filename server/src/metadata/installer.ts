import type { DbClient } from '../db/index.js';
import { generateId, KEY_PREFIXES, nextCustomPrefix } from '../util/ids.js';
import { SfError } from '../util/errors.js';
import { createDataTable, createFieldIndex } from './storage.js';
import { parseFormula } from '../formula/engine.js';
import type { FieldType, RollupSpec } from './types.js';

/* Declarative specs used by both standard-object definitions and the Setup API. */

export interface PicklistSpec {
  values: Array<string | { value: string; label?: string; default?: boolean; color?: string; meta?: Record<string, any> }>;
  restricted?: boolean;
}

export interface FieldSpec {
  apiName: string;
  label: string;
  type: FieldType;
  length?: number;
  precision?: number;
  scale?: number;
  required?: boolean;
  unique?: boolean;
  externalId?: boolean;
  defaultValue?: string;
  formula?: string;
  formulaReturnType?: 'Text' | 'Number' | 'Currency' | 'Percent' | 'Checkbox' | 'Date' | 'DateTime';
  rollup?: RollupSpec;
  referenceTo?: string;
  relationshipName?: string;
  isMasterDetail?: boolean;
  cascadeDelete?: boolean;
  restrictDelete?: boolean;
  picklist?: PicklistSpec;
  controllingField?: string;
  dependencyMap?: Record<string, string[]>;
  trackHistory?: boolean;
  helpText?: string;
  sortOrder?: number;
}

export interface ListViewSpec {
  apiName: string;
  label: string;
  columns: string[];
  filters?: { field: string; op: string; value: any }[];
  filterLogic?: string;
  scope?: string;
  sort?: { field: string; dir: 'asc' | 'desc' };
  kanban?: { groupField: string; sumField?: string };
}

export interface LayoutSectionSpec {
  label: string;
  columns?: 1 | 2;
  fields: Array<string | { blank: true }>;
}

export interface RelatedListSpec {
  objectApi: string;
  relationshipField: string;
  label?: string;
  columns?: string[];
}

export interface RecordTypeSpec {
  apiName: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  picklistOverrides?: Record<string, { values: string[]; default?: string }>;
}

export interface ObjectSpec {
  apiName: string;
  label: string;
  pluralLabel: string;
  keyPrefix?: string;
  isCustom?: boolean;
  description?: string;
  sharingModel?: 'Private' | 'Read' | 'ReadWrite' | 'ControlledByParent';
  nameFieldLabel?: string;
  nameFieldApi?: string;
  nameFieldType?: 'Text' | 'AutoNumber';
  autoNumberFormat?: string;
  icon?: string;
  color?: string;
  feedEnabled?: boolean;
  historyEnabled?: boolean;
  activitiesEnabled?: boolean;
  searchEnabled?: boolean;
  reportsEnabled?: boolean;
  fields: FieldSpec[];
  listViews?: ListViewSpec[];
  layoutSections?: LayoutSectionSpec[];
  relatedLists?: RelatedListSpec[];
  highlights?: string[];
  recordTypes?: RecordTypeSpec[];
  validationRules?: Array<{ apiName: string; formula: string; errorMessage: string; errorField?: string; description?: string; active?: boolean }>;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function assertApiName(name: string, what: string): void {
  if (!NAME_RE.test(name)) {
    throw new SfError('INVALID_FIELD', `Invalid API name for ${what}: '${name}'`, 400);
  }
}

/** Long-text and rich-text live only in the body; certain types get default lengths. */
function defaultLength(type: FieldType, len?: number): number | null {
  if (len) return len;
  switch (type) {
    case 'Text':
    case 'Email':
    case 'Phone':
    case 'Url':
      return 255;
    case 'TextArea':
      return 255;
    case 'LongTextArea':
    case 'RichText':
      return 32768;
    default:
      return null;
  }
}

export async function ensurePicklistSet(
  c: DbClient,
  name: string,
  spec: PicklistSpec
): Promise<string> {
  const setId = generateId('012');
  await c.query(`INSERT INTO picklist_set (id, name) VALUES ($1, $2)`, [setId, name]);
  let order = 0;
  for (const v of spec.values) {
    const item = typeof v === 'string' ? { value: v } : v;
    await c.query(
      `INSERT INTO picklist_value (id, set_id, value, label, is_active, is_default, sort_order, color, meta)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8)`,
      [
        generateId('012'),
        setId,
        item.value,
        item.label ?? item.value,
        !!item.default,
        order++,
        item.color ?? null,
        JSON.stringify(item.meta ?? {})
      ]
    );
  }
  return setId;
}

async function insertFieldDef(
  c: DbClient,
  objectId: string,
  objectApi: string,
  f: FieldSpec,
  isCustomObject: boolean
): Promise<string> {
  assertApiName(f.apiName, `field on ${objectApi}`);
  const isCustomField = f.apiName.endsWith('__c') || isCustomObject === true;
  if (f.type === 'Formula' && f.formula) {
    parseFormula(f.formula); // fail fast on bad formulas
    if (!f.formulaReturnType) throw new SfError('INVALID_FIELD', `Formula field ${f.apiName} needs a return type`, 400);
  }
  if ((f.type === 'Lookup' || f.type === 'MasterDetail') && !f.referenceTo) {
    throw new SfError('INVALID_FIELD', `Relationship field ${f.apiName} needs referenceTo`, 400);
  }
  if (f.type === 'RollupSummary' && !f.rollup) {
    throw new SfError('INVALID_FIELD', `Rollup field ${f.apiName} needs a rollup spec`, 400);
  }
  let picklistSetId: string | null = null;
  if ((f.type === 'Picklist' || f.type === 'MultiselectPicklist') && f.picklist) {
    picklistSetId = await ensurePicklistSet(c, `${objectApi}.${f.apiName}`, f.picklist);
  }
  const isMasterDetail = f.isMasterDetail ?? f.type === 'MasterDetail';
  const id = generateId(KEY_PREFIXES.CustomFieldDef);
  await c.query(
    `INSERT INTO field_def (
       id, object_id, api_name, label, type, length, precision, scale,
       is_required, is_unique, is_external_id, default_value, formula, formula_return_type,
       rollup, reference_to, relationship_name, is_master_detail, cascade_delete, restrict_delete,
       picklist_set_id, restricted_picklist, controlling_field, dependency_map,
       track_history, is_custom, is_name_field, help_text, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
    [
      id,
      objectId,
      f.apiName,
      f.label,
      f.type,
      defaultLength(f.type, f.length),
      f.precision ?? null,
      f.scale ?? null,
      !!f.required,
      !!f.unique,
      !!f.externalId,
      f.defaultValue ?? null,
      f.formula ?? null,
      f.formulaReturnType ?? null,
      f.rollup ? JSON.stringify(f.rollup) : null,
      f.referenceTo ?? null,
      f.relationshipName ?? null,
      isMasterDetail,
      !!(f.cascadeDelete || isMasterDetail),
      !!f.restrictDelete,
      picklistSetId,
      f.picklist?.restricted !== false,
      f.controllingField ?? null,
      f.dependencyMap ? JSON.stringify(f.dependencyMap) : null,
      !!f.trackHistory,
      isCustomField,
      false,
      f.helpText ?? null,
      f.sortOrder ?? 0
    ]
  );
  // Physical indexes for relationship/unique/external-id fields.
  if (f.type === 'Lookup' || f.type === 'MasterDetail') {
    await createFieldIndex(c, objectApi, f.apiName);
  }
  if (f.unique || f.externalId) {
    await createFieldIndex(c, objectApi, f.apiName, { unique: !!f.unique });
  }
  return id;
}

/** Auto-generate a sensible default record layout when the spec doesn't provide one. */
function generateLayoutSections(spec: ObjectSpec): LayoutSectionSpec[] {
  if (spec.layoutSections) return spec.layoutSections;
  const nameApi = spec.nameFieldApi ?? 'Name';
  const long: string[] = [];
  const normal: string[] = [];
  for (const f of spec.fields) {
    if (f.type === 'LongTextArea' || f.type === 'RichText') long.push(f.apiName);
    else normal.push(f.apiName);
  }
  const sections: LayoutSectionSpec[] = [
    { label: 'Information', columns: 2, fields: [nameApi, 'OwnerId', ...normal] }
  ];
  if (long.length) sections.push({ label: 'Description Information', columns: 1, fields: long });
  sections.push({ label: 'System Information', columns: 2, fields: ['CreatedById', 'LastModifiedById'] });
  return sections;
}

export interface InstallResult {
  objectId: string;
  layoutId: string;
}

/**
 * Install an object end-to-end: definition, fields (+picklists), data table,
 * indexes, default layout + compact layout, list views, record types,
 * validation rules, sharing default.
 */
export async function installObject(c: DbClient, spec: ObjectSpec): Promise<InstallResult> {
  assertApiName(spec.apiName.replace(/__c$/, ''), `object`);
  const isCustom = spec.isCustom ?? spec.apiName.endsWith('__c');

  let keyPrefix = spec.keyPrefix ?? KEY_PREFIXES[spec.apiName];
  if (!keyPrefix) {
    const existing = await c.query(`SELECT key_prefix FROM object_def`);
    keyPrefix = nextCustomPrefix(existing.rows.map((r: any) => r.key_prefix));
  }

  const objectId = generateId(KEY_PREFIXES.CustomObjectDef);
  await c.query(
    `INSERT INTO object_def (
       id, api_name, label, plural_label, key_prefix, is_custom, description, sharing_model,
       feed_enabled, history_enabled, activities_enabled, search_enabled, reports_enabled,
       name_field_label, name_field_type, auto_number_format, icon, color)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      objectId,
      spec.apiName,
      spec.label,
      spec.pluralLabel,
      keyPrefix,
      isCustom,
      spec.description ?? null,
      spec.sharingModel ?? 'ReadWrite',
      spec.feedEnabled ?? true,
      spec.historyEnabled ?? true,
      spec.activitiesEnabled ?? true,
      spec.searchEnabled ?? true,
      spec.reportsEnabled ?? true,
      spec.nameFieldLabel ?? (spec.nameFieldApi === 'Subject' ? 'Subject' : 'Name'),
      spec.nameFieldType ?? 'Text',
      spec.autoNumberFormat ?? null,
      spec.icon ?? null,
      spec.color ?? null
    ]
  );
  // Store the name-field API name (CaseNumber / Subject) in the label row via org convention:
  if (spec.nameFieldApi && spec.nameFieldApi !== 'Name') {
    await c.query(`UPDATE object_def SET name_field_label = $2 WHERE id = $1`, [
      objectId,
      spec.nameFieldLabel ?? spec.nameFieldApi
    ]);
    await c.query(
      `INSERT INTO org_pref (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`nameFieldApi:${spec.apiName}`, JSON.stringify(spec.nameFieldApi)]
    );
  }

  await createDataTable(c, spec.apiName);

  for (const f of spec.fields) {
    await insertFieldDef(c, objectId, spec.apiName, f, isCustom);
  }

  for (const rt of spec.recordTypes ?? []) {
    await c.query(
      `INSERT INTO record_type_def (id, object_id, api_name, label, description, is_active, is_default, picklist_overrides)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
      [
        generateId(KEY_PREFIXES.RecordType),
        objectId,
        rt.apiName,
        rt.label,
        rt.description ?? null,
        !!rt.isDefault,
        JSON.stringify(rt.picklistOverrides ?? {})
      ]
    );
  }

  for (const vr of spec.validationRules ?? []) {
    parseFormula(vr.formula);
    await c.query(
      `INSERT INTO validation_rule (id, object_id, api_name, active, formula, error_message, error_field, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        generateId(KEY_PREFIXES.ValidationRule),
        objectId,
        vr.apiName,
        vr.active ?? true,
        vr.formula,
        vr.errorMessage,
        vr.errorField ?? null,
        vr.description ?? null
      ]
    );
  }

  // Default record layout + compact layout.
  const layoutId = generateId(KEY_PREFIXES.Layout);
  const nameApi = spec.nameFieldApi ?? 'Name';
  const sections = generateLayoutSections(spec);
  const relatedLists =
    spec.relatedLists ??
    []; // populated on demand by the UI from child relationships when empty
  await c.query(
    `INSERT INTO layout_def (id, object_id, name, kind, sections, related_lists, highlights, actions, is_default)
     VALUES ($1,$2,$3,'record',$4,$5,$6,$7,true)`,
    [
      layoutId,
      objectId,
      `${spec.label} Layout`,
      JSON.stringify(sections),
      JSON.stringify(relatedLists),
      JSON.stringify(spec.highlights ?? [nameApi, 'OwnerId', 'CreatedDate']),
      JSON.stringify([])
    ]
  );

  // Default list views.
  const cols = [nameApi, ...spec.fields.slice(0, 4).map((f) => f.apiName)];
  const views: ListViewSpec[] =
    spec.listViews ?? [
      { apiName: 'All', label: `All ${spec.pluralLabel}`, columns: cols, scope: 'everything' },
      { apiName: 'My', label: `My ${spec.pluralLabel}`, columns: cols, scope: 'mine' }
    ];
  for (const v of views) {
    await c.query(
      `INSERT INTO list_view_def (id, object_id, api_name, label, columns, filters, filter_logic, scope, sort, visibility, kanban)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'shared',$10)`,
      [
        generateId(KEY_PREFIXES.ListView),
        objectId,
        v.apiName,
        v.label,
        JSON.stringify(v.columns),
        JSON.stringify(v.filters ?? []),
        v.filterLogic ?? null,
        v.scope ?? 'everything',
        v.sort ? JSON.stringify(v.sort) : null,
        v.kanban ? JSON.stringify(v.kanban) : null
      ]
    );
  }

  await c.query(
    `INSERT INTO sharing_setting (object_api, internal_access, grant_access_using_hierarchies)
     VALUES ($1,$2,true) ON CONFLICT (object_api) DO NOTHING`,
    [spec.apiName, spec.sharingModel ?? 'ReadWrite']
  );

  return { objectId, layoutId };
}

/** Add a field to an existing object (Setup API). */
export async function addField(c: DbClient, objectApi: string, f: FieldSpec): Promise<string> {
  const obj = await c.query(`SELECT id, is_custom FROM object_def WHERE lower(api_name) = lower($1)`, [objectApi]);
  if (!obj.rows[0]) throw new SfError('INVALID_TYPE', `No such object ${objectApi}`, 404);
  const dupe = await c.query(
    `SELECT 1 FROM field_def WHERE object_id = $1 AND lower(api_name) = lower($2)`,
    [obj.rows[0].id, f.apiName]
  );
  if (dupe.rows.length) throw new SfError('DUPLICATE_DEVELOPER_NAME', `Field ${f.apiName} already exists`, 400);
  return insertFieldDef(c, obj.rows[0].id, objectApi, f, obj.rows[0].is_custom);
}
