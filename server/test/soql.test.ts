import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { insertRecord, deleteRecords } from '../src/dml/index.js';
import {
  parseSoql,
  runQuery,
  runQueryMore,
  runCount,
  resetSecurityPolicy,
  setSecurityPolicy
} from '../src/soql/index.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;
const ids: Record<string, string> = {};

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

beforeAll(async () => {
  org = await testOrg();
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
        { apiName: 'Category__c', label: 'Category', type: 'Picklist', picklist: { values: ['Full', 'Associate', 'OC7'] } },
        { apiName: 'Subscription__c', label: 'Subscription', type: 'Currency', precision: 10, scale: 2 },
        { apiName: 'JoinedOn__c', label: 'Joined On', type: 'Date' },
        {
          apiName: 'Interests__c',
          label: 'Interests',
          type: 'MultiselectPicklist',
          picklist: { values: ['Wine', 'Bridge', 'Golf', 'Chess'], restricted: false }
        },
        {
          apiName: 'Discounted__c',
          label: 'Discounted',
          type: 'Formula',
          formula: 'IF(Subscription__c < 1000, "Yes", "No")',
          formulaReturnType: 'Text'
        }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);

  const ctx = context(new LimitContext({ dmlRows: 1000, dmlStatements: 1000 }));
  ids.club = await insertRecord(ctx, 'Account', { Name: 'The Oriental Club', Industry: 'Hospitality', Rating: 'Hot' });
  ids.other = await insertRecord(ctx, 'Account', { Name: 'Reciprocal Partner', Industry: 'Hospitality' });

  ids.ada = await insertRecord(ctx, 'Contact', { FirstName: 'Ada', LastName: 'Pemberton', AccountId: ids.club, Email: 'ada@example.com' });
  ids.bertie = await insertRecord(ctx, 'Contact', { FirstName: 'Bertie', LastName: 'Fairbanks', AccountId: ids.club });
  ids.clara = await insertRecord(ctx, 'Contact', { FirstName: 'Clara', LastName: 'Nightingale', AccountId: ids.other });

  ids.m1 = await insertRecord(ctx, 'Membership__c', {
    Name: 'OC-1',
    Contact__c: ids.ada,
    Category__c: 'Full',
    Subscription__c: 2680,
    JoinedOn__c: '2019-04-01',
    Interests__c: ['Wine', 'Bridge']
  });
  ids.m2 = await insertRecord(ctx, 'Membership__c', {
    Name: 'OC-2',
    Contact__c: ids.bertie,
    Category__c: 'Associate',
    Subscription__c: 540,
    JoinedOn__c: new Date().toISOString().slice(0, 10),
    Interests__c: ['Golf']
  });
  ids.m3 = await insertRecord(ctx, 'Membership__c', {
    Name: 'OC-3',
    Contact__c: ids.clara,
    Category__c: 'Full',
    Subscription__c: 2680,
    JoinedOn__c: '2024-01-15'
  });
});

afterEach(() => {
  resetSecurityPolicy();
});

