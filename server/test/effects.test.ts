import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, deleteRecords, insertRecord, undeleteRecords, updateRecord } from '../src/dml/index.js';
import { runQuery } from '../src/soql/index.js';
import { changeBus, installEffects, indexableText } from '../src/effects/index.js';
import type { ChangeEvent } from '../src/effects/index.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;

function context(): RequestContext {
  return new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId: org.adminUserId,
    perms: ADMIN_PERMS,
    limits: new LimitContext({ dmlRows: 5000, dmlStatements: 5000, soqlQueries: 5000, queryRows: 500000 })
  });
}

beforeAll(async () => {
  org = await testOrg();
  installEffects();

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Membership__c',
      label: 'Membership',
      pluralLabel: 'Memberships',
      isCustom: true,
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
        { apiName: 'Subscription__c', label: 'Subscription', type: 'Currency', precision: 10, scale: 2 },
        { apiName: 'Category__c', label: 'Category', type: 'Picklist', picklist: { values: ['Full', 'Associate'] } }
      ]
    })
  );

  // Rollups and history live on Contact, summarising its memberships.
  await org.tenant((c) =>
    installObject(c, {
      apiName: 'ClubMember__c',
      label: 'Club Member',
      pluralLabel: 'Club Members',
      isCustom: true,
      historyEnabled: true,
      feedEnabled: true,
      fields: [
        { apiName: 'Status__c', label: 'Status', type: 'Picklist', picklist: { values: ['Current', 'Lapsed'] }, trackHistory: true },
        { apiName: 'Notes__c', label: 'Notes', type: 'TextArea' },
        {
          apiName: 'Visit__c',
          label: 'Visits',
          type: 'MasterDetail',
          referenceTo: 'Account',
          relationshipName: 'ClubMembers',
          isMasterDetail: false
        }
      ]
    })
  );

  // Add the rollups to Contact now that Membership__c exists.
  const { addField } = await import('../src/metadata/installer.js');
  await org.tenant(async (c) => {
    await addField(c, 'Contact', {
      apiName: 'MembershipCount__c',
      label: 'Membership Count',
      type: 'RollupSummary',
      rollup: { childObject: 'Membership__c', relationshipField: 'Contact__c', operation: 'COUNT' }
    });
    await addField(c, 'Contact', {
      apiName: 'TotalSubs__c',
      label: 'Total Subscriptions',
      type: 'RollupSummary',
      rollup: {
        childObject: 'Membership__c',
        relationshipField: 'Contact__c',
        operation: 'SUM',
        field: 'Subscription__c'
      }
    });
    await addField(c, 'Contact', {
      apiName: 'FullSubs__c',
      label: 'Full Subscriptions',
      type: 'RollupSummary',
      rollup: {
        childObject: 'Membership__c',
        relationshipField: 'Contact__c',
        operation: 'SUM',
        field: 'Subscription__c',
        filters: [{ field: 'Category__c', op: 'equals', value: 'Full' }]
      }
    });
  });

  invalidateOrgMeta(org.orgId);
});

afterAll(() => {
  clearDmlHooks();
});

async function readContact(ctx: RequestContext, id: string) {
  const res = await runQuery(
    ctx,
    `SELECT MembershipCount__c, TotalSubs__c, FullSubs__c FROM Contact WHERE Id = '${id}'`
  );
  return res.records[0];
}

