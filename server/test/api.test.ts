import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/http/app.js';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;
let server: Server;
let base: string;
let token: string;

const V = '61.0';
const USERNAME = 'admin@larkspur.club';
const PASSWORD = 'Larkspur#1905';

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });
}

const json = async (res: Response) => res.json();

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
        { apiName: 'MemberNumber__c', label: 'Member Number', type: 'Text', length: 20, externalId: true, unique: true },
        { apiName: 'Category__c', label: 'Category', type: 'Picklist', picklist: { values: ['Full', 'Associate'] } }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);

  server = createApp(org.db).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD })
  });
  token = (await login.json()).accessToken;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('describe', () => {
  it('lists all objects in a global describe', async () => {
    const res = await api(`/services/data/v${V}/sobjects`);
    expect(res.status).toBe(200);
    const body = await json(res);
    const names = body.sobjects.map((s: any) => s.name);
    expect(names).toContain('Account');
    expect(names).toContain('Membership__c');
  });

  it('describes one object with its fields and child relationships', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Contact/describe`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe('Contact');
    expect(body.fields.map((f: any) => f.name)).toContain('LastName');
    expect(body.childRelationships.map((c: any) => c.relationshipName)).toContain('Memberships');
  });

  it('404s an unknown object', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Nonexistent__c/describe`);
    expect(res.status).toBe(404);
    expect((await json(res))[0].errorCode).toBe('INVALID_TYPE');
  });
});

describe('record CRUD', () => {
  let accountId: string;

  it('creates a record', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Account`, {
      method: 'POST',
      body: JSON.stringify({ Name: 'The Oriental Club', Industry: 'Hospitality' })
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.id).toHaveLength(18);
    accountId = body.id;
  });

  it('reads it back with attributes', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Account/${accountId}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.Name).toBe('The Oriental Club');
    expect(body.attributes.type).toBe('Account');
  });

  it('honours the fields parameter', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Account/${accountId}?fields=Name`);
    const body = await json(res);
    expect(body.Name).toBe('The Oriental Club');
    expect('Industry' in body).toBe(false);
  });

  it('updates with PATCH and returns 204', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Account/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ Rating: 'Hot' })
    });
    expect(res.status).toBe(204);
    const reread = await json(await api(`/services/data/v${V}/sobjects/Account/${accountId}`));
    expect(reread.Rating).toBe('Hot');
  });

  it('reports a validation failure in the Salesforce error shape', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Contact`, {
      method: 'POST',
      body: JSON.stringify({ FirstName: 'No surname' })
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body[0].errorCode).toBe('REQUIRED_FIELD_MISSING');
    expect(body[0].fields).toContain('LastName');
  });

  it('deletes and then 404s', async () => {
    const created = await json(
      await api(`/services/data/v${V}/sobjects/Account`, { method: 'POST', body: JSON.stringify({ Name: 'Temporary' }) })
    );
    expect((await api(`/services/data/v${V}/sobjects/Account/${created.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/services/data/v${V}/sobjects/Account/${created.id}`)).status).toBe(404);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await fetch(`${base}/services/data/v${V}/sobjects/Account/${accountId}`);
    expect(res.status).toBe(401);
  });
});

describe('upsert by external id', () => {
  it('creates on first call and updates on the second', async () => {
    const contact = await json(
      await api(`/services/data/v${V}/sobjects/Contact`, {
        method: 'POST',
        body: JSON.stringify({ LastName: 'Upsertable' })
      })
    );

    const created = await api(`/services/data/v${V}/sobjects/Membership__c/MemberNumber__c/OC-5001`, {
      method: 'PATCH',
      body: JSON.stringify({ Name: 'M-5001', Contact__c: contact.id, Category__c: 'Full' })
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created);

    const updated = await api(`/services/data/v${V}/sobjects/Membership__c/MemberNumber__c/OC-5001`, {
      method: 'PATCH',
      body: JSON.stringify({ Category__c: 'Associate' })
    });
    expect(updated.status).toBe(200);
    expect((await json(updated)).id).toBe(createdBody.id);
  });

  it('reads a record by its external id', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Membership__c/MemberNumber__c/OC-5001`);
    expect(res.status).toBe(200);
    expect((await json(res)).Category__c).toBe('Associate');
  });

  it('refuses a field that is not an external id', async () => {
    const res = await api(`/services/data/v${V}/sobjects/Account/Industry/Hospitality`);
    expect(res.status).toBe(400);
    expect((await json(res))[0].errorCode).toBe('INVALID_OPERATION');
  });
});

