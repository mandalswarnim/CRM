import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import {
  clearDmlHooks,
  deleteRecords,
  getRecord,
  insertRecord,
  insertRecords,
  purgeRecycleBin,
  registerDmlHooks,
  undeleteRecords,
  updateRecord,
  updateRecords,
  upsertRecord
} from '../src/dml/index.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;

function context(limits?: LimitContext): RequestContext {
  return new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId: org.adminUserId,
    perms: ADMIN_PERMS,
    limits
  });
}

async function expectFailure(promise: Promise<unknown>, errorCode: string) {
  await expect(promise).rejects.toMatchObject({ errorCode });
}

beforeAll(async () => {
  org = await testOrg();
  // A club-shaped custom object, installed the way the Setup UI will: metadata insert → storage DDL.
  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Membership__c',
      label: 'Membership',
      pluralLabel: 'Memberships',
      isCustom: true,
      nameFieldType: 'AutoNumber',
      autoNumberFormat: 'M-{0000}',
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
        {
          apiName: 'Category__c',
          label: 'Category',
          type: 'Picklist',
          picklist: { values: ['Full', 'Associate', 'OC7'], restricted: true }
        },
        { apiName: 'MemberNumber__c', label: 'Member Number', type: 'Text', length: 20, externalId: true, unique: true },
        { apiName: 'GuestAllowance__c', label: 'Guest Allowance', type: 'Number', precision: 3, scale: 0 }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);
});

afterEach(() => {
  clearDmlHooks();
});

describe('insert', () => {
  it('creates a record with a prefixed id and applies defaults', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'The Oriental Club' });
    expect(id).toHaveLength(18);
    expect(id.slice(0, 3)).toBe('001');

    const rec = await getRecord(ctx, 'Account', id);
    expect(rec!.Name).toBe('The Oriental Club');
    expect(rec!.OwnerId).toBe(org.adminUserId);
    expect(rec!.CurrencyIsoCode).toBe('GBP');
    expect(rec!.CreatedById).toBe(org.adminUserId);
    expect(rec!.IsDeleted).toBe(false);
  });

  it('composes Name from FirstName and LastName', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { FirstName: 'Ada', LastName: 'Pemberton' });
    const rec = await getRecord(ctx, 'Contact', id);
    expect(rec!.Name).toBe('Ada Pemberton');
    expect(rec!.FirstName).toBe('Ada');
  });

  it('assigns auto-numbers from a format', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Fairbanks' });
    const first = await insertRecord(ctx, 'Membership__c', { Contact__c: contact });
    const second = await insertRecord(ctx, 'Membership__c', { Contact__c: contact });

    const a = await getRecord(ctx, 'Membership__c', first);
    const b = await getRecord(ctx, 'Membership__c', second);
    expect(a!.Name).toMatch(/^M-\d{4}$/);
    expect(Number(b!.Name.slice(2))).toBe(Number(a!.Name.slice(2)) + 1);
  });

  it('applies picklist defaults and required picklist values', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Case', { Subject: 'Billiards table needs re-clothing' });
    const rec = await getRecord(ctx, 'Case', id);
    expect(rec!.Status).toBe('New');
    expect(rec!.CaseNumber).toMatch(/^\d+$/);
  });

  it('rejects a missing required field', async () => {
    await expectFailure(insertRecord(context(), 'Contact', { FirstName: 'Nameless' }), 'REQUIRED_FIELD_MISSING');
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    await expectFailure(
      insertRecord(context(), 'Account', { Name: 'X', Nonexistent__c: 1 }),
      'INVALID_FIELD'
    );
  });

  it('refuses to write system-maintained fields', async () => {
    await expectFailure(
      insertRecord(context(), 'Account', { Name: 'X', CreatedDate: '2020-01-01T00:00:00Z' }),
      'INVALID_FIELD_FOR_INSERT_UPDATE'
    );
  });

  it('allows OwnerId to be set explicitly', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Owned', OwnerId: org.adminUserId });
    expect((await getRecord(ctx, 'Account', id))!.OwnerId).toBe(org.adminUserId);
  });
});

describe('field validation', () => {
  it('enforces text length', async () => {
    await expectFailure(insertRecord(context(), 'Account', { Name: 'x'.repeat(300) }), 'STRING_TOO_LONG');
  });

  it('validates email format', async () => {
    await expectFailure(
      insertRecord(context(), 'Contact', { LastName: 'Bad', Email: 'not-an-email' }),
      'INVALID_FIELD'
    );
  });

  it('enforces restricted picklists', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Restricted' });
    await expectFailure(
      insertRecord(ctx, 'Membership__c', { Contact__c: contact, Category__c: 'Platinum' }),
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST'
    );
  });

  it('coerces numbers to the field scale', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Rounding' });
    const id = await insertRecord(ctx, 'Membership__c', { Contact__c: contact, GuestAllowance__c: '4.6' });
    expect((await getRecord(ctx, 'Membership__c', id))!.GuestAllowance__c).toBe(5);
  });

  it('normalises dates and datetimes', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { LastName: 'Dates', Birthdate: new Date('1975-03-04T12:00:00Z') });
    expect((await getRecord(ctx, 'Contact', id))!.Birthdate).toBe('1975-03-04');
  });

  it('rejects a lookup to a record that does not exist', async () => {
    await expectFailure(
      insertRecord(context(), 'Contact', { LastName: 'Orphan', AccountId: '001000000000000AAA' }),
      'INVALID_CROSS_REFERENCE_KEY'
    );
  });

  it('rejects a malformed id', async () => {
    await expectFailure(insertRecord(context(), 'Contact', { LastName: 'Bad', AccountId: 'nope' }), 'MALFORMED_ID');
  });

  it('enforces uniqueness on external id fields', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Unique' });
    await insertRecord(ctx, 'Membership__c', { Contact__c: contact, MemberNumber__c: 'OC-0001' });
    await expectFailure(
      insertRecord(ctx, 'Membership__c', { Contact__c: contact, MemberNumber__c: 'OC-0001' }),
      'DUPLICATE_VALUE'
    );
  });
});