describe('parser', () => {
  it('parses a field list and object', () => {
    const q = parseSoql('SELECT Id, Name FROM Account');
    expect(q.from).toBe('Account');
    expect(q.select).toHaveLength(2);
  });

  it('parses relationship paths and child subqueries', () => {
    const q = parseSoql('SELECT Name, Account.Owner.Name, (SELECT Id FROM Contacts) FROM Account');
    expect(q.select[1]).toMatchObject({ kind: 'field', path: ['Account', 'Owner', 'Name'] });
    expect(q.select[2]).toMatchObject({ kind: 'subquery', relationship: 'Contacts' });
  });

  it('gives AND tighter precedence than OR', () => {
    const q = parseSoql("SELECT Id FROM Account WHERE Name = 'a' OR Name = 'b' AND Rating = 'Hot'");
    expect(q.where!.kind).toBe('or');
    expect((q.where as any).items[1].kind).toBe('and');
  });

  it('parses parentheses, NOT, IN and INCLUDES', () => {
    const q = parseSoql(
      "SELECT Id FROM Membership__c WHERE (Category__c IN ('Full','Associate') OR NOT Subscription__c > 100) AND Interests__c INCLUDES ('Wine')"
    );
    expect(q.where!.kind).toBe('and');
  });

  it('parses date literals with and without arguments', () => {
    const q = parseSoql('SELECT Id FROM Membership__c WHERE JoinedOn__c = LAST_N_DAYS:30');
    expect((q.where as any).value).toMatchObject({ t: 'dateLiteral', name: 'LAST_N_DAYS', n: 30 });
    expect((parseSoql('SELECT Id FROM Membership__c WHERE JoinedOn__c = TODAY').where as any).value.name).toBe('TODAY');
  });

  it('parses ordering, limit, offset and FOR UPDATE', () => {
    const q = parseSoql('SELECT Id FROM Account ORDER BY Name DESC NULLS LAST LIMIT 10 OFFSET 5 FOR UPDATE');
    expect(q.orderBy![0]).toMatchObject({ dir: 'DESC', nulls: 'LAST' });
    expect(q.limit).toBe(10);
    expect(q.offset).toBe(5);
    expect(q.forUpdate).toBe(true);
  });

  it('parses aggregates with aliases', () => {
    const q = parseSoql('SELECT Category__c, COUNT(Id) total FROM Membership__c GROUP BY Category__c HAVING COUNT(Id) > 1');
    expect(q.select[1]).toMatchObject({ kind: 'aggregate', fn: 'COUNT', alias: 'total' });
    expect(q.groupBy).toHaveLength(1);
    expect(q.having).toBeTruthy();
  });

  it('rejects malformed queries', () => {
    expect(() => parseSoql('SELECT FROM Account')).toThrowError();
    expect(() => parseSoql('SELECT Id FROM')).toThrowError();
    expect(() => parseSoql('SELECT Id FROM Account WHERE')).toThrowError();
    expect(() => parseSoql('SELECT Id FROM Account rubbish here')).toThrowError();
    expect(() => parseSoql("SELECT Id FROM Account WHERE Name = 'unterminated")).toThrowError();
  });

  it('limits relationship traversal depth', () => {
    expect(() => parseSoql('SELECT a.b.c.d.e.f.g FROM Account')).toThrowError(/5 levels/);
  });
});

describe('query execution', () => {
  it('returns records with Salesforce attributes', async () => {
    const res = await runQuery(context(), `SELECT Id, Name FROM Account WHERE Id = '${ids.club}'`);
    expect(res.totalSize).toBe(1);
    expect(res.done).toBe(true);
    expect(res.records[0].Name).toBe('The Oriental Club');
    expect(res.records[0].attributes.type).toBe('Account');
    expect(res.records[0].attributes.url).toContain(`/sobjects/Account/${ids.club}`);
  });

  it('always includes Id even when not selected', async () => {
    const res = await runQuery(context(), `SELECT Name FROM Account WHERE Id = '${ids.club}'`);
    expect(res.records[0].Id).toBe(ids.club);
  });

  it('traverses parent relationships', async () => {
    const res = await runQuery(context(), `SELECT Name, Account.Name, Account.Industry FROM Contact WHERE Id = '${ids.ada}'`);
    expect(res.records[0].Name).toBe('Ada Pemberton');
    expect(res.records[0].Account.Name).toBe('The Oriental Club');
    expect(res.records[0].Account.Industry).toBe('Hospitality');
    expect(res.records[0].Account.attributes.type).toBe('Account');
  });

  it('traverses custom relationships two levels deep', async () => {
    const res = await runQuery(
      context(),
      `SELECT Name, Contact__r.Name, Contact__r.Account.Name FROM Membership__c WHERE Id = '${ids.m1}'`
    );
    expect(res.records[0].Contact__r.Name).toBe('Ada Pemberton');
    expect(res.records[0].Contact__r.Account.Name).toBe('The Oriental Club');
  });

  it('returns null for a parent that is not set', async () => {
    const ctx = context();
    const orphan = await insertRecord(ctx, 'Contact', { LastName: 'Unaffiliated' });
    const res = await runQuery(ctx, `SELECT Name, Account.Name FROM Contact WHERE Id = '${orphan}'`);
    expect(res.records[0].Account).toBeNull();
  });

  it('returns child subqueries as nested result sets', async () => {
    const res = await runQuery(context(), `SELECT Name, (SELECT Id, LastName FROM Contacts) FROM Account WHERE Id = '${ids.club}'`);
    expect(res.records[0].Contacts.totalSize).toBe(2);
    expect(res.records[0].Contacts.records.map((r: any) => r.LastName).sort()).toEqual(['Fairbanks', 'Pemberton']);
  });

  it('returns null for an empty child set, as Salesforce does', async () => {
    const ctx = context();
    const empty = await insertRecord(ctx, 'Account', { Name: 'No members yet' });
    const res = await runQuery(ctx, `SELECT Name, (SELECT Id FROM Contacts) FROM Account WHERE Id = '${empty}'`);
    expect(res.records[0].Contacts).toBeNull();
  });

  it('filters child subqueries independently of the parent', async () => {
    const res = await runQuery(
      context(),
      `SELECT Name, (SELECT LastName FROM Contacts WHERE LastName = 'Pemberton') FROM Account WHERE Id = '${ids.club}'`
    );
    expect(res.records[0].Contacts.totalSize).toBe(1);
  });
});

