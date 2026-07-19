import type { DbClient, Db } from '../db/index.js';
import { withTenantClient } from '../db/index.js';
import type { FieldMeta, ObjectMeta, OrgMeta, PicklistValueMeta } from './types.js';
import { SYSTEM_FIELD_SPECS } from './types.js';

/** Physical table name for an object API name (deterministic, schema-safe). */
export function tableFor(apiName: string): string {
  let t = 'd_' + apiName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (t.length > 60) {
    let hash = 0;
    for (const ch of apiName) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    t = t.slice(0, 52) + '_' + hash.toString(36);
  }
  return t;
}

const cache = new Map<string, OrgMeta>();
const versions = new Map<string, number>();

export function invalidateOrgMeta(orgId: string): void {
  cache.delete(orgId);
  versions.set(orgId, (versions.get(orgId) ?? 0) + 1);
}

export async function loadOrgMeta(db: Db, orgId: string, schema: string): Promise<OrgMeta> {
  const cached = cache.get(orgId);
  if (cached) return cached;
  const meta = await withTenantClient(db, schema, (c) => buildOrgMeta(c, orgId, schema));
  cache.set(orgId, meta);
  return meta;
}

/** Build the full in-memory model from the tenant's metadata tables. */
export async function buildOrgMeta(c: DbClient, orgId: string, schema: string): Promise<OrgMeta> {
  const [objects, fields, picklists, recordTypes, validations, currencies, orgRow, prefs] = await Promise.all([
    c.query(`SELECT * FROM object_def ORDER BY api_name`),
    c.query(`SELECT * FROM field_def ORDER BY sort_order, api_name`),
    c.query(
      `SELECT v.*, v.set_id FROM picklist_value v ORDER BY v.sort_order, v.label`
    ),
    c.query(`SELECT * FROM record_type_def ORDER BY label`),
    c.query(`SELECT * FROM validation_rule ORDER BY api_name`),
    c.query(`SELECT * FROM currency_type`),
    c.query(`SELECT * FROM sys.orgs WHERE id = $1`, [orgId]),
    c.query(`SELECT key, value FROM org_pref WHERE key LIKE 'nameFieldApi:%'`)
  ]);

  // Per-object override of the name field's API name (Case→CaseNumber, Task→Subject).
  const nameFieldApis = new Map<string, string>();
  for (const row of prefs.rows) {
    nameFieldApis.set(row.key.slice('nameFieldApi:'.length).toLowerCase(), JSON.parse(JSON.stringify(row.value)));
  }

  const picklistBySet = new Map<string, PicklistValueMeta[]>();
  for (const row of picklists.rows) {
    const list = picklistBySet.get(row.set_id) ?? [];
    list.push({
      value: row.value,
      label: row.label,
      isActive: row.is_active,
      isDefault: row.is_default,
      color: row.color,
      meta: row.meta ?? {}
    });
    picklistBySet.set(row.set_id, list);
  }

  const objById = new Map<string, ObjectMeta>();
  const org: OrgMeta = {
    orgId,
    schema,
    version: versions.get(orgId) ?? 0,
    objects: new Map(),
    objectList: [],
    byPrefix: new Map(),
    settings: {
      defaultLanguage: orgRow.rows[0]?.default_language ?? 'en_US',
      defaultLocale: orgRow.rows[0]?.default_locale ?? 'en_GB',
      defaultTimezone: orgRow.rows[0]?.default_timezone ?? 'Europe/London',
      corporateCurrency: orgRow.rows[0]?.corporate_currency ?? 'GBP',
      multiCurrency: orgRow.rows[0]?.multi_currency ?? true,
      name: orgRow.rows[0]?.name ?? 'Org',
      isSandbox: orgRow.rows[0]?.is_sandbox ?? false
    },
    currencies: currencies.rows.map((r: any) => ({
      isoCode: r.iso_code,
      rate: Number(r.conversion_rate),
      decimals: r.decimal_places,
      active: r.is_active,
      corporate: r.is_corporate
    }))
  };

  for (const row of objects.rows) {
    const obj: ObjectMeta = {
      id: row.id,
      apiName: row.api_name,
      label: row.label,
      pluralLabel: row.plural_label,
      keyPrefix: row.key_prefix,
      isCustom: row.is_custom,
      description: row.description,
      sharingModel: row.sharing_model,
      feedEnabled: row.feed_enabled,
      historyEnabled: row.history_enabled,
      activitiesEnabled: row.activities_enabled,
      searchEnabled: row.search_enabled,
      reportsEnabled: row.reports_enabled,
      isQueryable: row.is_queryable,
      nameFieldLabel: row.name_field_label,
      nameFieldType: row.name_field_type,
      autoNumberFormat: row.auto_number_format,
      icon: row.icon,
      color: row.color,
      table: tableFor(row.api_name),
      fields: new Map(),
      fieldList: [],
      childRelationships: [],
      recordTypes: [],
      validationRules: []
    };
    objById.set(obj.id, obj);
    org.objects.set(obj.apiName.toLowerCase(), obj);
    org.objectList.push(obj);
    org.byPrefix.set(obj.keyPrefix, obj);
  }

  // System fields first, uniform across objects.
  for (const obj of org.objectList) {
    for (const spec of SYSTEM_FIELD_SPECS) {
      if (spec.skipFor?.includes(obj.apiName)) continue;
      if (spec.apiName === 'RecordTypeId') continue; // added only if record types exist (below)
      const f: FieldMeta = {
        id: obj.id + ':' + spec.apiName,
        apiName: spec.apiName,
        label: spec.label,
        type: spec.type,
        required: spec.apiName === 'Id',
        unique: false,
        externalId: false,
        isMasterDetail: false,
        cascadeDelete: false,
        restrictDelete: false,
        restrictedPicklist: false,
        trackHistory: false,
        isCustom: false,
        isNameField: false,
        isSystem: true,
        sortOrder: -100,
        column: spec.column,
        referenceTo: spec.referenceTo ?? null,
        relationshipName: spec.relationshipName ?? null
      };
      obj.fields.set(f.apiName.toLowerCase(), f);
      obj.fieldList.push(f);
    }
    // Name (or AutoNumber name) physical column; API name may differ (CaseNumber, Subject).
    const nameApi = nameFieldApis.get(obj.apiName.toLowerCase()) ?? 'Name';
    const nameField: FieldMeta = {
      id: obj.id + ':Name',
      apiName: nameApi,
      label: obj.nameFieldLabel,
      type: obj.nameFieldType === 'AutoNumber' ? 'AutoNumber' : 'Text',
      length: 255,
      required: obj.nameFieldType !== 'AutoNumber',
      unique: false,
      externalId: false,
      isMasterDetail: false,
      cascadeDelete: false,
      restrictDelete: false,
      restrictedPicklist: false,
      trackHistory: false,
      isCustom: false,
      isNameField: true,
      isSystem: false,
      sortOrder: -50,
      column: 'name'
    };
    obj.fields.set('name', nameField); // internal alias — code can always resolve "Name"
    if (nameApi !== 'Name') obj.fields.set(nameApi.toLowerCase(), nameField);
    obj.fieldList.push(nameField);
  }

  for (const row of fields.rows) {
    const obj = objById.get(row.object_id);
    if (!obj) continue;
    if (obj.fields.has(row.api_name.toLowerCase())) {
      // A body field may override the synthesized Name (compound names handled in DML).
      if (row.api_name.toLowerCase() !== 'name') continue;
    }
    const f: FieldMeta = {
      id: row.id,
      apiName: row.api_name,
      label: row.label,
      type: row.type,
      length: row.length,
      precision: row.precision,
      scale: row.scale,
      required: row.is_required,
      unique: row.is_unique,
      externalId: row.is_external_id,
      defaultValue: row.default_value,
      formula: row.formula,
      formulaReturnType: row.formula_return_type,
      rollup: row.rollup ?? null,
      referenceTo: row.reference_to,
      relationshipName: row.relationship_name,
      isMasterDetail: row.is_master_detail,
      cascadeDelete: row.cascade_delete,
      restrictDelete: row.restrict_delete,
      picklist: row.picklist_set_id ? (picklistBySet.get(row.picklist_set_id) ?? []) : null,
      picklistSetId: row.picklist_set_id,
      restrictedPicklist: row.restricted_picklist,
      controllingField: row.controlling_field,
      dependencyMap: row.dependency_map,
      trackHistory: row.track_history,
      isCustom: row.is_custom,
      isNameField: row.is_name_field,
      isSystem: row.is_system,
      helpText: row.help_text,
      sortOrder: row.sort_order,
      column: null
    };
    obj.fields.set(f.apiName.toLowerCase(), f);
    obj.fieldList.push(f);
  }

  for (const row of recordTypes.rows) {
    const obj = objById.get(row.object_id);
    if (!obj) continue;
    obj.recordTypes.push({
      id: row.id,
      apiName: row.api_name,
      label: row.label,
      description: row.description,
      isActive: row.is_active,
      isDefault: row.is_default,
      picklistOverrides: row.picklist_overrides ?? {}
    });
  }
  // RecordTypeId system field only for objects that define record types.
  for (const obj of org.objectList) {
    if (obj.recordTypes.length > 0) {
      const f: FieldMeta = {
        id: obj.id + ':RecordTypeId',
        apiName: 'RecordTypeId',
        label: 'Record Type ID',
        type: 'Lookup',
        required: false,
        unique: false,
        externalId: false,
        isMasterDetail: false,
        cascadeDelete: false,
        restrictDelete: false,
        restrictedPicklist: false,
        trackHistory: false,
        isCustom: false,
        isNameField: false,
        isSystem: true,
        sortOrder: -40,
        column: 'record_type_id',
        relationshipName: 'RecordType'
      };
      obj.fields.set('recordtypeid', f);
      obj.fieldList.push(f);
    }
  }

  for (const row of validations.rows) {
    const obj = objById.get(row.object_id);
    if (!obj) continue;
    obj.validationRules.push({
      id: row.id,
      apiName: row.api_name,
      active: row.active,
      formula: row.formula,
      errorMessage: row.error_message,
      errorField: row.error_field,
      description: row.description
    });
  }

  // Child relationships: every Lookup/MasterDetail creates one on the referenced object.
  for (const obj of org.objectList) {
    for (const f of obj.fieldList) {
      if ((f.type === 'Lookup' || f.type === 'MasterDetail') && f.referenceTo && !f.isSystem) {
        const parent = org.objects.get(f.referenceTo.toLowerCase());
        if (parent) {
          parent.childRelationships.push({
            childObject: obj.apiName,
            field: f.apiName,
            relationshipName: f.relationshipName ?? null,
            cascadeDelete: f.cascadeDelete || f.isMasterDetail,
            restrictDelete: f.restrictDelete,
            isMasterDetail: f.isMasterDetail
          });
        }
      }
    }
  }

  return org;
}