describe('update', () => {
  it('applies changes and stamps the audit fields', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Before', Phone: '020 7629 5126' });
    const before = await getRecord(ctx, 'Account', id);

    await new Promise((r) => setTimeout(r, 5));
    await updateRecord(ctx, 'Account', id, { Name: 'After' });

    const after = await getRecord(ctx, 'Account', id);
    expect(after!.Name).toBe('After');
    expect(after!.Phone).toBe('020 7629 5126'); // untouched fields survive
    expect(new Date(after!.LastModifiedDate).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.LastModifiedDate).getTime()
    );
  });

  it('recomposes a compound name when a part changes', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { FirstName: 'Ada', LastName: 'Pemberton' });
    await updateRecord(ctx, 'Contact', id, { LastName: 'Fairbanks' });
    expect((await getRecord(ctx, 'Contact', id))!.Name).toBe('Ada Fairbanks');
  });

  it('fails on a record that does not exist', async () => {
    await expectFailure(updateRecord(context(), 'Account', '001000000000000AAA', { Name: 'X' }), 'NOT_FOUND');
  });
});

describe('upsert', () => {
  it('inserts when the external id is unmatched and updates when it matches', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Upsert' });

    const created = await upsertRecord(ctx, 'Membership__c', 'MemberNumber__c', 'OC-9001', {
      Contact__c: contact,
      Category__c: 'Full'
    });
    expect(created.created).toBe(true);

    const updated = await upsertRecord(ctx, 'Membership__c', 'MemberNumber__c', 'OC-9001', {
      Category__c: 'Associate'
    });
    expect(updated.created).toBe(false);
    expect(updated.id).toBe(created.id);
    expect((await getRecord(ctx, 'Membership__c', created.id))!.Category__c).toBe('Associate');
  });

  it('refuses a field that is not an external id', async () => {
    await expectFailure(
      upsertRecord(context(), 'Account', 'Phone', '123', { Name: 'X' }),
      'INVALID_OPERATION'
    );
  });
});

describe('delete and the recycle bin', () => {
  it('soft-deletes, hides from reads, and restores', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Temporary' });

    const [deleted] = await deleteRecords(ctx, 'Account', [id]);
    expect(deleted.success).toBe(true);
    expect(await getRecord(ctx, 'Account', id)).toBeNull();
    expect((await getRecord(ctx, 'Account', id, { includeDeleted: true }))!.IsDeleted).toBe(true);

    await undeleteRecords(ctx, 'Account', [id]);
    expect(await getRecord(ctx, 'Account', id)).not.toBeNull();
  });

  it('cascades master-detail children and restores them together', async () => {
    const ctx = context();
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Cascade' });
    const membership = await insertRecord(ctx, 'Membership__c', { Contact__c: contact });

    await deleteRecords(ctx, 'Contact', [contact]);
    expect(await getRecord(ctx, 'Membership__c', membership)).toBeNull();

    await undeleteRecords(ctx, 'Contact', [contact]);
    expect(await getRecord(ctx, 'Membership__c', membership)).not.toBeNull();
  });

  it('clears plain lookups instead of orphaning the reference', async () => {
    const ctx = context();
    const account = await insertRecord(ctx, 'Account', { Name: 'Corporate Member' });
    const contact = await insertRecord(ctx, 'Contact', { LastName: 'Nominee', AccountId: account });

    await deleteRecords(ctx, 'Account', [account]);
    const rec = await getRecord(ctx, 'Contact', contact);
    expect(rec).not.toBeNull();
    expect(rec!.AccountId ?? null).toBeNull();
  });

  it('reports a failure for an id that is not there', async () => {
    const [result] = await deleteRecords(context(), 'Account', ['001000000000000AAA']);
    expect(result.success).toBe(false);
    expect(result.errors[0].errorCode).toBe('NOT_FOUND');
  });

  it('purges only records past the retention window', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Purge me' });
    await deleteRecords(ctx, 'Account', [id]);

    expect(await purgeRecycleBin(ctx, 15)).toBe(0);
    await org.tenant((c) =>
      c.query(`UPDATE d_account SET deleted_date = now() - interval '30 days' WHERE id = $1`, [id])
    );
    expect(await purgeRecycleBin(ctx, 15)).toBeGreaterThan(0);
    expect(await getRecord(ctx, 'Account', id, { includeDeleted: true })).toBeNull();
  });
});