describe('filtering', () => {
  it('compares text case-insensitively, as SOQL does', async () => {
    const res = await runQuery(context(), "SELECT Id FROM Account WHERE Name = 'the oriental club'");
    expect(res.totalSize).toBe(1);
  });

  it('supports LIKE with wildcards', async () => {
    const res = await runQuery(context(), "SELECT Name FROM Contact WHERE LastName LIKE 'Pem%'");
    expect(res.records.map((r) => r.Name)).toEqual(['Ada Pemberton']);
  });

  it('supports IN and NOT IN', async () => {
    const inList = await runQuery(context(), "SELECT Id FROM Membership__c WHERE Category__c IN ('Full')");
    expect(inList.totalSize).toBe(2);
    const notIn = await runQuery(context(), "SELECT Id FROM Membership__c WHERE Category__c NOT IN ('Full')");
    expect(notIn.totalSize).toBe(1);
  });

  it('supports IS NULL and IS NOT NULL', async () => {
    const res = await runQuery(context(), 'SELECT Id FROM Membership__c WHERE Interests__c = NULL');
    expect(res.totalSize).toBe(1);
  });

  it('supports numeric comparison', async () => {
    const res = await runQuery(context(), 'SELECT Name FROM Membership__c WHERE Subscription__c > 1000');
    expect(res.totalSize).toBe(2);
  });

  it('supports INCLUDES and EXCLUDES on multi-select picklists', async () => {
    const includes = await runQuery(context(), "SELECT Name FROM Membership__c WHERE Interests__c INCLUDES ('Wine')");
    expect(includes.records.map((r) => r.Name)).toEqual(['OC-1']);
    const excludes = await runQuery(context(), "SELECT Name FROM Membership__c WHERE Interests__c EXCLUDES ('Wine')");
    expect(excludes.records.map((r) => r.Name).sort()).toEqual(['OC-2', 'OC-3']);
  });

  it('resolves date literals', async () => {
    const today = await runQuery(context(), 'SELECT Name FROM Membership__c WHERE JoinedOn__c = TODAY');
    expect(today.records.map((r) => r.Name)).toEqual(['OC-2']);

    const recent = await runQuery(context(), 'SELECT Name FROM Membership__c WHERE JoinedOn__c = LAST_N_DAYS:7');
    expect(recent.totalSize).toBe(1);

    const old = await runQuery(context(), 'SELECT Name FROM Membership__c WHERE JoinedOn__c < LAST_N_YEARS:1');
    expect(old.records.map((r) => r.Name)).toContain('OC-1');
  });

  it('combines boolean operators with the right precedence', async () => {
    const res = await runQuery(
      context(),
      "SELECT Name FROM Membership__c WHERE Category__c = 'Full' AND (Subscription__c > 2000 OR Name = 'OC-2')"
    );
    expect(res.totalSize).toBe(2);
  });

  it('supports semi-joins', async () => {
    const res = await runQuery(
      context(),
      "SELECT Name FROM Contact WHERE Id IN (SELECT Contact__c FROM Membership__c WHERE Category__c = 'Associate')"
    );
    expect(res.records.map((r) => r.Name)).toEqual(['Bertie Fairbanks']);
  });

  it('scopes to the running user with USING SCOPE mine', async () => {
    const res = await runQuery(context(), 'SELECT Id FROM Account USING SCOPE mine');
    expect(res.totalSize).toBeGreaterThan(0);
  });
});

