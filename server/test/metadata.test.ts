import { describe, it, expect, beforeAll } from 'vitest';
import { testOrg, type TestOrg } from './helpers.js';
import { getObject, getField } from '../src/metadata/types.js';
import { describeSObject, describeGlobal } from '../src/metadata/describe.js';
import { installObject, addField } from '../src/metadata/installer.js';
import { invalidateOrgMeta, loadOrgMeta } from '../src/metadata/registry.js';

let org: TestOrg;

const allowAll = {
  canRead: () => true,
  canCreate: () => true,
  canEdit: () => true,
  canDelete: () => true,
  fieldReadable: () => true,
  fieldEditable: () => true
};

beforeAll(async () => {
  org = await testOrg();
});

describe('org provisioning + metadata registry', () => {
  it('installs all standard objects', async () => {
    const meta = await org.meta();
    for (const name of ['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'Campaign', 'Task', 'Event', 'User']) {
      expect(getObject(meta, name), name).toBeTruthy();
    }
    expect(getObject(meta, 'account')!.keyPrefix).toBe('001');
    expect(getObject(meta, 'OPPORTUNITY')!.keyPrefix).toBe('006');
  });

  it('loads fields with types, picklists and system fields', async () => {
    const meta = await org.meta();
    const acc = getObject(meta, 'Account')!;
    expect(getField(acc, 'Industry')!.picklist!.length).toBeGreaterThan(20);
    expect(getField(acc, 'AnnualRevenue')!.type).toBe('Currency');
    expect(getField(acc, 'CreatedDate')!.isSystem).toBe(true);
    expect(getField(acc, 'OwnerId')!.referenceTo).toBe('User');
    const opp = getObject(meta, 'Opportunity')!;
    const stage = getField(opp, 'StageName')!;
    expect(stage.picklist!.find((v) => v.value === 'Closed Won')!.meta).toMatchObject({ isWon: true });
    expect(getField(opp, 'ExpectedRevenue')!.type).toBe('Formula');
  });

  it('name field API names differ per object (CaseNumber, Subject)', async () => {
    const meta = await org.meta();
    expect(getField(getObject(meta, 'Case')!, 'CaseNumber')!.isNameField).toBe(true);
    expect(getField(getObject(meta, 'Case')!, 'Name')!.apiName).toBe('CaseNumber');
    expect(getField(getObject(meta, 'Task')!, 'Subject')!.isNameField).toBe(true);
    expect(getObject(meta, 'Case')!.nameFieldType).toBe('AutoNumber');
  });

  it('computes child relationships from lookups', async () => {
    const meta = await org.meta();
    const acc = getObject(meta, 'Account')!;
    const rels = acc.childRelationships.map((r) => r.relationshipName);
    expect(rels).toContain('Contacts');
    expect(rels).toContain('Opportunities');
    expect(rels).toContain('Cases');
    const opp = getObject(meta, 'Opportunity')!;
    const oli = opp.childRelationships.find((r) => r.childObject === 'OpportunityLineItem')!;
    expect(oli.isMasterDetail).toBe(true);
    expect(oli.cascadeDelete).toBe(true);
  });

  it('generates Salesforce-shaped describe', async () => {
    const meta = await org.meta();
    const d = describeSObject(meta, getObject(meta, 'Account')!, allowAll);
    expect(d.name).toBe('Account');
    expect(d.keyPrefix).toBe('001');
    const idField = d.fields.find((f: any) => f.name === 'Id')!;
    expect(idField.type).toBe('id');
    const industry = d.fields.find((f: any) => f.name === 'Industry')!;
    expect(industry.type).toBe('picklist');
    expect(industry.picklistValues.length).toBeGreaterThan(20);
    const owner = d.fields.find((f: any) => f.name === 'OwnerId')!;
    expect(owner.type).toBe('reference');
    expect(owner.referenceTo).toEqual(['User']);
    expect(owner.relationshipName).toBe('Owner');
    const global = describeGlobal(meta, allowAll);
    expect(global.sobjects.length).toBeGreaterThanOrEqual(16);
  });

  it('creates a custom object with prefix allocation and dynamic table', async () => {
    await org.tenant(async (c) => {
      await installObject(c, {
        apiName: 'Membership__c',
        label: 'Membership',
        pluralLabel: 'Memberships',
        fields: [
          { apiName: 'Member__c', label: 'Member', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'Memberships', required: true },
          { apiName: 'Status__c', label: 'Status', type: 'Picklist', picklist: { values: ['Pending', { value: 'Active', default: true }, 'Lapsed', 'Resigned'] } },
          { apiName: 'Annual_Fee__c', label: 'Annual Fee', type: 'Currency', precision: 10, scale: 2 },
          { apiName: 'Renewal_Date__c', label: 'Renewal Date', type: 'Date' }
        ]
      });
      const t = await c.query(`SELECT count(*)::int AS n FROM d_membership__c`);
      expect(t.rows[0].n).toBe(0);
    });
    invalidateOrgMeta(org.orgId);
    const meta = await loadOrgMeta(org.db, org.orgId, org.schema);
    const m = getObject(meta, 'Membership__c')!;
    expect(m.keyPrefix.startsWith('a')).toBe(true);
    expect(m.isCustom).toBe(true);
    expect(getField(m, 'Member__c')!.referenceTo).toBe('Contact');
    const contact = getObject(meta, 'Contact')!;
    expect(contact.childRelationships.some((r) => r.childObject === 'Membership__c')).toBe(true);
  });

  it('addField appends to an existing object and rejects duplicates', async () => {
    await org.tenant(async (c) => {
      await addField(c, 'Membership__c', { apiName: 'Tier__c', label: 'Tier', type: 'Text', length: 40 });
      await expect(
        addField(c, 'Membership__c', { apiName: 'Tier__c', label: 'Tier', type: 'Text' })
      ).rejects.toThrow(/already exists/);
    });
    invalidateOrgMeta(org.orgId);
    const meta = await loadOrgMeta(org.db, org.orgId, org.schema);
    expect(getField(getObject(meta, 'Membership__c')!, 'Tier__c')).toBeTruthy();
  });

  it('provisioned admin user, profiles and directory entry exist', async () => {
    await org.tenant(async (c) => {
      const u = await c.query(`SELECT name, fields FROM d_user`);
      expect(u.rows[0].name).toBe('Ada Pemberton');
      expect(u.rows[0].fields.Username).toBe('admin@larkspur.club');
      const p = await c.query(`SELECT name FROM profile ORDER BY name`);
      expect(p.rows.map((r: any) => r.name)).toEqual(['Read Only', 'Standard User', 'System Administrator']);
    });
    const dir = await org.db.query(`SELECT org_id FROM sys.user_directory WHERE username = $1`, [
      'admin@larkspur.club'
    ]);
    expect(dir.rows[0].org_id).toBe(org.orgId);
  });
});