describe('batch semantics', () => {
  it('rolls the whole batch back when allOrNone is set', async () => {
    const ctx = context();
    await expect(
      insertRecords(ctx, 'Account', [{ Name: 'Good one' }, { Name: 'x'.repeat(300) }], { allOrNone: true })
    ).rejects.toThrow();

    const found = await org.tenant((c) => c.query(`SELECT id FROM d_account WHERE name = 'Good one'`));
    expect(found.rows).toHaveLength(0);
  });

  it('keeps the successes when allOrNone is false', async () => {
    const ctx = context();
    const results = await insertRecords(
      ctx,
      'Account',
      [{ Name: 'Kept' }, { Name: 'x'.repeat(300) }, { Name: 'Also kept' }],
      { allOrNone: false }
    );
    expect(results.map((r) => r.success)).toEqual([true, false, true]);
    expect(results[1].errors[0].errorCode).toBe('STRING_TOO_LONG');
    expect(await getRecord(ctx, 'Account', results[0].id)).not.toBeNull();
    expect(await getRecord(ctx, 'Account', results[2].id)).not.toBeNull();
  });

  it('updates several records in one statement', async () => {
    const ctx = context();
    const a = await insertRecord(ctx, 'Account', { Name: 'Bulk A' });
    const b = await insertRecord(ctx, 'Account', { Name: 'Bulk B' });
    const results = await updateRecords(ctx, 'Account', [
      { Id: a, Rating: 'Hot' },
      { Id: b, Rating: 'Warm' }
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect((await getRecord(ctx, 'Account', a))!.Rating).toBe('Hot');
  });
});

describe('governor limits', () => {
  it('counts DML rows and refuses to exceed the budget', async () => {
    const ctx = context(new LimitContext({ dmlRows: 2 }));
    await insertRecords(ctx, 'Account', [{ Name: 'One' }, { Name: 'Two' }]);
    await expectFailure(insertRecord(ctx, 'Account', { Name: 'Three' }), 'LIMIT_EXCEEDED');
  });

  it('counts DML statements separately from rows', async () => {
    const ctx = context(new LimitContext({ dmlStatements: 1 }));
    await insertRecord(ctx, 'Account', { Name: 'First statement' });
    await expectFailure(insertRecord(ctx, 'Account', { Name: 'Second statement' }), 'LIMIT_EXCEEDED');
  });
});

describe('save-order hooks', () => {
  it('runs stages in the Salesforce order', async () => {
    const seen: string[] = [];
    registerDmlHooks({
      name: 'recorder',
      beforeSave: async () => void seen.push('beforeSave'),
      validate: async () => void seen.push('validate'),
      afterSave: async () => void seen.push('afterSave'),
      sideEffects: async () => void seen.push('sideEffects'),
      afterCommit: async () => void seen.push('afterCommit')
    });

    await insertRecord(context(), 'Account', { Name: 'Hooked' });
    expect(seen).toEqual(['beforeSave', 'validate', 'afterSave', 'sideEffects', 'afterCommit']);
  });

  it('lets a before-save hook change values before they are written', async () => {
    registerDmlHooks({
      name: 'uppercase',
      beforeSave: async (e) => {
        for (const change of e.changes) change.updates.Rating = 'Hot';
      }
    });
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Auto-rated' });
    expect((await getRecord(ctx, 'Account', id))!.Rating).toBe('Hot');
  });

  it('aborts the transaction when a validation hook throws', async () => {
    registerDmlHooks({
      name: 'no-nameless-clubs',
      validate: async (e) => {
        for (const change of e.changes) {
          if (String(change.after?.Name ?? '').startsWith('Bad')) {
            const { Errors } = await import('../src/util/errors.js');
            throw Errors.validation('Club names may not start with Bad', ['Name']);
          }
        }
      }
    });
    const ctx = context();
    await expectFailure(insertRecord(ctx, 'Account', { Name: 'Bad Club' }), 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
    const found = await org.tenant((c) => c.query(`SELECT id FROM d_account WHERE name = 'Bad Club'`));
    expect(found.rows).toHaveLength(0);
  });

  it('sees before and after images on update', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Imaged', Rating: 'Cold' });
    let captured: { before: any; after: any } | null = null;
    registerDmlHooks({
      name: 'capture',
      validate: async (e) => {
        captured = { before: e.changes[0].before, after: e.changes[0].after };
      }
    });
    await updateRecord(ctx, 'Account', id, { Rating: 'Hot' });
    expect(captured!.before.Rating).toBe('Cold');
    expect(captured!.after.Rating).toBe('Hot');
  });

  it('skips automation when asked, for bulk loads', async () => {
    let fired = false;
    registerDmlHooks({ name: 'counter', afterSave: async () => void (fired = true) });
    await insertRecords(context(), 'Account', [{ Name: 'Bulk load' }], { skipAutomation: true });
    expect(fired).toBe(false);
  });
});
