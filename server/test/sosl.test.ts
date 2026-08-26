import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { rawInsert, ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { generateId, KEY_PREFIXES } from '../src/util/ids.js';
import { clearDmlHooks, deleteRecords, insertRecord, undeleteRecords, updateRecord } from '../src/dml/index.js';
import { resetSecurityPolicy } from '../src/soql/index.js';
import { installEffects, indexableText } from '../src/effects/index.js';
import {
  installSecurity,
  invalidateUserAccess,
  setOrgWideDefault,
  shareRecord
} from '../src/security/index.js';
import { parseSosl, parseSearchTerm, runSosl, suggest, toTsQuery } from '../src/sosl/index.js';
import { reindexSearch } from '../src/scheduler/index.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;
const users: Record<string, string> = {};
const ids: Record<string, string> = {};

function context(userId?: string): RequestContext {
  return new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId: userId ?? org.adminUserId,
    perms: userId ? undefined : ADMIN_PERMS,
    limits: new LimitContext({ dmlRows: 5000, dmlStatements: 5000, soqlQueries: 5000, queryRows: 500000 })
  });
}

beforeAll(async () => {
  org = await testOrg();
  installEffects();

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Reciprocal_Club__c',
      label: 'Reciprocal Club',
      pluralLabel: 'Reciprocal Clubs',
      isCustom: true,
      fields: [
        { apiName: 'City__c', label: 'City', type: 'Text', length: 80 },
        { apiName: 'Country__c', label: 'Country', type: 'Text', length: 80 },
        { apiName: 'Notes__c', label: 'Notes', type: 'LongTextArea' },
        { apiName: 'Contact_Email__c', label: 'Contact Email', type: 'Email' },
        { apiName: 'Telephone__c', label: 'Telephone', type: 'Phone' }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);

  const ctx = context();
  ids.oriental = await insertRecord(ctx, 'Reciprocal_Club__c', {
    Name: 'The Oriental Club',
    City__c: 'London',
    Country__c: 'United Kingdom',
    Notes__c: 'Founded 1824 by the Duke of Wellington. Stratford House.',
    Contact_Email__c: 'reservations@orientalclub.org.uk',
    Telephone__c: '020 7290 1400'
  });
  ids.wellington = await insertRecord(ctx, 'Reciprocal_Club__c', {
    Name: 'Wellington Club',
    City__c: 'Wellington',
    Country__c: 'New Zealand',
    Notes__c: 'Reciprocal since 1998. Letters of introduction required.',
    Contact_Email__c: 'secretary@wellingtonclub.nz',
    Telephone__c: '+64 4 555 0101'
  });
  ids.bengal = await insertRecord(ctx, 'Reciprocal_Club__c', {
    Name: 'Bengal Club',
    City__c: 'Kolkata',
    Country__c: 'India',
    Notes__c: 'Oldest club in India. Oriental connections through the East India Company.',
    Contact_Email__c: 'enquiries@bengalclub.in',
    Telephone__c: '+91 33 2299 1000'
  });

  ids.amelia = await insertRecord(ctx, 'Contact', {
    FirstName: 'Amelia',
    LastName: 'Fitzgerald',
    Email: 'a.fitzgerald@example.com'
  });
});

afterAll(() => {
  clearDmlHooks();
  resetSecurityPolicy();
});

// ------------------------------------------------------------------- parsing

