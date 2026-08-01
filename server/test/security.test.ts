import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { rawInsert, ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { generateId, KEY_PREFIXES } from '../src/util/ids.js';
import { deleteRecords, getRecord, insertRecord, updateRecord } from '../src/dml/index.js';
import { runQuery, resetSecurityPolicy } from '../src/soql/index.js';
import {
  ensureUserAccess,
  installSecurity,
  invalidateUserAccess,
  objectAccessFor,
  recomputeObjectShares,
  setOrgWideDefault,
  shareRecord,
  unshareRecord
} from '../src/security/index.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;

const roles: Record<string, string> = {};
const users: Record<string, string> = {};
const profiles: Record<string, string> = {};
let membersGroupId: string;

function ctxFor(userId: string): RequestContext {
  const ctx = new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId,
    limits: new LimitContext({ dmlRows: 5000, dmlStatements: 5000, soqlQueries: 5000, queryRows: 500000 })
  });
  return ctx;
}

function adminCtx(): RequestContext {
  const ctx = ctxFor(org.adminUserId);
  return ctx;
}

/** Create a user directly: provisioning-level insert, since the DML path needs a caller. */
async function makeUser(name: string, profileId: string, roleId: string | null): Promise<string> {
  const userId = generateId(KEY_PREFIXES.User);
  await org.tenant((c) =>
    rawInsert(c, 'User', userId, name, {
      Username: `${name.toLowerCase().replace(/\s+/g, '.')}@orientalclub.org.uk`,
      Email: `${name.toLowerCase().replace(/\s+/g, '.')}@orientalclub.org.uk`,
      LastName: name,
      IsActive: true,
      ProfileId: profileId,
      UserRoleId: roleId,
      TimeZoneSidKey: 'Europe/London',
      LocaleSidKey: 'en_GB'
    })
  );
  return userId;
}

beforeAll(async () => {
  org = await testOrg();
  installSecurity();

  await org.tenant(async (c) => {
    // A three-level role hierarchy: GM above the membership secretary, above reception.
    roles.gm = generateId(KEY_PREFIXES.UserRole);
    roles.secretary = generateId(KEY_PREFIXES.UserRole);
    roles.reception = generateId(KEY_PREFIXES.UserRole);
    await c.query(`INSERT INTO role (id, api_name, name, parent_id) VALUES ($1,'GM','General Manager',NULL)`, [roles.gm]);
    await c.query(`INSERT INTO role (id, api_name, name, parent_id) VALUES ($1,'Secretary','Membership Secretary',$2)`, [
      roles.secretary,
      roles.gm
    ]);
    await c.query(`INSERT INTO role (id, api_name, name, parent_id) VALUES ($1,'Reception','Reception',$2)`, [
      roles.reception,
      roles.secretary
    ]);

    const std = await c.query<{ id: string }>(`SELECT id FROM profile WHERE name = 'Standard User'`);
    const readOnly = await c.query<{ id: string }>(`SELECT id FROM profile WHERE name = 'Read Only'`);
    profiles.standard = std.rows[0].id;
    profiles.readOnly = readOnly.rows[0].id;

    membersGroupId = generateId(KEY_PREFIXES.Group);
    await c.query(
      `INSERT INTO group_def (id, api_name, label, type, member_ids) VALUES ($1,'ClubStaff','Club Staff','Regular',$2)`,
      [membersGroupId, JSON.stringify([`role:${roles.reception}`])]
    );
  });

  users.gm = await makeUser('Gerald Manager', profiles.standard, roles.gm);
  users.secretary = await makeUser('Sylvia Secretary', profiles.standard, roles.secretary);
  users.reception = await makeUser('Ravi Reception', profiles.standard, roles.reception);
  users.readOnly = await makeUser('Olive Observer', profiles.readOnly, null);

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Membership__c',
      label: 'Membership',
      pluralLabel: 'Memberships',
      isCustom: true,
      sharingModel: 'ControlledByParent',
      fields: [
        {
          apiName: 'Contact__c',
          label: 'Member',
          type: 'MasterDetail',
          referenceTo: 'Contact',
          relationshipName: 'Memberships',
          isMasterDetail: true,
          cascadeDelete: true
        },
        { apiName: 'Category__c', label: 'Category', type: 'Picklist', picklist: { values: ['Full', 'Associate'] } }
      ]
    })
  );

  // Object permissions for the custom object, which provisioning could not know about.
  await org.tenant(async (c) => {
    for (const profileId of [profiles.standard, profiles.readOnly]) {
      const readOnlyProfile = profileId === profiles.readOnly;
      await c.query(
        `INSERT INTO object_perm (id, parent_id, object_api, can_create, can_read, can_edit, can_delete)
         VALUES ($1,$2,'Membership__c',$3,true,$3,$3)`,
        [generateId('0PS'), profileId, !readOnlyProfile]
      );
    }
  });

  invalidateOrgMeta(org.orgId);
  invalidateUserAccess(org.orgId);
});