describe('query', () => {
  it('runs SOQL and returns the standard envelope', async () => {
    const res = await api(`/services/data/v${V}/query?q=${encodeURIComponent('SELECT Id, Name FROM Account')}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveProperty('totalSize');
    expect(body).toHaveProperty('done');
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records[0].attributes.type).toBe('Account');
  });

  it('pages with nextRecordsUrl that can be fetched directly', async () => {
    for (let i = 0; i < 3; i++) {
      await api(`/services/data/v${V}/sobjects/Account`, {
        method: 'POST',
        body: JSON.stringify({ Name: `Paging ${i}` })
      });
    }
    const first = await json(
      await api(`/services/data/v${V}/query?batchSize=2&q=${encodeURIComponent("SELECT Id FROM Account ORDER BY Name")}`)
    );
    expect(first.done).toBe(false);
    const second = await json(await api(first.nextRecordsUrl));
    expect(second.records.length).toBeGreaterThan(0);
  });

  it('rejects a malformed query', async () => {
    const res = await api(`/services/data/v${V}/query?q=${encodeURIComponent('SELECT FROM')}`);
    expect(res.status).toBe(400);
    expect((await json(res))[0].errorCode).toBe('MALFORMED_QUERY');
  });

  it('requires the q parameter', async () => {
    expect((await api(`/services/data/v${V}/query`)).status).toBe(400);
  });

  it('includes deleted records only for queryAll', async () => {
    const created = await json(
      await api(`/services/data/v${V}/sobjects/Account`, { method: 'POST', body: JSON.stringify({ Name: 'Binned' }) })
    );
    await api(`/services/data/v${V}/sobjects/Account/${created.id}`, { method: 'DELETE' });

    const q = encodeURIComponent(`SELECT Id FROM Account WHERE Id = '${created.id}'`);
    expect((await json(await api(`/services/data/v${V}/query?q=${q}`))).totalSize).toBe(0);
    expect((await json(await api(`/services/data/v${V}/queryAll?q=${q}`))).totalSize).toBe(1);
  });
});

describe('composite', () => {
  it('creates a parent and child in one transaction using a reference', async () => {
    const res = await api(`/services/data/v${V}/composite`, {
      method: 'POST',
      body: JSON.stringify({
        allOrNone: true,
        compositeRequest: [
          {
            method: 'POST',
            url: `/services/data/v${V}/sobjects/Contact`,
            referenceId: 'newMember',
            body: { LastName: 'Composite Member' }
          },
          {
            method: 'POST',
            url: `/services/data/v${V}/sobjects/Membership__c`,
            referenceId: 'newMembership',
            body: { Name: 'M-C1', Contact__c: '@{newMember.id}', Category__c: 'Full' }
          }
        ]
      })
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.compositeResponse.map((r: any) => r.httpStatusCode)).toEqual([201, 201]);

    const membershipId = body.compositeResponse[1].body.id;
    const membership = await json(await api(`/services/data/v${V}/sobjects/Membership__c/${membershipId}`));
    expect(membership.Contact__c).toBe(body.compositeResponse[0].body.id);
  });

  it('rolls the whole composite back when one sub-request fails', async () => {
    const before = await json(await api(`/services/data/v${V}/query?q=${encodeURIComponent('SELECT COUNT(Id) n FROM Contact')}`));

    const res = await api(`/services/data/v${V}/composite`, {
      method: 'POST',
      body: JSON.stringify({
        allOrNone: true,
        compositeRequest: [
          { method: 'POST', url: `/services/data/v${V}/sobjects/Contact`, referenceId: 'ok', body: { LastName: 'Kept?' } },
          { method: 'POST', url: `/services/data/v${V}/sobjects/Contact`, referenceId: 'bad', body: { FirstName: 'No surname' } }
        ]
      })
    });
    const body = await json(res);
    expect(body.compositeResponse[1].httpStatusCode).toBe(400);
    expect(body.compositeResponse[0].body[0].errorCode).toBe('PROCESSING_HALTED');

    const after = await json(await api(`/services/data/v${V}/query?q=${encodeURIComponent('SELECT COUNT(Id) n FROM Contact')}`));
    expect(after.records[0].n).toBe(before.records[0].n);
  });

  it('runs an independent batch where failures do not affect the others', async () => {
    const res = await api(`/services/data/v${V}/composite/batch`, {
      method: 'POST',
      body: JSON.stringify({
        batchRequests: [
          { method: 'POST', url: `/services/data/v${V}/sobjects/Account`, richInput: { Name: 'Batch A' } },
          { method: 'POST', url: `/services/data/v${V}/sobjects/Account`, richInput: { Name: 'x'.repeat(300) } },
          { method: 'GET', url: `/services/data/v${V}/query?q=${encodeURIComponent('SELECT Id FROM Account LIMIT 1')}` }
        ]
      })
    });
    const body = await json(res);
    expect(body.hasErrors).toBe(true);
    expect(body.results[0].statusCode).toBe(201);
    expect(body.results[1].statusCode).toBe(400);
    expect(body.results[2].statusCode).toBe(200);

    const kept = await json(
      await api(`/services/data/v${V}/query?q=${encodeURIComponent("SELECT Id FROM Account WHERE Name = 'Batch A'")}`)
    );
    expect(kept.totalSize).toBe(1);
  });

  it('saves a collection of mixed types in caller order', async () => {
    const res = await api(`/services/data/v${V}/composite/sobjects`, {
      method: 'POST',
      body: JSON.stringify({
        allOrNone: false,
        records: [
          { attributes: { type: 'Account' }, Name: 'Collection Club' },
          { attributes: { type: 'Contact' }, LastName: 'Collection Member' },
          { attributes: { type: 'Account' }, Name: 'Second Club' }
        ]
      })
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(3);
    expect(body.every((r: any) => r.success)).toBe(true);
    expect(body[0].id.slice(0, 3)).toBe('001');
    expect(body[1].id.slice(0, 3)).toBe('003');
    expect(body[2].id.slice(0, 3)).toBe('001');
  });

  it('reports per-record failures in a collection', async () => {
    const res = await api(`/services/data/v${V}/composite/sobjects`, {
      method: 'POST',
      body: JSON.stringify({
        allOrNone: false,
        records: [
          { attributes: { type: 'Account' }, Name: 'Fine' },
          { attributes: { type: 'Account' }, Name: 'x'.repeat(300) }
        ]
      })
    });
    const body = await json(res);
    expect(body[0].success).toBe(true);
    expect(body[1].success).toBe(false);
    expect(body[1].errors[0].errorCode).toBe('STRING_TOO_LONG');
  });

  it('creates a nested tree of records', async () => {
    const res = await api(`/services/data/v${V}/composite/tree/Contact`, {
      method: 'POST',
      body: JSON.stringify({
        records: [
          {
            attributes: { type: 'Contact', referenceId: 'member1' },
            LastName: 'Tree Member',
            Memberships: {
              records: [
                { attributes: { type: 'Membership__c', referenceId: 'mem1' }, Name: 'M-T1', Category__c: 'Full' }
              ]
            }
          }
        ]
      })
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.hasErrors).toBe(false);
    expect(body.results.map((r: any) => r.referenceId)).toEqual(['member1', 'mem1']);

    const membership = await json(
      await api(`/services/data/v${V}/sobjects/Membership__c/${body.results[1].id}`)
    );
    expect(membership.Contact__c).toBe(body.results[0].id);
  });
});

describe('limits and recent', () => {
  it('reports limits', async () => {
    const body = await json(await api(`/services/data/v${V}/limits`));
    expect(body.SoqlQueries.Max).toBe(100);
  });

  it('returns an empty recent list', async () => {
    const res = await api(`/services/data/v${V}/recent`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await json(res))).toBe(true);
  });
});