describe('SOSL parsing', () => {
  it('parses a bare FIND', () => {
    const q = parseSosl('FIND {oriental}');
    expect(q.find).toEqual({ kind: 'term', value: 'oriental', wildcard: false });
    expect(q.group).toBe('ALL');
    expect(q.returning).toEqual([]);
  });

  it('parses a search group', () => {
    expect(parseSosl('FIND {oriental} IN NAME FIELDS').group).toBe('NAME');
    expect(parseSosl('FIND {a@b.com} IN EMAIL FIELDS').group).toBe('EMAIL');
    expect(parseSosl('FIND {020} IN PHONE FIELDS').group).toBe('PHONE');
  });

  it('treats juxtaposed terms as AND and honours explicit operators', () => {
    expect(parseSearchTerm('oriental club').kind).toBe('and');
    expect(parseSearchTerm('oriental OR bengal').kind).toBe('or');
    expect(parseSearchTerm('oriental AND club').kind).toBe('and');
    expect(parseSearchTerm('NOT bengal').kind).toBe('not');
  });

  it('parses phrases, wildcards and parentheses', () => {
    expect(parseSearchTerm('"east india company"')).toEqual({
      kind: 'phrase',
      words: ['east', 'india', 'company']
    });
    expect(parseSearchTerm('orient*')).toEqual({ kind: 'term', value: 'orient', wildcard: true });
    const grouped = parseSearchTerm('(oriental OR bengal) AND club');
    expect(grouped.kind).toBe('and');
  });

  it('parses a RETURNING clause with fields, WHERE, ORDER BY and LIMIT', () => {
    const q = parseSosl(
      "FIND {club} RETURNING Reciprocal_Club__c(Id, Name, City__c WHERE Country__c = 'India' ORDER BY Name LIMIT 5)"
    );
    expect(q.returning).toHaveLength(1);
    const body = q.returning[0].query;
    expect(body.from).toBe('Reciprocal_Club__c');
    expect(body.select).toHaveLength(3);
    expect(body.where).toEqual({
      kind: 'cmp',
      path: ['Country__c'],
      op: '=',
      value: { t: 'string', v: 'India' }
    });
    expect(body.orderBy?.[0].path).toEqual(['Name']);
    expect(body.limit).toBe(5);
  });

  it('parses several RETURNING objects and an overall LIMIT', () => {
    const q = parseSosl('FIND {club} RETURNING Reciprocal_Club__c(Id, Name), Contact(Id, LastName) LIMIT 10');
    expect(q.returning.map((r) => r.objectApi)).toEqual(['Reciprocal_Club__c', 'Contact']);
    expect(q.limit).toBe(10);
  });

  it('defaults a bodyless RETURNING to Id only', () => {
    const q = parseSosl('FIND {club} RETURNING Contact');
    expect(q.returning[0].query.select).toEqual([{ kind: 'field', path: ['Id'] }]);
  });

  it('rejects searches the index cannot answer', () => {
    expect(() => parseSosl('FIND {*club}')).toThrow(/may not begin with the wildcard/);
    expect(() => parseSosl('FIND {cl?b}')).toThrow(/not supported/);
    expect(() => parseSosl('FIND {ori*ental}')).toThrow(/only supported at the end/);
    expect(() => parseSosl('FIND {oriental')).toThrow(/unterminated/);
    expect(() => parseSosl('FIND {}')).toThrow(/empty/);
    expect(() => parseSosl('SELECT Id FROM Contact')).toThrow(/must begin with FIND/);
  });
});

describe('tsquery compilation', () => {
  it('strips tsquery operators out of a lexeme', () => {
    // Quotes, colons, ampersands and backslashes are tsquery syntax; none may survive unquoted.
    const q = toTsQuery(parseSearchTerm("x';DROP&TABLE:1"));
    expect(q).toBe("'x' <-> ';DROP' <-> 'TABLE' <-> '1'");
  });

  it('rejects a term whose parentheses do not balance', () => {
    expect(() => parseSearchTerm("') OR 1=1 --")).toThrow(/unexpected '\)'/);
  });

  it('compiles operators and wildcards to tsquery syntax', () => {
    expect(toTsQuery(parseSearchTerm('a AND b'))).toBe("('a' & 'b')");
    expect(toTsQuery(parseSearchTerm('a OR b'))).toBe("('a' | 'b')");
    expect(toTsQuery(parseSearchTerm('NOT a'))).toBe("!('a')");
    expect(toTsQuery(parseSearchTerm('ori*'))).toBe("'ori':*");
    expect(toTsQuery(parseSearchTerm('"east india"'))).toBe("('east' <-> 'india')");
  });
});

// ----------------------------------------------------------------- searching