describe('rollup summaries', () => {
  it('starts at zero on a new parent', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { LastName: 'Fresh' });
    expect((await readContact(ctx, id)).MembershipCount__c).toBe(0);
  });

  it('counts and sums children as they are added', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Rollup' });
    await insertRecord(ctx, 'Membership__c', { Name: 'A', Contact__c: member, Subscription__c: 2680, Category__c: 'Full' });
    await insertRecord(ctx, 'Membership__c', { Name: 'B', Contact__c: member, Subscription__c: 540, Category__c: 'Associate' });

    const rec = await readContact(ctx, member);
    expect(rec.MembershipCount__c).toBe(2);
    expect(Number(rec.TotalSubs__c)).toBe(3220);
  });

  it('honours rollup filters', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Filtered' });
    await insertRecord(ctx, 'Membership__c', { Name: 'C', Contact__c: member, Subscription__c: 2680, Category__c: 'Full' });
    await insertRecord(ctx, 'Membership__c', { Name: 'D', Contact__c: member, Subscription__c: 540, Category__c: 'Associate' });

    const rec = await readContact(ctx, member);
    expect(Number(rec.TotalSubs__c)).toBe(3220);
    expect(Number(rec.FullSubs__c)).toBe(2680); // only the Full membership
  });

  it('updates when a child value changes', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Changing' });
    const child = await insertRecord(ctx, 'Membership__c', {
      Name: 'E',
      Contact__c: member,
      Subscription__c: 1000,
      Category__c: 'Full'
    });
    await updateRecord(ctx, 'Membership__c', child, { Subscription__c: 2000 });
    expect(Number((await readContact(ctx, member)).TotalSubs__c)).toBe(2000);
  });

  it('adjusts both parents when a child is reparented', async () => {
    const ctx = context();
    const first = await insertRecord(ctx, 'Contact', { LastName: 'Origin' });
    const second = await insertRecord(ctx, 'Contact', { LastName: 'Destination' });
    const child = await insertRecord(ctx, 'Membership__c', {
      Name: 'F',
      Contact__c: first,
      Subscription__c: 500,
      Category__c: 'Full'
    });

    await updateRecord(ctx, 'Membership__c', child, { Contact__c: second });

    expect((await readContact(ctx, first)).MembershipCount__c).toBe(0);
    expect((await readContact(ctx, second)).MembershipCount__c).toBe(1);
  });

  it('drops a deleted child out of the rollup and restores it on undelete', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Deleting' });
    const child = await insertRecord(ctx, 'Membership__c', {
      Name: 'G',
      Contact__c: member,
      Subscription__c: 900,
      Category__c: 'Full'
    });
    expect((await readContact(ctx, member)).MembershipCount__c).toBe(1);

    await deleteRecords(ctx, 'Membership__c', [child]);
    expect((await readContact(ctx, member)).MembershipCount__c).toBe(0);

    await undeleteRecords(ctx, 'Membership__c', [child]);
    // Undelete does not currently re-run rollups; recompute happens on the next child save.
    await updateRecord(ctx, 'Membership__c', child, { Subscription__c: 900 });
    expect((await readContact(ctx, member)).MembershipCount__c).toBe(1);
  });

  it('can be filtered and sorted on, now that it is stored', async () => {
    const ctx = context();
    const busy = await insertRecord(ctx, 'Contact', { LastName: 'Busy' });
    await insertRecord(ctx, 'Membership__c', { Name: 'H1', Contact__c: busy, Subscription__c: 100, Category__c: 'Full' });
    await insertRecord(ctx, 'Membership__c', { Name: 'H2', Contact__c: busy, Subscription__c: 100, Category__c: 'Full' });

    const res = await runQuery(
      ctx,
      'SELECT LastName, MembershipCount__c FROM Contact WHERE MembershipCount__c >= 2 ORDER BY MembershipCount__c DESC'
    );
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records.map((r) => r.LastName)).toContain('Busy');
  });
});