afterAll(() => {
  resetSecurityPolicy();
});

describe('permission resolution', () => {
  it('resolves profile permissions and object CRUD', async () => {
    const ctx = ctxFor(users.reception);
    const access = await ensureUserAccess(ctx);
    expect(access.perms.modifyAllData).toBeUndefined();
    expect(access.roleId).toBe(roles.reception);
    const accountAccess = objectAccessFor(access, 'Account');
    expect(accountAccess.read).toBe(true);
    expect(accountAccess.create).toBe(true);
  });

  it('walks the role hierarchy in both directions', async () => {
    const access = await ensureUserAccess(ctxFor(users.secretary));
    expect(access.roleAndAncestors).toEqual([roles.secretary, roles.gm]);
    expect(access.subordinateRoleIds).toEqual([roles.reception]);
  });

  it('resolves group membership through a role', async () => {
    const receptionist = await ensureUserAccess(ctxFor(users.reception));
    expect(receptionist.groupIds).toContain(membersGroupId);
    const gm = await ensureUserAccess(ctxFor(users.gm));
    expect(gm.groupIds).not.toContain(membersGroupId);
  });

  it('grants everything to a profile with Modify All Data', async () => {
    const access = await ensureUserAccess(adminCtx());
    expect(access.perms.modifyAllData).toBe(true);
    expect(objectAccessFor(access, 'Membership__c')).toMatchObject({ create: true, read: true, edit: true, remove: true });
  });
});

describe('object-level enforcement', () => {
  it('refuses a create to a read-only profile', async () => {
    await expect(insertRecord(ctxFor(users.readOnly), 'Account', { Name: 'Should fail' })).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY'
    });
  });

  it('refuses a delete to a profile without delete permission', async () => {
    const id = await insertRecord(adminCtx(), 'Account', { Name: 'Undeletable by Olive' });
    await expect(deleteRecords(ctxFor(users.readOnly), 'Account', [id])).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY'
    });
  });

  it('allows a read-only profile to read', async () => {
    const id = await insertRecord(adminCtx(), 'Account', { Name: 'Readable' });
    expect(await getRecord(ctxFor(users.readOnly), 'Account', id)).not.toBeNull();
  });
});

