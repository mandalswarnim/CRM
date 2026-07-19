import type { FieldMeta, ObjectMeta, OrgMeta } from './types.js';
import { config } from '../config.js';

/** Map platform field types to Salesforce describe soapType/type strings. */
export function describeFieldType(f: FieldMeta): string {
  if (f.apiName === 'Id') return 'id';
  const base = f.type === 'Formula' ? (f.formulaReturnType ?? 'Text') : f.type;
  switch (base) {
    case 'Text':
    case 'AutoNumber':
      return 'string';
    case 'TextArea':
    case 'LongTextArea':
    case 'RichText':
      return 'textarea';
    case 'Checkbox':
      return 'boolean';
    case 'Number':
      return 'double';
    case 'Currency':
      return 'currency';
    case 'Percent':
      return 'percent';
    case 'Date':
      return 'date';
    case 'DateTime':
      return 'datetime';
    case 'Time':
      return 'time';
    case 'Email':
      return 'email';
    case 'Phone':
      return 'phone';
    case 'Url':
      return 'url';
    case 'Picklist':
      return 'picklist';
    case 'MultiselectPicklist':
      return 'multipicklist';
    case 'Lookup':
    case 'MasterDetail':
      return 'reference';
    case 'RollupSummary':
      return 'double';
    case 'Geolocation':
      return 'location';
    default:
      return 'string';
  }
}

export function describeField(f: FieldMeta, obj: ObjectMeta, opts: { editable: boolean }) {
  const type = describeFieldType(f);
  const calculated = f.type === 'Formula' || f.type === 'RollupSummary' || f.type === 'AutoNumber';
  const createable =
    opts.editable && !calculated && !f.isSystem && f.apiName !== 'Id';
  const updateable = createable && !['CreatedById', 'CreatedDate'].includes(f.apiName);
  return {
    name: f.apiName,
    label: f.label,
    type,
    length: f.length ?? 0,
    precision: f.precision ?? 0,
    scale: f.scale ?? 0,
    byteLength: (f.length ?? 0) * 3,
    nillable: !f.required && f.apiName !== 'Id',
    createable,
    updateable,
    unique: f.unique,
    externalId: f.externalId,
    idLookup: f.apiName === 'Id' || f.externalId,
    defaultValue: f.defaultValue ?? null,
    calculated,
    calculatedFormula: f.formula ?? null,
    autoNumber: f.type === 'AutoNumber',
    caseSensitive: false,
    custom: f.isCustom,
    nameField: f.isNameField,
    filterable: f.type !== 'LongTextArea' && f.type !== 'RichText',
    sortable: f.type !== 'LongTextArea' && f.type !== 'RichText' && f.type !== 'MultiselectPicklist',
    groupable: ['Picklist', 'Checkbox', 'Text', 'Date', 'Lookup', 'MasterDetail'].includes(f.type),
    aggregatable: true,
    permissionable: !f.isSystem && !f.isNameField,
    restrictedPicklist: f.restrictedPicklist && !!f.picklist,
    dependentPicklist: !!f.controllingField,
    controllerName: f.controllingField ?? null,
    htmlFormatted: f.type === 'RichText',
    picklistValues: (f.picklist ?? []).map((v) => ({
      active: v.isActive,
      defaultValue: v.isDefault,
      label: v.label,
      value: v.value,
      validFor: null
    })),
    referenceTo: f.referenceTo ? (f.referenceTo === '*' ? [] : f.referenceTo.split(',')) : [],
    relationshipName:
      f.type === 'Lookup' || f.type === 'MasterDetail'
        ? f.apiName === 'OwnerId'
          ? 'Owner'
          : f.apiName.endsWith('Id')
            ? f.apiName.slice(0, -2)
            : f.apiName.endsWith('__c')
              ? f.apiName.replace(/__c$/, '__r')
              : f.apiName
        : null,
    cascadeDelete: f.cascadeDelete,
    writeRequiresMasterRead: false,
    soapType: type === 'id' ? 'tns:ID' : `xsd:${type === 'double' || type === 'currency' || type === 'percent' ? 'double' : type === 'boolean' ? 'boolean' : type === 'date' ? 'date' : type === 'datetime' ? 'dateTime' : 'string'}`,
    deprecatedAndHidden: false
  };
}

export interface DescribePermsView {
  canRead(obj: string): boolean;
  canCreate(obj: string): boolean;
  canEdit(obj: string): boolean;
  canDelete(obj: string): boolean;
  fieldReadable(obj: string, field: string): boolean;
  fieldEditable(obj: string, field: string): boolean;
}

export function describeSObjectSummary(obj: ObjectMeta, perms: DescribePermsView, version: string) {
  const base = `/services/data/v${version}/sobjects/${obj.apiName}`;
  return {
    activateable: false,
    createable: perms.canCreate(obj.apiName),
    custom: obj.isCustom,
    customSetting: false,
    deletable: perms.canDelete(obj.apiName),
    deprecatedAndHidden: false,
    feedEnabled: obj.feedEnabled,
    keyPrefix: obj.keyPrefix,
    label: obj.label,
    labelPlural: obj.pluralLabel,
    layoutable: true,
    mergeable: false,
    mruEnabled: true,
    name: obj.apiName,
    queryable: obj.isQueryable,
    replicateable: true,
    retrieveable: true,
    searchable: obj.searchEnabled,
    triggerable: true,
    undeletable: true,
    updateable: perms.canEdit(obj.apiName),
    urls: {
      sobject: base,
      describe: `${base}/describe`,
      rowTemplate: `${base}/{ID}`
    }
  };
}

export function describeSObject(org: OrgMeta, obj: ObjectMeta, perms: DescribePermsView, version = config.defaultApiVersion) {
  const editable = perms.canEdit(obj.apiName);
  const fields = obj.fieldList
    .filter((f) => perms.fieldReadable(obj.apiName, f.apiName))
    .map((f) => describeField(f, obj, { editable: editable && perms.fieldEditable(obj.apiName, f.apiName) }));
  return {
    ...describeSObjectSummary(obj, perms, version),
    fields,
    childRelationships: obj.childRelationships.map((r) => ({
      cascadeDelete: r.cascadeDelete,
      childSObject: r.childObject,
      deprecatedAndHidden: false,
      field: r.field,
      relationshipName: r.relationshipName,
      restrictedDelete: r.restrictDelete
    })),
    recordTypeInfos: obj.recordTypes.map((rt) => ({
      active: rt.isActive,
      available: true,
      defaultRecordTypeMapping: rt.isDefault,
      developerName: rt.apiName,
      name: rt.label,
      recordTypeId: rt.id
    })),
    supportedScopes: [
      { label: 'All ' + obj.pluralLabel, name: 'everything' },
      { label: 'My ' + obj.pluralLabel, name: 'mine' }
    ],
    actionOverrides: [],
    compactLayoutable: true,
    listviewable: true,
    searchLayoutable: true
  };
}

export function describeGlobal(org: OrgMeta, perms: DescribePermsView, version = config.defaultApiVersion) {
  return {
    encoding: 'UTF-8',
    maxBatchSize: 200,
    sobjects: org.objectList
      .filter((o) => perms.canRead(o.apiName))
      .map((o) => describeSObjectSummary(o, perms, version))
  };
}