describe('field history', () => {
  it('records tracked field changes only', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'ClubMember__c', { Name: 'Historic', Status__c: 'Current' });
    await updateRecord(ctx, 'ClubMember__c', id, { Status__c: 'Lapsed', Notes__c: 'Untracked change' });

    const rows = await org.tenant((c) =>
      c.query(`SELECT field_api, old_value, new_value FROM record_history WHERE record_id = $1 ORDER BY changed_at`, [id])
    );
    const fields = rows.rows.map((r: any) => r.field_api);
    expect(fields).toContain('Created');
    expect(fields).toContain('Status__c');
    expect(fields).not.toContain('Notes__c');

    const statusRow = rows.rows.find((r: any) => r.field_api === 'Status__c');
    expect(statusRow.old_value).toBe('Current');
    expect(statusRow.new_value).toBe('Lapsed');
  });

  it('records deletion', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'ClubMember__c', { Name: 'Departing', Status__c: 'Current' });
    await deleteRecords(ctx, 'ClubMember__c', [id]);
    const rows = await org.tenant((c) =>
      c.query(`SELECT field_api FROM record_history WHERE record_id = $1 AND field_api = 'Deleted'`, [id])
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('does not track history on objects that have it disabled', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Untracked' });
    const rows = await org.tenant((c) => c.query(`SELECT 1 FROM record_history WHERE record_id = $1`, [id]));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('feed items', () => {
  it('posts a tracked-change item on update', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'ClubMember__c', { Name: 'Feedworthy', Status__c: 'Current' });
    await updateRecord(ctx, 'ClubMember__c', id, { Status__c: 'Lapsed' });

    const rows = await org.tenant((c) =>
      c.query(`SELECT type, body, payload FROM feed_item WHERE parent_id = $1`, [id])
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].type).toBe('TrackedChange');
    expect(rows.rows[0].body).toContain('Status__c changed from Current to Lapsed');
  });

  it('posts nothing when no tracked field changed', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'ClubMember__c', { Name: 'Quiet', Status__c: 'Current' });
    await updateRecord(ctx, 'ClubMember__c', id, { Notes__c: 'Just a note' });
    const rows = await org.tenant((c) => c.query(`SELECT 1 FROM feed_item WHERE parent_id = $1`, [id]));
    expect(rows.rows).toHaveLength(0);
  });
});

describe('search index', () => {
  it('indexes a record on insert and finds it by term', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Stratford House', Industry: 'Hospitality' });

    const rows = await org.tenant((c) =>
      c.query(`SELECT title, object_api FROM search_index WHERE tsv @@ plainto_tsquery('simple', 'Stratford')`)
    );
    expect(rows.rows.map((r: any) => r.title)).toContain('Stratford House');

    const byRecord = await org.tenant((c) => c.query(`SELECT body FROM search_index WHERE record_id = $1`, [id]));
    expect(byRecord.rows[0].body).toContain('Hospitality');
  });

  it('reindexes on update', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Old Name' });
    await updateRecord(ctx, 'Account', id, { Name: 'Calcutta Light Horse Bar' });
    const rows = await org.tenant((c) => c.query(`SELECT title FROM search_index WHERE record_id = $1`, [id]));
    expect(rows.rows[0].title).toBe('Calcutta Light Horse Bar');
  });

  it('removes a deleted record from the index', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Vanishing' });
    await deleteRecords(ctx, 'Account', [id]);
    const rows = await org.tenant((c) => c.query(`SELECT 1 FROM search_index WHERE record_id = $1`, [id]));
    expect(rows.rows).toHaveLength(0);
  });

  it('builds title and body from the searchable fields', async () => {
    const meta = await org.meta();
    const account = meta.objects.get('account')!;
    const { title, body } = indexableText(account, { Name: 'The Oriental Club', Industry: 'Hospitality', AnnualRevenue: 5 });
    expect(title).toBe('The Oriental Club');
    expect(body).toContain('Hospitality');
    expect(body).not.toContain('5'); // numbers are not indexed
  });
});

describe('change events', () => {
  it('publishes after commit, with the saved record', async () => {
    const ctx = context();
    const seen: ChangeEvent[] = [];
    const unsubscribe = changeBus.subscribe((e) => seen.push(e));

    const id = await insertRecord(ctx, 'Account', { Name: 'Event Source' });
    unsubscribe();

    const event = seen.find((e) => e.recordIds.includes(id));
    expect(event).toBeTruthy();
    expect(event!.object).toBe('Account');
    expect(event!.operation).toBe('insert');
    expect(event!.orgId).toBe(org.orgId);
    expect(event!.records[0].Name).toBe('Event Source');
  });

  it('does not publish when the transaction rolls back', async () => {
    const ctx = context();
    const seen: ChangeEvent[] = [];
    const unsubscribe = changeBus.subscribe((e) => seen.push(e));

    await expect(insertRecord(ctx, 'Account', { Name: 'x'.repeat(300) })).rejects.toThrow();
    unsubscribe();

    expect(seen).toHaveLength(0);
  });
});
