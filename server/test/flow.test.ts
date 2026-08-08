import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, getRecord, insertRecord, updateRecord } from '../src/dml/index.js';
import { runQuery } from '../src/soql/index.js';
import { installFlows, loadFlow, runFlow, FlowScope, resolveExpression } from '../src/flow/index.js';
import type { FlowDefinition } from '../src/flow/index.js';
import { generateId, KEY_PREFIXES } from '../src/util/ids.js';
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

async function defineFlow(flow: {
  apiName: string;
  label?: string;
  processType?: string;
  status?: string;
  trigger?: any;
  startNode: string;
  nodes: Record<string, any>;
  variables?: any[];
  version?: number;
}): Promise<string> {
  const id = generateId(KEY_PREFIXES.Flow);
  await org.tenant((c) =>
    c.query(
      `INSERT INTO flow_def (id, api_name, label, version, status, process_type, trigger, start_node, nodes, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        flow.apiName,
        flow.label ?? flow.apiName,
        flow.version ?? 1,
        flow.status ?? 'Active',
        flow.processType ?? 'AutoLaunchedFlow',
        flow.trigger ? JSON.stringify(flow.trigger) : null,
        flow.startNode,
        JSON.stringify(flow.nodes),
        JSON.stringify(flow.variables ?? [])
      ]
    )
  );
  return id;
}

const dropFlow = (apiName: string) => org.tenant((c) => c.query(`DELETE FROM flow_def WHERE api_name = $1`, [apiName]));

beforeAll(async () => {
  org = await testOrg();
  installFlows();

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Booking__c',
      label: 'Booking',
      pluralLabel: 'Bookings',
      isCustom: true,
      fields: [
        { apiName: 'Member__c', label: 'Member', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'Bookings' },
        { apiName: 'Kind__c', label: 'Kind', type: 'Picklist', picklist: { values: ['Bedroom', 'Table', 'Venue'] } },
        { apiName: 'Status__c', label: 'Status', type: 'Picklist', picklist: { values: ['Held', 'Confirmed', 'Cancelled'] } },
        { apiName: 'Nights__c', label: 'Nights', type: 'Number', precision: 3, scale: 0 },
        { apiName: 'Total__c', label: 'Total', type: 'Currency', precision: 10, scale: 2 },
        { apiName: 'Reference__c', label: 'Reference', type: 'Text', length: 60 },
        { apiName: 'ArrivalDate__c', label: 'Arrival', type: 'Date' }
      ]
    })
  );

  await org.tenant((c) =>
    c.query(
      `INSERT INTO email_template (id, api_name, name, subject, body_text)
       VALUES ($1,'BookingConfirmed','Booking Confirmed','Your booking {!Reference__c}','We confirm your {!Kind__c} booking.')`,
      [generateId(KEY_PREFIXES.EmailTemplate)]
    )
  );

  invalidateOrgMeta(org.orgId);
});

afterAll(() => {
  clearDmlHooks();
});

describe('scope and expressions', () => {
  it('resolves whole-string references with their type', () => {
    const scope = new FlowScope([{ name: 'count', value: 3 }]);
    expect(resolveExpression('{!count}', scope)).toBe(3);
  });

  it('interpolates embedded references as text', () => {
    const scope = new FlowScope([{ name: 'name', value: 'Ada' }, { name: 'count', value: 2 }]);
    expect(resolveExpression('{!name} has {!count} guests', scope)).toBe('Ada has 2 guests');
  });

  it('walks dotted paths and blanks what is missing', () => {
    const scope = new FlowScope();
    scope.set('$Record', { Status__c: 'Held', Member__r: { Name: 'Ada' } });
    expect(resolveExpression('{!$Record.Status__c}', scope)).toBe('Held');
    expect(resolveExpression('{!$Record.Member__r.Name}', scope)).toBe('Ada');
    expect(resolveExpression('{!$Record.Nope}', scope)).toBeNull();
    expect(resolveExpression('x{!$Record.Nope}y', scope)).toBe('xy');
  });

  it('sets nested paths', () => {
    const scope = new FlowScope();
    scope.set('$Record.Status__c', 'Confirmed');
    expect(scope.get('$Record.Status__c')).toBe('Confirmed');
  });
});

describe('assignment and decision', () => {
  it('assigns, adds and appends', async () => {
    await defineFlow({
      apiName: 'Arithmetic',
      startNode: 'a',
      variables: [{ name: 'total', value: 10 }, { name: 'items', isCollection: true }],
      nodes: {
        a: {
          type: 'assignment',
          assignments: [
            { target: 'total', operator: 'add', value: 5 },
            { target: 'total', operator: 'subtract', value: 3 },
            { target: 'items', operator: 'addItem', value: 'first' },
            { target: 'items', operator: 'addItem', value: 'second' },
            { target: 'label', value: 'done' }
          ]
        }
      }
    });

    const flow = (await loadFlow(context(), 'Arithmetic'))!;
    const result = await runFlow(context(), flow);
    expect(result.variables.total).toBe(12);
    expect(result.variables.items).toEqual(['first', 'second']);
    expect(result.variables.label).toBe('done');
    await dropFlow('Arithmetic');
  });

  it('takes the first matching outcome and falls through to the default', async () => {
    await defineFlow({
      apiName: 'Router',
      startNode: 'decide',
      variables: [{ name: 'kind', value: 'Bedroom' }, { name: 'route' }],
      nodes: {
        decide: {
          type: 'decision',
          outcomes: [
            { name: 'table', conditions: [{ field: 'kind', op: 'equals', value: 'Table' }], next: 'setTable' },
            { name: 'bedroom', conditions: [{ field: 'kind', op: 'equals', value: 'Bedroom' }], next: 'setBedroom' }
          ],
          defaultNext: 'setOther'
        },
        setTable: { type: 'assignment', assignments: [{ target: 'route', value: 'table' }] },
        setBedroom: { type: 'assignment', assignments: [{ target: 'route', value: 'bedroom' }] },
        setOther: { type: 'assignment', assignments: [{ target: 'route', value: 'other' }] }
      }
    });

    const ctx = context();
    const flow = (await loadFlow(ctx, 'Router'))!;
    expect((await runFlow(ctx, flow)).variables.route).toBe('bedroom');
    expect((await runFlow(ctx, flow, { inputs: { kind: 'Table' } })).variables.route).toBe('table');
    expect((await runFlow(ctx, flow, { inputs: { kind: 'Venue' } })).variables.route).toBe('other');
    await dropFlow('Router');
  });

  it('records the path it took', async () => {
    await defineFlow({
      apiName: 'Traced',
      startNode: 'one',
      nodes: {
        one: { type: 'assignment', assignments: [{ target: 'x', value: 1 }], next: 'two' },
        two: { type: 'assignment', assignments: [{ target: 'y', value: 2 }] }
      }
    });
    const flow = (await loadFlow(context(), 'Traced'))!;
    expect((await runFlow(context(), flow)).path).toEqual(['one', 'two']);
    await dropFlow('Traced');
  });
});

describe('loops', () => {
  it('iterates a collection and exits after the last item', async () => {
    await defineFlow({
      apiName: 'SumNights',
      startNode: 'loop',
      variables: [
        { name: 'bookings', value: [{ Nights__c: 2 }, { Nights__c: 3 }, { Nights__c: 4 }] },
        { name: 'total', value: 0 }
      ],
      nodes: {
        loop: { type: 'loop', collection: 'bookings', loopVariable: 'item', firstNext: 'add', afterLast: 'done' },
        add: { type: 'assignment', assignments: [{ target: 'total', operator: 'add', value: '{!item.Nights__c}' }], next: 'loop' },
        done: { type: 'assignment', assignments: [{ target: 'finished', value: true }] }
      }
    });

    const flow = (await loadFlow(context(), 'SumNights'))!;
    const result = await runFlow(context(), flow);
    expect(result.variables.total).toBe(9);
    expect(result.variables.finished).toBe(true);
    await dropFlow('SumNights');
  });

  it('skips the body for an empty collection', async () => {
    await defineFlow({
      apiName: 'EmptyLoop',
      startNode: 'loop',
      variables: [{ name: 'items', value: [] }, { name: 'ran', value: false }],
      nodes: {
        loop: { type: 'loop', collection: 'items', loopVariable: 'item', firstNext: 'body', afterLast: 'end' },
        body: { type: 'assignment', assignments: [{ target: 'ran', value: true }], next: 'loop' },
        end: { type: 'assignment', assignments: [{ target: 'done', value: true }] }
      }
    });
    const result = await runFlow(context(), (await loadFlow(context(), 'EmptyLoop'))!);
    expect(result.variables.ran).toBe(false);
    expect(result.variables.done).toBe(true);
    await dropFlow('EmptyLoop');
  });

  it('stops a runaway flow rather than spinning', async () => {
    await defineFlow({
      apiName: 'Infinite',
      startNode: 'a',
      nodes: { a: { type: 'assignment', assignments: [{ target: 'n', operator: 'add', value: 1 }], next: 'a' } }
    });
    await expect(runFlow(context(), (await loadFlow(context(), 'Infinite'))!)).rejects.toMatchObject({
      errorCode: 'LIMIT_EXCEEDED'
    });
    await dropFlow('Infinite');
  });
});

describe('record elements', () => {
  it('gets records into a collection and a single record', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Getter' });
    await insertRecord(ctx, 'Booking__c', { Name: 'B1', Member__c: member, Kind__c: 'Bedroom', Status__c: 'Held' });
    await insertRecord(ctx, 'Booking__c', { Name: 'B2', Member__c: member, Kind__c: 'Bedroom', Status__c: 'Held' });

    await defineFlow({
      apiName: 'FindHeld',
      startNode: 'get',
      variables: [{ name: 'memberId', value: member }],
      nodes: {
        get: {
          type: 'getRecords',
          object: 'Booking__c',
          filters: [
            { field: 'Member__c', op: 'equals', value: '{!memberId}' },
            { field: 'Status__c', op: 'equals', value: 'Held' }
          ],
          storeIn: 'held',
          next: 'getOne'
        },
        getOne: {
          type: 'getRecords',
          object: 'Booking__c',
          filters: [{ field: 'Member__c', op: 'equals', value: '{!memberId}' }],
          storeIn: 'firstBooking',
          first: true
        }
      }
    });

    const result = await runFlow(ctx, (await loadFlow(ctx, 'FindHeld'))!);
    expect((result.variables.held as any[]).length).toBe(2);
    expect((result.variables.firstBooking as any).Id).toBeTruthy();
    await dropFlow('FindHeld');
  });

  it('creates a record and stores its id', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Creator' });

    await defineFlow({
      apiName: 'CreateBooking',
      startNode: 'create',
      variables: [{ name: 'memberId', value: member }],
      nodes: {
        create: {
          type: 'createRecords',
          object: 'Booking__c',
          fields: { Name: 'Flow booking', Member__c: '{!memberId}', Kind__c: 'Table', Status__c: 'Held' },
          storeIdIn: 'newId'
        }
      }
    });

    const result = await runFlow(ctx, (await loadFlow(ctx, 'CreateBooking'))!);
    const created = await getRecord(ctx, 'Booking__c', String(result.variables.newId));
    expect(created!.Name).toBe('Flow booking');
    expect(created!.Member__c).toBe(member);
    await dropFlow('CreateBooking');
  });

  it('updates and deletes records found by a query', async () => {
    const ctx = context();
    const member = await insertRecord(ctx, 'Contact', { LastName: 'Updater' });
    await insertRecord(ctx, 'Booking__c', { Name: 'U1', Member__c: member, Status__c: 'Held' });
    await insertRecord(ctx, 'Booking__c', { Name: 'U2', Member__c: member, Status__c: 'Held' });

    await defineFlow({
      apiName: 'ConfirmAll',
      startNode: 'get',
      variables: [{ name: 'memberId', value: member }],
      nodes: {
        get: {
          type: 'getRecords',
          object: 'Booking__c',
          filters: [{ field: 'Member__c', op: 'equals', value: '{!memberId}' }],
          storeIn: 'bookings',
          next: 'update'
        },
        update: { type: 'updateRecords', object: 'Booking__c', from: 'bookings', fields: { Status__c: 'Confirmed' } }
      }
    });

    await runFlow(ctx, (await loadFlow(ctx, 'ConfirmAll'))!);
    const after = await runQuery(ctx, `SELECT Status__c FROM Booking__c WHERE Member__c = '${member}'`);
    expect(after.records.every((r) => r.Status__c === 'Confirmed')).toBe(true);
    await dropFlow('ConfirmAll');
  });

  it('queues an email from a template', async () => {
    const ctx = context();
    await defineFlow({
      apiName: 'EmailFlow',
      startNode: 'send',
      trigger: { objectApi: 'Booking__c' },
      nodes: {
        send: {
          type: 'email',
          subject: 'Booking {!$Record.Reference__c}',
          body: 'Thank you.',
          recipients: ['reservations@orientalclub.org.uk']
        }
      }
    });

    await runFlow(ctx, (await loadFlow(ctx, 'EmailFlow'))!, { record: { Reference__c: 'OC-77' } });
    const rows = await org.tenant((c) => c.query(`SELECT subject, to_addrs FROM email_outbound ORDER BY created_at DESC LIMIT 1`));
    expect(rows.rows[0].subject).toBe('Booking OC-77');
    await dropFlow('EmailFlow');
  });

  it('posts to a record feed', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { LastName: 'Feedworthy' });
    await defineFlow({
      apiName: 'FeedFlow',
      startNode: 'post',
      variables: [{ name: 'target', value: id }],
      nodes: { post: { type: 'postToFeed', parentId: '{!target}', body: 'Welcome to the club.' } }
    });

    await runFlow(ctx, (await loadFlow(ctx, 'FeedFlow'))!);
    const rows = await org.tenant((c) => c.query(`SELECT body, type FROM feed_item WHERE parent_id = $1`, [id]));
    expect(rows.rows[0].body).toBe('Welcome to the club.');
    expect(rows.rows[0].type).toBe('SystemPost');
    await dropFlow('FeedFlow');
  });
});

describe('subflows', () => {
  it('passes inputs in and reads outputs back', async () => {
    await defineFlow({
      apiName: 'Doubler',
      startNode: 'double',
      variables: [{ name: 'input', isInput: true }, { name: 'result', isOutput: true }],
      nodes: { double: { type: 'assignment', assignments: [{ target: 'result', value: '{!input}' }, { target: 'result', operator: 'add', value: '{!input}' }] } }
    });
    await defineFlow({
      apiName: 'Caller',
      startNode: 'call',
      variables: [{ name: 'answer' }],
      nodes: { call: { type: 'subflow', flow: 'Doubler', inputs: { input: 21 }, outputs: { answer: 'result' } } }
    });

    const ctx = context();
    const result = await runFlow(ctx, (await loadFlow(ctx, 'Caller'))!);
    expect(result.variables.answer).toBe(42);
    await dropFlow('Doubler');
    await dropFlow('Caller');
  });

  it('refuses a subflow cycle', async () => {
    await defineFlow({
      apiName: 'Ping',
      startNode: 'call',
      nodes: { call: { type: 'subflow', flow: 'Pong' } }
    });
    await defineFlow({
      apiName: 'Pong',
      startNode: 'call',
      nodes: { call: { type: 'subflow', flow: 'Ping' } }
    });

    const ctx = context();
    await expect(runFlow(ctx, (await loadFlow(ctx, 'Ping'))!)).rejects.toMatchObject({ errorCode: 'INVALID_OPERATION' });
    await dropFlow('Ping');
    await dropFlow('Pong');
  });
});

describe('record-triggered flows', () => {
  it('runs a before-save flow that sets fields without extra DML', async () => {
    await defineFlow({
      apiName: 'SetReference',
      processType: 'RecordTriggered',
      trigger: { objectApi: 'Booking__c', on: 'create', when: 'before' },
      startNode: 'set',
      nodes: {
        set: {
          type: 'assignment',
          assignments: [{ target: '$Record.Reference__c', value: 'OC-{!$Record.Kind__c}' }]
        }
      }
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', { Name: 'Before save', Kind__c: 'Bedroom', Status__c: 'Held' });
    const record = await getRecord(ctx, 'Booking__c', id);
    expect(record!.Reference__c).toBe('OC-Bedroom');
    // A before-save flow must not leave a second modification behind.
    expect(record!.LastModifiedDate).toBe(record!.CreatedDate);
    await dropFlow('SetReference');
  });

  it('runs an after-save flow that creates a related record', async () => {
    await defineFlow({
      apiName: 'LogConfirmed',
      processType: 'RecordTriggered',
      trigger: { objectApi: 'Booking__c', on: 'createOrUpdate', when: 'after', conditions: [{ field: 'Status__c', op: 'equals', value: 'Confirmed' }] },
      startNode: 'task',
      nodes: {
        task: {
          type: 'createRecords',
          object: 'Task',
          fields: { Subject: 'Prepare for {!$Record.Name}', WhatId: '{!$Record.Id}', Status: 'Not Started' }
        }
      }
    });

    const ctx = context();
    const held = await insertRecord(ctx, 'Booking__c', { Name: 'Not yet', Kind__c: 'Table', Status__c: 'Held' });
    expect((await runQuery(ctx, `SELECT Id FROM Task WHERE WhatId = '${held}'`)).totalSize).toBe(0);

    await updateRecord(ctx, 'Booking__c', held, { Status__c: 'Confirmed' });
    const tasks = await runQuery(ctx, `SELECT Subject FROM Task WHERE WhatId = '${held}'`);
    expect(tasks.totalSize).toBe(1);
    expect(tasks.records[0].Subject).toBe('Prepare for Not yet');
    await dropFlow('LogConfirmed');
  });

  it('sees the prior record for change detection', async () => {
    await defineFlow({
      apiName: 'DetectCancellation',
      processType: 'RecordTriggered',
      trigger: { objectApi: 'Booking__c', on: 'update', when: 'before' },
      startNode: 'decide',
      nodes: {
        decide: {
          type: 'decision',
          outcomes: [
            {
              name: 'justCancelled',
              formula: 'AND($Record.Status__c = "Cancelled", $Record__Prior.Status__c <> "Cancelled")',
              next: 'note'
            }
          ]
        },
        note: { type: 'assignment', assignments: [{ target: '$Record.Reference__c', value: 'CANCELLED' }] }
      }
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', { Name: 'To cancel', Kind__c: 'Venue', Status__c: 'Held' });
    await updateRecord(ctx, 'Booking__c', id, { Status__c: 'Cancelled' });
    expect((await getRecord(ctx, 'Booking__c', id))!.Reference__c).toBe('CANCELLED');

    // Saving again while already cancelled must not re-mark it.
    await updateRecord(ctx, 'Booking__c', id, { Reference__c: 'cleared' });
    expect((await getRecord(ctx, 'Booking__c', id))!.Reference__c).toBe('cleared');
    await dropFlow('DetectCancellation');
  });

  it('ignores draft and obsolete versions', async () => {
    await defineFlow({
      apiName: 'DraftOnly',
      processType: 'RecordTriggered',
      status: 'Draft',
      trigger: { objectApi: 'Booking__c', on: 'create', when: 'before' },
      startNode: 'set',
      nodes: { set: { type: 'assignment', assignments: [{ target: '$Record.Reference__c', value: 'SHOULD-NOT-APPEAR' }] } }
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', { Name: 'Draft ignored', Kind__c: 'Table', Status__c: 'Held' });
    expect((await getRecord(ctx, 'Booking__c', id))!.Reference__c ?? null).toBeNull();
    await dropFlow('DraftOnly');
  });

  it('rolls the save back when a flow fails', async () => {
    await defineFlow({
      apiName: 'FailingFlow',
      processType: 'RecordTriggered',
      trigger: { objectApi: 'Booking__c', on: 'create', when: 'after' },
      startNode: 'boom',
      nodes: { boom: { type: 'createRecords', object: 'Nonexistent__c', fields: { Name: 'nope' } } }
    });

    const ctx = context();
    await expect(
      insertRecord(ctx, 'Booking__c', { Name: 'Rolled back', Kind__c: 'Table', Status__c: 'Held' })
    ).rejects.toMatchObject({ errorCode: 'INVALID_TYPE' });

    const found = await runQuery(ctx, "SELECT Id FROM Booking__c WHERE Name = 'Rolled back'");
    expect(found.totalSize).toBe(0);
    await dropFlow('FailingFlow');
  });
});