describe('running a search', () => {
  it('finds a record by a word in its name', async () => {
    const res = await runSosl(context(), 'FIND {oriental} RETURNING Reciprocal_Club__c(Id, Name)');
    expect(res.searchRecords.map((r) => r.Id)).toContain(ids.oriental);
  });

  it('searches every indexed field, not just the name', async () => {
    const res = await runSosl(context(), 'FIND {wellington} RETURNING Reciprocal_Club__c(Id, Name)');
    const found = res.searchRecords.map((r) => r.Id);
    // Named "Wellington Club", and mentioned in the Oriental Club's notes.
    expect(found).toContain(ids.wellington);
    expect(found).toContain(ids.oriental);
  });

  it('IN NAME FIELDS restricts the match to the name', async () => {
    const res = await runSosl(context(), 'FIND {wellington} IN NAME FIELDS RETURNING Reciprocal_Club__c(Id, Name)');
    expect(res.searchRecords.map((r) => r.Id)).toEqual([ids.wellington]);
  });

  it('ranks a name hit above a body hit', async () => {
    const res = await runSosl(context(), 'FIND {wellington} RETURNING Reciprocal_Club__c(Id, Name)');
    expect(res.searchRecords[0].Id).toBe(ids.wellington);
  });

  it('IN EMAIL FIELDS matches the email address only', async () => {
    const hit = await runSosl(context(), 'FIND {bengalclub.in} IN EMAIL FIELDS RETURNING Reciprocal_Club__c(Id)');
    expect(hit.searchRecords.map((r) => r.Id)).toEqual([ids.bengal]);

    // "India" is in the country and the notes, but never in an email address.
    const miss = await runSosl(context(), 'FIND {india} IN EMAIL FIELDS RETURNING Reciprocal_Club__c(Id)');
    expect(miss.searchRecords).toEqual([]);
  });

  it('IN PHONE FIELDS matches a number however it was typed', async () => {
    for (const term of ['02072901400', '{020}', '7290']) {
      const q = term.startsWith('{') ? term.slice(1, -1) : term;
      const res = await runSosl(context(), `FIND {${q}} IN PHONE FIELDS RETURNING Reciprocal_Club__c(Id)`);
      expect(res.searchRecords.map((r) => r.Id)).toContain(ids.oriental);
    }
  });

  it('applies the RETURNING clause WHERE, ORDER BY and LIMIT', async () => {
    const res = await runSosl(
      context(),
      "FIND {club} RETURNING Reciprocal_Club__c(Id, Name WHERE Country__c = 'India')"
    );
    expect(res.searchRecords.map((r) => r.Name)).toEqual(['Bengal Club']);
  });

  it('searches across several objects at once', async () => {
    const res = await runSosl(
      context(),
      'FIND {fitzgerald} RETURNING Contact(Id, LastName), Reciprocal_Club__c(Id, Name)'
    );
    expect(res.searchRecords.map((r) => r.Id)).toEqual([ids.amelia]);
    expect(res.searchRecords[0].attributes.type).toBe('Contact');
  });

  it('searches every searchable object when RETURNING is omitted', async () => {
    const res = await runSosl(context(), 'FIND {fitzgerald}');
    expect(res.searchRecords.map((r) => r.Id)).toContain(ids.amelia);
  });

  it('honours the overall LIMIT', async () => {
    const res = await runSosl(context(), 'FIND {club} RETURNING Reciprocal_Club__c(Id) LIMIT 1');
    expect(res.searchRecords).toHaveLength(1);
  });

  it('combines terms with AND and supports OR and NOT', async () => {
    const both = await runSosl(context(), 'FIND {oriental london} RETURNING Reciprocal_Club__c(Id)');
    expect(both.searchRecords.map((r) => r.Id)).toEqual([ids.oriental]);

    const either = await runSosl(context(), 'FIND {kolkata OR london} RETURNING Reciprocal_Club__c(Id)');
    expect(either.searchRecords.map((r) => r.Id).sort()).toEqual([ids.bengal, ids.oriental].sort());

    const negated = await runSosl(context(), 'FIND {club AND NOT india} RETURNING Reciprocal_Club__c(Id)');
    expect(negated.searchRecords.map((r) => r.Id)).not.toContain(ids.bengal);
  });

  it('matches a phrase only when the words are adjacent', async () => {
    const hit = await runSosl(context(), 'FIND {"east india company"} RETURNING Reciprocal_Club__c(Id)');
    expect(hit.searchRecords.map((r) => r.Id)).toEqual([ids.bengal]);

    const miss = await runSosl(context(), 'FIND {"india east company"} RETURNING Reciprocal_Club__c(Id)');
    expect(miss.searchRecords).toEqual([]);
  });

  it('supports a trailing wildcard', async () => {
    const res = await runSosl(context(), 'FIND {orient*} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords.map((r) => r.Id)).toContain(ids.oriental);
  });

  it('returns nothing rather than failing for a term nobody has', async () => {
    const res = await runSosl(context(), 'FIND {marylebone} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords).toEqual([]);
  });

  it('treats an injection attempt as an ordinary word', async () => {
    // The term reaches Postgres as a bind parameter to to_tsquery, never as SQL text.
    const res = await runSosl(
      context(),
      "FIND {x';DROP TABLE search_index;--} RETURNING Reciprocal_Club__c(Id)"
    );
    expect(res.searchRecords).toEqual([]);
    // The table is still there and still answering.
    const after = await runSosl(context(), 'FIND {oriental} RETURNING Reciprocal_Club__c(Id)');
    expect(after.searchRecords.map((r) => r.Id)).toContain(ids.oriental);
  });

  it('rejects an unknown object in RETURNING', async () => {
    await expect(runSosl(context(), 'FIND {club} RETURNING Nonexistent__c(Id)')).rejects.toMatchObject({
      errorCode: 'INVALID_TYPE'
    });
  });

  it('counts against the SOSL governor limit', async () => {
    const ctx = new RequestContext({
      db: org.db,
      orgId: org.orgId,
      schema: org.schema,
      userId: org.adminUserId,
      perms: ADMIN_PERMS,
      limits: new LimitContext({ soslQueries: 1, soqlQueries: 50, queryRows: 5000 })
    });
    await runSosl(ctx, 'FIND {club} RETURNING Reciprocal_Club__c(Id)');
    await expect(runSosl(ctx, 'FIND {club} RETURNING Reciprocal_Club__c(Id)')).rejects.toMatchObject({
      errorCode: 'LIMIT_EXCEEDED'
    });
  });
});

// ------------------------------------------------------- index maintenance

describe('the index follows the record', () => {
  it('reflects an update', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Reciprocal_Club__c', { Name: 'Temporary Club', City__c: 'Dublin' });
    expect((await runSosl(ctx, 'FIND {dublin} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toHaveLength(1);

    await updateRecord(ctx, 'Reciprocal_Club__c', id, { City__c: 'Cork' });
    expect((await runSosl(ctx, 'FIND {dublin} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toEqual([]);
    expect((await runSosl(ctx, 'FIND {cork} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toHaveLength(1);

    await deleteRecords(ctx, 'Reciprocal_Club__c', [id]);
    expect((await runSosl(ctx, 'FIND {cork} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toEqual([]);

    // Coming back out of the recycle bin puts the record back in the index.
    await undeleteRecords(ctx, 'Reciprocal_Club__c', [id]);
    expect((await runSosl(ctx, 'FIND {cork} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toHaveLength(1);
  });

  it('buckets field values by kind', async () => {
    const meta = await org.meta();
    const obj = meta.objects.get('reciprocal_club__c')!;
    const text = indexableText(obj, {
      Name: 'Bengal Club',
      City__c: 'Kolkata',
      Contact_Email__c: 'enquiries@bengalclub.in',
      Telephone__c: '+91 33 2299 1000'
    });
    expect(text.title).toBe('Bengal Club');
    expect(text.body).toContain('Kolkata');
    // The whole address, plus the parts Postgres would otherwise bury in one lexeme.
    expect(text.email).toContain('enquiries@bengalclub.in');
    expect(text.email).toContain('bengalclub.in');
    expect(text.email).toContain('enquiries');
    // Both the written form and bare digits, so either spelling finds it.
    expect(text.phone).toContain('+91 33 2299 1000');
    expect(text.phone).toContain('913322991000');
  });
});

// ------------------------------------------------------------------ security

describe('search obeys the sharing model', () => {
  let ownedByReception: string;

  beforeAll(async () => {
    installSecurity();

    const profile = await org.tenant((c) =>
      c.query<{ id: string }>(`SELECT id FROM profile WHERE name = 'Standard User'`)
    );
    const makeUser = async (name: string): Promise<string> => {
      const userId = generateId(KEY_PREFIXES.User);
      const slug = name.toLowerCase().replace(/\s+/g, '.');
      await org.tenant((c) =>
        rawInsert(c, 'User', userId, name, {
          Username: `${slug}@sosl.test`,
          Email: `${slug}@sosl.test`,
          LastName: name,
          IsActive: true,
          ProfileId: profile.rows[0].id
        })
      );
      return userId;
    };
    users.owner = await makeUser('Search Owner');
    users.stranger = await makeUser('Search Stranger');

    await org.tenant(async (c) => {
      for (const userId of [users.owner, users.stranger]) {
        void userId;
      }
      await c.query(
        `INSERT INTO object_perm (id, parent_id, object_api, can_create, can_read, can_edit, can_delete)
         VALUES ($1,$2,'Reciprocal_Club__c',true,true,true,true)`,
        [generateId('0PS'), profile.rows[0].id]
      );
    });

    invalidateOrgMeta(org.orgId);
    invalidateUserAccess(org.orgId);

    await setOrgWideDefault(context(), 'Reciprocal_Club__c', 'Private');
    invalidateUserAccess(org.orgId);

    ownedByReception = await insertRecord(context(users.owner), 'Reciprocal_Club__c', {
      Name: 'Confidential Club',
      City__c: 'Zurich'
    });
  });

  it('returns a private record to its owner', async () => {
    const res = await runSosl(context(users.owner), 'FIND {zurich} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords.map((r) => r.Id)).toEqual([ownedByReception]);
  });

  it('hides a private record from a user it is not shared with', async () => {
    const res = await runSosl(context(users.stranger), 'FIND {zurich} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords).toEqual([]);
  });

  it('reveals it once it is shared', async () => {
    await shareRecord(context(), 'Reciprocal_Club__c', ownedByReception, { type: 'User', id: users.stranger }, 'Read');
    const res = await runSosl(context(users.stranger), 'FIND {zurich} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords.map((r) => r.Id)).toEqual([ownedByReception]);
  });

  it('rejects a field the user may not read, as SOQL does', async () => {
    await expect(
      runSosl(context(users.stranger), 'FIND {zurich} RETURNING Reciprocal_Club__c(Id, Nonexistent__c)')
    ).rejects.toMatchObject({ errorCode: 'INVALID_FIELD' });
  });
});

// ----------------------------------------------------------------- typeahead

describe('typeahead suggestions', () => {
  it('matches a name prefix', async () => {
    const out = await suggest(context(), 'orient', { objects: ['Reciprocal_Club__c'] });
    expect(out.map((s) => s.id)).toContain(ids.oriental);
    expect(out[0].title).toBe('The Oriental Club');
    expect(out[0].objectApi).toBe('Reciprocal_Club__c');
  });

  it('treats every word as a prefix', async () => {
    const out = await suggest(context(), 'ori clu', { objects: ['Reciprocal_Club__c'] });
    expect(out.map((s) => s.id)).toContain(ids.oriental);
  });

  it('does not match words that appear only in the body', async () => {
    const out = await suggest(context(), 'stratford', { objects: ['Reciprocal_Club__c'] });
    expect(out).toEqual([]);
  });

  it('honours its limit and an empty term', async () => {
    expect(await suggest(context(), '   ')).toEqual([]);
    const out = await suggest(context(), 'club', { objects: ['Reciprocal_Club__c'], limit: 1 });
    expect(out).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ reindex

describe('rebuilding the index', () => {
  it('restores rows wiped from under it', async () => {
    const ctx = context();
    await org.tenant((c) => c.query(`DELETE FROM search_index`));
    expect((await runSosl(ctx, 'FIND {oriental} RETURNING Reciprocal_Club__c(Id)')).searchRecords).toEqual([]);

    const count = await reindexSearch(ctx, ['Reciprocal_Club__c', 'Contact']);
    expect(count).toBeGreaterThan(0);

    const res = await runSosl(ctx, 'FIND {oriental} RETURNING Reciprocal_Club__c(Id)');
    expect(res.searchRecords.map((r) => r.Id)).toContain(ids.oriental);
    // Weighted buckets survive the rebuild, so the search groups still work.
    const byEmail = await runSosl(ctx, 'FIND {bengalclub.in} IN EMAIL FIELDS RETURNING Reciprocal_Club__c(Id)');
    expect(byEmail.searchRecords.map((r) => r.Id)).toEqual([ids.bengal]);
  });
});
