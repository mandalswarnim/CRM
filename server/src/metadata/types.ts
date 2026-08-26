/** In-memory metadata model — the interpreted "shape" of an org. */

export type FieldType =
  | 'Text'
  | 'TextArea'
  | 'LongTextArea'
  | 'RichText'
  | 'Checkbox'
  | 'Number'
  | 'Currency'
  | 'Percent'
  | 'Date'
  | 'DateTime'
  | 'Time'
  | 'Email'
  | 'Phone'
  | 'Url'
  | 'Picklist'
  | 'MultiselectPicklist'
  | 'Lookup'
  | 'MasterDetail'
  | 'Formula'
  | 'RollupSummary'
  | 'AutoNumber'
  | 'Geolocation';

export interface PicklistValueMeta {
  value: string;
  label: string;
  isActive: boolean;
  isDefault: boolean;
  color?: string | null;
  meta?: Record<string, any>;
}

export interface RollupSpec {
  childObject: string;
  /** Lookup/MasterDetail field on the child pointing at this object. */
  relationshipField: string;
  operation: 'COUNT' | 'SUM' | 'MIN' | 'MAX';
  field?: string;
  filters?: { field: string; op: string; value: any }[];
}

export interface FieldMeta {
  id: string;
  apiName: string;
  label: string;
  type: FieldType;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  required: boolean;
  unique: boolean;
  externalId: boolean;
  defaultValue?: string | null;
  formula?: string | null;
  formulaReturnType?: string | null;
  rollup?: RollupSpec | null;
  referenceTo?: string | null;
  relationshipName?: string | null;
  isMasterDetail: boolean;
  cascadeDelete: boolean;
  restrictDelete: boolean;
  picklist?: PicklistValueMeta[] | null;
  picklistSetId?: string | null;
  restrictedPicklist: boolean;
  controllingField?: string | null;
  dependencyMap?: Record<string, string[]> | null;
  trackHistory: boolean;
  isCustom: boolean;
  isNameField: boolean;
  isSystem: boolean;
  helpText?: string | null;
  sortOrder: number;
  /** Physical column when not stored in the JSONB body (system fields, Name). */
  column?: string | null;
}

export interface ChildRelationship {
  childObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
  restrictDelete: boolean;
  isMasterDetail: boolean;
}

export interface RecordTypeMeta {
  id: string;
  apiName: string;
  label: string;
  description?: string | null;
  isActive: boolean;
  isDefault: boolean;
  picklistOverrides: Record<string, { values: string[]; default?: string }>;
}

export interface ValidationRuleMeta {
  id: string;
  apiName: string;
  active: boolean;
  formula: string;
  errorMessage: string;
  errorField?: string | null;
  description?: string | null;
}

export interface ObjectMeta {
  id: string;
  apiName: string;
  label: string;
  pluralLabel: string;
  keyPrefix: string;
  isCustom: boolean;
  description?: string | null;
  sharingModel: 'Private' | 'Read' | 'ReadWrite' | 'ControlledByParent';
  feedEnabled: boolean;
  historyEnabled: boolean;
  activitiesEnabled: boolean;
  searchEnabled: boolean;
  reportsEnabled: boolean;
  isQueryable: boolean;
  nameFieldLabel: string;
  nameFieldType: 'Text' | 'AutoNumber';
  autoNumberFormat?: string | null;
  icon?: string | null;
  color?: string | null;
  /**
   * How this object's records drive inventory allocation, when they do. Ordinary metadata: it is
   * what lets `Booking__c` book a room without the engine knowing what a room is.
   */
  booking?: import('../inventory/types.js').BookingConfig | null;
  /** Physical table name in the tenant schema. */
  table: string;
  fields: Map<string, FieldMeta>; // keyed by lower-cased api name
  fieldList: FieldMeta[];
  childRelationships: ChildRelationship[];
  recordTypes: RecordTypeMeta[];
  validationRules: ValidationRuleMeta[];
}

export interface OrgMeta {
  orgId: string;
  schema: string;
  version: number;
  objects: Map<string, ObjectMeta>; // keyed by lower-cased api name
  objectList: ObjectMeta[];
  byPrefix: Map<string, ObjectMeta>;
  settings: {
    defaultLanguage: string;
    defaultLocale: string;
    defaultTimezone: string;
    corporateCurrency: string;
    multiCurrency: boolean;
    name: string;
    isSandbox: boolean;
  };
  currencies: { isoCode: string; rate: number; decimals: number; active: boolean; corporate: boolean }[];
}

export function getObject(org: OrgMeta, apiName: string): ObjectMeta | undefined {
  return org.objects.get(apiName.toLowerCase());
}

export function getField(obj: ObjectMeta, apiName: string): FieldMeta | undefined {
  return obj.fields.get(apiName.toLowerCase());
}

/** Physical storage expression for a field (column or JSONB extraction). */
export function isColumnField(f: FieldMeta): boolean {
  return !!f.column;
}

/** System field templates applied to every object. */
export const SYSTEM_FIELD_SPECS: Array<{
  apiName: string;
  label: string;
  type: FieldType;
  column: string;
  referenceTo?: string;
  relationshipName?: string;
  skipFor?: string[];
}> = [
  { apiName: 'Id', label: 'Record ID', type: 'Text', column: 'id' },
  { apiName: 'OwnerId', label: 'Owner ID', type: 'Lookup', column: 'owner_id', referenceTo: 'User', relationshipName: 'Owner', skipFor: ['User'] },
  { apiName: 'CreatedById', label: 'Created By ID', type: 'Lookup', column: 'created_by_id', referenceTo: 'User', relationshipName: 'CreatedBy' },
  { apiName: 'CreatedDate', label: 'Created Date', type: 'DateTime', column: 'created_date' },
  { apiName: 'LastModifiedById', label: 'Last Modified By ID', type: 'Lookup', column: 'last_modified_by_id', referenceTo: 'User', relationshipName: 'LastModifiedBy' },
  { apiName: 'LastModifiedDate', label: 'Last Modified Date', type: 'DateTime', column: 'last_modified_date' },
  { apiName: 'SystemModstamp', label: 'System Modstamp', type: 'DateTime', column: 'system_modstamp' },
  { apiName: 'IsDeleted', label: 'Deleted', type: 'Checkbox', column: 'is_deleted' },
  { apiName: 'CurrencyIsoCode', label: 'Currency ISO Code', type: 'Picklist', column: 'currency_iso_code' },
  { apiName: 'RecordTypeId', label: 'Record Type ID', type: 'Lookup', column: 'record_type_id', relationshipName: 'RecordType' }
];