describe('field-level security', () => {
  const denyField = async (profileId: string, object: string, field: string, perms: { readable: boolean; editable: boolean }) => {
    await org.tenant((c) =>
      c.query(
        `INSERT INTO field_perm (id, parent_id, object_api, field_api, readable, editable)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (parent_id, object_api, field_api) DO UPDATE SET readable = EXCLUDED.readable, editable = EXCLUDED.editable`,
        [generateId('00N'), profileId, object, field, perms.readable, perms.editable]
      )
    );
    invalidateUserAccess(org.orgId);
  };

  it('hides an unreadable field from SOQL as though it did not exist', async () => {
    await denyField(profiles.standard, 'Account', 'AnnualRevenue', { readable: false, editable: false });
    await expect(runQuery(ctxFor(users.reception), 'SELECT AnnualRevenue FROM Account')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
    // Admins are unaffected.
    await expect(runQuery(adminCtx(), 'SELECT AnnualRevenue FROM Account')).resolves.toBeTruthy();
  });

  it('strips an unreadable field from a record read', async () => {
    const id = await insertRecord(adminCtx(), 'Account', { Name: 'Rich Club', AnnualRevenue: 1000000 });
    const asAdmin = await getRecord(adminCtx(), 'Account', id);
    expect(asAdmin!.AnnualRevenue).toBe(1000000);
    const asStaff = await getRecord(ctxFor(users.reception), 'Account', id);
    expect(asStaff).not.toBeNull();
    expect('AnnualRevenue' in asStaff!).toBe(false);
  });

  it('refuses a write to an uneditable field', async () => {
    await denyField(profiles.standard, 'Account', 'Rating', { readable: true, editable: false });
    await expect(
      insertRecord(ctxFor(users.reception), 'Account', { Name: 'Rated', Rating: 'Hot' })
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE' });
    // Readable still, just not writable.
    await expect(runQuery(ctxFor(users.reception), 'SELECT Rating FROM Account')).resolves.toBeTruthy();
  });

  it('lets a permission set restore what a profile denies', async () => {
    const permSetId = generateId(KEY_PREFIXES.PermissionSet);
    await org.tenant(async (c) => {
      await c.query(`INSERT INTO permission_set (id, api_name, label, perms) VALUES ($1,'Finance','Finance','{}')`, [
        permSetId
      ]);
      await c.query(
        `INSERT INTO field_perm (id, parent_id, object_api, field_api, readable, editable) VALUES ($1,$2,'Account','AnnualRevenue',true,true)`,
        [generateId('00N'), permSetId]
      );
      await c.query(`INSERT INTO perm_set_assignment (id, user_id, perm_set_id) VALUES ($1,$2,$3)`, [
        generateId(KEY_PREFIXES.PermissionSetAssignment),
        users.secretary,
        permSetId
      ]);
    });
    invalidateUserAccess(org.orgId);

    await expect(runQuery(ctxFor(users.secretary), 'SELECT AnnualRevenue FROM Account')).resolves.toBeTruthy();
    await expect(runQuery(ctxFor(users.reception), 'SELECT AnnualRevenue FROM Account')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
  });
});

describe('record-level sharing', () => {
  let receptionRecord: string;

  beforeAll(async () => {
    await setOrgWideDefault(adminCtx(), 'Contact', 'Private');
    invalidateUserAccess(org.orgId);
    receptionRecord = await insertRecord(ctxFor(users.reception), 'Contact', { LastName: 'Reception Owned' });
  });

  it('lets the owner see their own record', async () => {
    const res = await runQuery(ctxFor(users.reception), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(res.totalSize).toBe(1);
  });

  it('hides a private record from an unrelated user', async () => {
    const res = await runQuery(ctxFor(users.readOnly), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(res.totalSize).toBe(0);
    expect(await getRecord(ctxFor(users.readOnly), 'Contact', receptionRecord)).toBeNull();
  });

  it('grants access up the role hierarchy but not down', async () => {
    const gm = await runQuery(ctxFor(users.gm), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(gm.totalSize).toBe(1);

    const gmRecord = await insertRecord(ctxFor(users.gm), 'Contact', { LastName: 'GM Owned' });
    const downward = await runQuery(ctxFor(users.reception), `SELECT Id FROM Contact WHERE Id = '${gmRecord}'`);
    expect(downward.totalSize).toBe(0);
  });

  it('stops hierarchy grants when the object disables them', async () => {
    await setOrgWideDefault(adminCtx(), 'Contact', 'Private', false);
    invalidateUserAccess(org.orgId);
    const gm = await runQuery(ctxFor(users.gm), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(gm.totalSize).toBe(0);

    await setOrgWideDefault(adminCtx(), 'Contact', 'Private', true);
    invalidateUserAccess(org.orgId);
  });

  it('honours a manual share, and a Read share does not permit writing', async () => {
    await shareRecord(adminCtx(), 'Contact', receptionRecord, { type: 'User', id: users.readOnly }, 'Read');

    const visible = await runQuery(ctxFor(users.readOnly), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(visible.totalSize).toBe(1);

    await expect(updateRecord(ctxFor(users.readOnly), 'Contact', receptionRecord, { Title: 'Nope' })).rejects.toMatchObject(
      { errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }
    );

    await unshareRecord(adminCtx(), 'Contact', receptionRecord, { type: 'User', id: users.readOnly });
    const gone = await runQuery(ctxFor(users.readOnly), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(gone.totalSize).toBe(0);
  });

  it('permits writing through an Edit share', async () => {
    const secretaryRecord = await insertRecord(ctxFor(users.secretary), 'Contact', { LastName: 'Shared For Edit' });
    await shareRecord(adminCtx(), 'Contact', secretaryRecord, { type: 'User', id: users.reception }, 'Edit');
    await expect(
      updateRecord(ctxFor(users.reception), 'Contact', secretaryRecord, { Title: 'Amended' })
    ).resolves.toBeUndefined();
  });

  it('honours a share to a group the user reaches through their role', async () => {
    const gmRecord = await insertRecord(ctxFor(users.gm), 'Contact', { LastName: 'Group Shared' });
    await shareRecord(adminCtx(), 'Contact', gmRecord, { type: 'Group', id: membersGroupId }, 'Read');
    const res = await runQuery(ctxFor(users.reception), `SELECT Id FROM Contact WHERE Id = '${gmRecord}'`);
    expect(res.totalSize).toBe(1);
  });

  it('lets Modify All Data see everything regardless', async () => {
    const res = await runQuery(adminCtx(), `SELECT Id FROM Contact WHERE Id = '${receptionRecord}'`);
    expect(res.totalSize).toBe(1);
  });
});

describe('criteria-based sharing rules', () => {
  it('materialises shares on save and applies them to queries', async () => {
    await org.tenant((c) =>
      c.query(
        `INSERT INTO sharing_rule (id, object_api, api_name, label, rule_type, criteria, share_with, access_level)
         VALUES ($1,'Contact','ShareOverseas','Share overseas members','criteria',$2,$3,'Read')`,
        [
          generateId(KEY_PREFIXES.SharingRule),
          JSON.stringify([{ field: 'Department', op: 'equals', value: 'Overseas' }]),
          JSON.stringify({ type: 'Group', id: membersGroupId })
        ]
      )
    );

    const overseas = await insertRecord(ctxFor(users.gm), 'Contact', { LastName: 'Abroad', Department: 'Overseas' });
    const domestic = await insertRecord(ctxFor(users.gm), 'Contact', { LastName: 'Local', Department: 'Town' });

    const shares = await org.tenant((c) =>
      c.query(`SELECT record_id FROM record_share WHERE object_api = 'Contact' AND row_cause = 'Rule'`)
    );
    expect(shares.rows.map((r: any) => r.record_id)).toContain(overseas);
    expect(shares.rows.map((r: any) => r.record_id)).not.toContain(domestic);

    const visible = await runQuery(ctxFor(users.reception), `SELECT LastName FROM Contact WHERE Id = '${overseas}'`);
    expect(visible.totalSize).toBe(1);
    const hidden = await runQuery(ctxFor(users.reception), `SELECT LastName FROM Contact WHERE Id = '${domestic}'`);
    expect(hidden.totalSize).toBe(0);
  });

  it('withdraws the share when the record stops matching', async () => {
    const record = await insertRecord(ctxFor(users.gm), 'Contact', { LastName: 'Relocating', Department: 'Overseas' });
    expect((await runQuery(ctxFor(users.reception), `SELECT Id FROM Contact WHERE Id = '${record}'`)).totalSize).toBe(1);

    await updateRecord(adminCtx(), 'Contact', record, { Department: 'Town' });
    expect((await runQuery(ctxFor(users.reception), `SELECT Id FROM Contact WHERE Id = '${record}'`)).totalSize).toBe(0);
  });

  it('recomputes shares for existing records when a rule is added', async () => {
    const count = await recomputeObjectShares(adminCtx(), 'Contact');
    expect(count).toBeGreaterThan(0);
  });
});

describe('ControlledByParent', () => {
  it('gives a detail record exactly the visibility of its master', async () => {
    const parent = await insertRecord(ctxFor(users.secretary), 'Contact', { LastName: 'Master Owner' });
    const detail = await insertRecord(ctxFor(users.secretary), 'Membership__c', {
      Name: 'OC-Master-1',
      Contact__c: parent,
      Category__c: 'Full'
    });

    // The secretary owns the master, so both are visible.
    expect((await runQuery(ctxFor(users.secretary), `SELECT Id FROM Membership__c WHERE Id = '${detail}'`)).totalSize).toBe(1);

    // Reception is below the secretary in the hierarchy: no access to either.
    expect((await runQuery(ctxFor(users.reception), `SELECT Id FROM Membership__c WHERE Id = '${detail}'`)).totalSize).toBe(0);

    // Sharing the master makes the detail visible too, without touching the detail.
    await shareRecord(adminCtx(), 'Contact', parent, { type: 'User', id: users.reception }, 'Read');
    expect((await runQuery(ctxFor(users.reception), `SELECT Id FROM Membership__c WHERE Id = '${detail}'`)).totalSize).toBe(1);
  });
});