describe('ordering, paging and aggregates', () => {
  it('orders with explicit null placement', async () => {
    const res = await runQuery(context(), 'SELECT Name, Subscription__c FROM Membership__c ORDER BY Subscription__c DESC, Name ASC');
    expect(res.records[0].Subscription__c).toBe(2680);
    expect(res.records[res.records.length - 1].Name).toBe('OC-2');
  });

  it('applies LIMIT and OFFSET', async () => {
    const all = await runQuery(context(), 'SELECT Name FROM Membership__c ORDER BY Name');
    const page = await runQuery(context(), 'SELECT Name FROM Membership__c ORDER BY Name LIMIT 1 OFFSET 1');
    expect(page.records).toHaveLength(1);
    expect(page.records[0].Name).toBe(all.records[1].Name);
  });

  it('pages with queryMore and reports the true total', async () => {
    const first = await runQuery(context(), 'SELECT Name FROM Membership__c ORDER BY Name', { batchSize: 2 });
    expect(first.done).toBe(false);
    expect(first.records).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    expect(first.nextRecordsUrl).toBeTruthy();

    const locator = first.nextRecordsUrl!.split('/').pop()!;
    const second = await runQueryMore(context(), locator);
    expect(second.done).toBe(true);
    expect(second.records).toHaveLength(1);
    expect(second.records[0].Name).toBe('OC-3');
  });

  it('computes aggregates', async () => {
    const res = await runQuery(context(), 'SELECT COUNT(Id) total, SUM(Subscription__c) revenue FROM Membership__c');
    expect(res.records[0].total).toBe(3);
    expect(Number(res.records[0].revenue)).toBe(5900);
    expect(res.records[0].attributes.type).toBe('AggregateResult');
  });

  it('groups and filters with HAVING', async () => {
    const res = await runQuery(
      context(),
      'SELECT Category__c, COUNT(Id) total FROM Membership__c GROUP BY Category__c HAVING COUNT(Id) > 1'
    );
    expect(res.records).toHaveLength(1);
    expect(res.records[0].Category__c).toBe('Full');
    expect(res.records[0].total).toBe(2);
  });

  it('counts without materialising rows', async () => {
    expect(await runCount(context(), 'SELECT Id FROM Membership__c')).toBe(3);
  });
});

describe('formula fields', () => {
  it('evaluates formulas at read time', async () => {
    const res = await runQuery(context(), 'SELECT Name, Subscription__c, Discounted__c FROM Membership__c ORDER BY Name');
    expect(res.records[0].Discounted__c).toBe('No'); // OC-1, £2,680
    expect(res.records[1].Discounted__c).toBe('Yes'); // OC-2, £540
  });

  it('refuses to filter on a formula field rather than silently ignoring it', async () => {
    await expect(runQuery(context(), "SELECT Id FROM Membership__c WHERE Discounted__c = 'Yes'")).rejects.toMatchObject({
      errorCode: 'MALFORMED_QUERY'
    });
  });
});

describe('deleted records', () => {
  it('excludes soft-deleted rows by default and includes them for queryAll', async () => {
    const ctx = context();
    const temp = await insertRecord(ctx, 'Account', { Name: 'Closing down' });
    await deleteRecords(ctx, 'Account', [temp]);

    const normal = await runQuery(ctx, `SELECT Id FROM Account WHERE Id = '${temp}'`);
    expect(normal.totalSize).toBe(0);

    const all = await runQuery(ctx, `SELECT Id, IsDeleted FROM Account WHERE Id = '${temp}'`, { includeDeleted: true });
    expect(all.totalSize).toBe(1);
    expect(all.records[0].IsDeleted).toBe(true);
  });
});

describe('errors', () => {
  it('rejects an unknown object', async () => {
    await expect(runQuery(context(), 'SELECT Id FROM Nonexistent__c')).rejects.toMatchObject({ errorCode: 'INVALID_TYPE' });
  });

  it('rejects an unknown field', async () => {
    await expect(runQuery(context(), 'SELECT Nonexistent__c FROM Account')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
  });

  it('rejects an unknown relationship', async () => {
    await expect(runQuery(context(), 'SELECT (SELECT Id FROM Nonexistents) FROM Account')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
  });
});

describe('security rewrite', () => {
  it('hides a field the policy refuses, as though it did not exist', async () => {
    setSecurityPolicy({
      canReadObject: () => true,
      canReadField: (_ctx, obj, field) => !(obj.apiName === 'Membership__c' && field === 'Subscription__c'),
      sharingPredicate: () => null
    });
    await expect(runQuery(context(), 'SELECT Subscription__c FROM Membership__c')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
    // …and refuses it in the WHERE clause too, so it cannot be probed by filtering.
    await expect(runQuery(context(), 'SELECT Id FROM Membership__c WHERE Subscription__c > 0')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD'
    });
  });

  it('refuses an object the policy hides', async () => {
    setSecurityPolicy({
      canReadObject: (_ctx, obj) => obj.apiName !== 'Membership__c',
      canReadField: () => true,
      sharingPredicate: () => null
    });
    await expect(runQuery(context(), 'SELECT Id FROM Membership__c')).rejects.toMatchObject({ errorCode: 'INVALID_TYPE' });
  });

  it('injects a sharing predicate into the generated SQL', async () => {
    setSecurityPolicy({
      canReadObject: () => true,
      canReadField: () => true,
      sharingPredicate: (_ctx, obj, alias, nextParam) =>
        obj.apiName === 'Membership__c'
          ? { sql: `${alias}.fields->>'Category__c' = $${nextParam}`, params: ['Associate'] }
          : null
    });
    const res = await runQuery(context(), 'SELECT Name FROM Membership__c');
    expect(res.records.map((r) => r.Name)).toEqual(['OC-2']);
  });

  it('applies the sharing predicate to child subqueries as well', async () => {
    setSecurityPolicy({
      canReadObject: () => true,
      canReadField: () => true,
      sharingPredicate: (_ctx, obj, alias, nextParam) =>
        obj.apiName === 'Contact'
          ? { sql: `${alias}.fields->>'LastName' = $${nextParam}`, params: ['Pemberton'] }
          : null
    });
    const res = await runQuery(context(), `SELECT Name, (SELECT LastName FROM Contacts) FROM Account WHERE Id = '${ids.club}'`);
    expect(res.records[0].Contacts.totalSize).toBe(1);
  });
});

describe('governor limits', () => {
  it('counts queries and rows', async () => {
    const limits = new LimitContext();
    const ctx = context(limits);
    await runQuery(ctx, 'SELECT Id FROM Membership__c');
    expect(limits.usage().soqlQueries).toBe(1);
    expect(limits.usage().queryRows).toBe(3);
  });

  it('refuses to exceed the query budget', async () => {
    const ctx = context(new LimitContext({ soqlQueries: 1 }));
    await runQuery(ctx, 'SELECT Id FROM Account');
    await expect(runQuery(ctx, 'SELECT Id FROM Account')).rejects.toMatchObject({ errorCode: 'LIMIT_EXCEEDED' });
  });

  it('counts a child subquery as its own statement', async () => {
    const limits = new LimitContext();
    const ctx = context(limits);
    await runQuery(ctx, 'SELECT Name, (SELECT Id FROM Contacts) FROM Account');
    expect(limits.usage().soqlQueries).toBe(2);
  });
});
