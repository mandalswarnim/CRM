import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, getRecord, insertRecord, updateRecord } from '../src/dml/index.js';
import { runQuery } from '../src/soql/index.js';
import { installAutomation, mergeFields, matchesFilters } from '../src/automation/index.js';
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

async function addWorkflow(rule: {
  apiName: string;
  label: string;
  objectApi: string;
  triggerType?: string;
  criteria?: any;
  criteriaFormula?: string;
  actions?: any[];
  timeTriggers?: any[];
}): Promise<string> {
  const id = generateId(KEY_PREFIXES.WorkflowRule);
  await org.tenant((c) =>
    c.query(
      `INSERT INTO workflow_rule (id, object_api, api_name, label, trigger_type, criteria, criteria_formula, actions, time_triggers)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        rule.objectApi,
        rule.apiName,
        rule.label,
        rule.triggerType ?? 'onCreateOrUpdate',
        rule.criteria ? JSON.stringify(rule.criteria) : null,
        rule.criteriaFormula ?? null,
        JSON.stringify(rule.actions ?? []),
        JSON.stringify(rule.timeTriggers ?? [])
      ]
    )
  );
  return id;
}

beforeAll(async () => {
  org = await testOrg();
  installAutomation();

  // The club's guest rules, expressed as ordinary platform metadata.
  await org.tenant((c) =>
    installObject(c, {
      apiName: 'GuestVisit__c',
      label: 'Guest Visit',
      pluralLabel: 'Guest Visits',
      isCustom: true,
      fields: [
        { apiName: 'Host__c', label: 'Host Member', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'GuestVisits' },
        { apiName: 'GuestCount__c', label: 'Guests', type: 'Number', precision: 3, scale: 0 },
        { apiName: 'VisitDate__c', label: 'Visit Date', type: 'Date' },
        { apiName: 'Outlet__c', label: 'Outlet', type: 'Picklist', picklist: { values: ['Dining Room', 'Members Bar', 'Bedrooms'] } },
        { apiName: 'Status__c', label: 'Status', type: 'Picklist', picklist: { values: ['Booked', 'Confirmed', 'Cancelled'] } },
        { apiName: 'MemberPresent__c', label: 'Member Present', type: 'Checkbox' },
        { apiName: 'Notes__c', label: 'Notes', type: 'TextArea' }
      ],
      validationRules: [
        {
          apiName: 'GuestLimit',
          formula: 'GuestCount__c > 6',
          errorMessage: 'A member may sign in no more than six guests at one time.',
          errorField: 'GuestCount__c'
        },
        {
          apiName: 'MemberMustAccompany',
          formula: 'AND(NOT(MemberPresent__c), Outlet__c = "Dining Room")',
          errorMessage: 'Guests may only dine when accompanied by their host member.',
          errorField: 'MemberPresent__c'
        }
      ]
    })
  );

  await org.tenant((c) =>
    c.query(
      `INSERT INTO email_template (id, api_name, name, subject, body_text, related_object)
       VALUES ($1,'GuestConfirmation','Guest Confirmation','Your guests on {!VisitDate__c}','Dear member, we have booked {!GuestCount__c} guests in the {!Outlet__c}.','GuestVisit__c')`,
      [generateId(KEY_PREFIXES.EmailTemplate)]
    )
  );

  invalidateOrgMeta(org.orgId);
});

afterAll(() => {
  clearDmlHooks();
});

describe('validation rules', () => {
  it('blocks a save when the error condition is true', async () => {
    const ctx = context();
    await expect(
      insertRecord(ctx, 'GuestVisit__c', { Name: 'Too many', GuestCount__c: 7, MemberPresent__c: true })
    ).rejects.toMatchObject({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('reports the message and the field the rule names', async () => {
    const ctx = context();
    try {
      await insertRecord(ctx, 'GuestVisit__c', { Name: 'Too many', GuestCount__c: 9, MemberPresent__c: true });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.message).toBe('A member may sign in no more than six guests at one time.');
      expect(e.fields).toEqual(['GuestCount__c']);
    }
  });

  it('allows a save at the boundary', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Just enough', GuestCount__c: 6, MemberPresent__c: true });
    expect(id).toBeTruthy();
  });

  it('evaluates a multi-condition rule', async () => {
    const ctx = context();
    await expect(
      insertRecord(ctx, 'GuestVisit__c', { Name: 'Unaccompanied', GuestCount__c: 2, Outlet__c: 'Dining Room', MemberPresent__c: false })
    ).rejects.toMatchObject({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });

    // The same booking in a different outlet is fine.
    await expect(
      insertRecord(ctx, 'GuestVisit__c', { Name: 'Bar guests', GuestCount__c: 2, Outlet__c: 'Members Bar', MemberPresent__c: false })
    ).resolves.toBeTruthy();
  });

  it('blocks an update that breaks the rule', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Growing party', GuestCount__c: 4, MemberPresent__c: true });
    await expect(updateRecord(ctx, 'GuestVisit__c', id, { GuestCount__c: 12 })).rejects.toMatchObject({
      errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION'
    });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.GuestCount__c).toBe(4);
  });

  it('refuses to wave records through when a rule cannot be evaluated', async () => {
    const ctx = context();
    await org.tenant((c) =>
      c.query(
        `INSERT INTO validation_rule (id, object_id, api_name, formula, error_message)
         SELECT $1, id, 'Broken', 'NoSuchFunction(Foo)', 'unused' FROM object_def WHERE api_name = 'GuestVisit__c'`,
        [generateId(KEY_PREFIXES.ValidationRule)]
      )
    );
    invalidateOrgMeta(org.orgId);

    await expect(
      insertRecord(ctx, 'GuestVisit__c', { Name: 'Broken rule', GuestCount__c: 1, MemberPresent__c: true })
    ).rejects.toMatchObject({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });

    await org.tenant((c) => c.query(`DELETE FROM validation_rule WHERE api_name = 'Broken'`));
    invalidateOrgMeta(org.orgId);
  });
});

describe('workflow field updates', () => {
  it('sets a field when the criteria match', async () => {
    await addWorkflow({
      apiName: 'ConfirmSmallParties',
      label: 'Auto-confirm small parties',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'GuestCount__c', op: 'lessOrEqual', value: 2 }],
      actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Confirmed' }]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Pair', GuestCount__c: 2, MemberPresent__c: true, Status__c: 'Booked' });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.Status__c).toBe('Confirmed');
  });

  it('leaves records alone when the criteria do not match', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Party of five', GuestCount__c: 5, MemberPresent__c: true, Status__c: 'Booked' });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.Status__c).toBe('Booked');
  });

  it('computes a field update from a formula', async () => {
    await addWorkflow({
      apiName: 'NoteLargeParty',
      label: 'Note large parties',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'GuestCount__c', op: 'greaterOrEqual', value: 4 }],
      actions: [{ type: 'fieldUpdate', field: 'Notes__c', formula: '"Large party: " & TEXT(GuestCount__c) & " guests"' }]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Big party', GuestCount__c: 5, MemberPresent__c: true });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.Notes__c).toBe('Large party: 5 guests');
  });

  it('re-runs validation after a field update', async () => {
    await addWorkflow({
      apiName: 'BreakTheRules',
      label: 'Field update that violates a validation rule',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'Outlet__c', op: 'equals', value: 'Bedrooms' }],
      actions: [{ type: 'fieldUpdate', field: 'GuestCount__c', value: 99 }]
    });

    const ctx = context();
    await expect(
      insertRecord(ctx, 'GuestVisit__c', { Name: 'Should fail', GuestCount__c: 1, Outlet__c: 'Bedrooms', MemberPresent__c: true })
    ).rejects.toMatchObject({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });

    // The whole transaction rolled back, including the original insert.
    const found = await runQuery(ctx, "SELECT Id FROM GuestVisit__c WHERE Name = 'Should fail'");
    expect(found.totalSize).toBe(0);

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'BreakTheRules'`));
  });

  it('does not loop when a field update re-triggers its own rule', async () => {
    await addWorkflow({
      apiName: 'SelfTriggering',
      label: 'Rule whose update keeps matching its own criteria',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'Outlet__c', op: 'equals', value: 'Members Bar' }],
      actions: [{ type: 'fieldUpdate', field: 'Notes__c', formula: '"touched"' }]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Loopy', GuestCount__c: 1, Outlet__c: 'Members Bar', MemberPresent__c: true });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.Notes__c).toBe('touched');

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'SelfTriggering'`));
  });
});

describe('workflow trigger types', () => {
  it('onCreate fires only on insert', async () => {
    await addWorkflow({
      apiName: 'OnCreateOnly',
      label: 'On create only',
      objectApi: 'Account',
      triggerType: 'onCreate',
      criteria: [{ field: 'Industry', op: 'equals', value: 'Hospitality' }],
      actions: [{ type: 'fieldUpdate', field: 'Rating', value: 'Hot' }]
    });

    const ctx = context();
    const onInsert = await insertRecord(ctx, 'Account', { Name: 'Created hot', Industry: 'Hospitality' });
    expect((await getRecord(ctx, 'Account', onInsert))!.Rating).toBe('Hot');

    const later = await insertRecord(ctx, 'Account', { Name: 'Cold at first' });
    await updateRecord(ctx, 'Account', later, { Industry: 'Hospitality' });
    expect((await getRecord(ctx, 'Account', later))!.Rating ?? null).toBeNull();

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'OnCreateOnly'`));
  });

  it('criteria-changed fires on the transition only', async () => {
    await addWorkflow({
      apiName: 'OnTransition',
      label: 'Only when newly meeting criteria',
      objectApi: 'Account',
      triggerType: 'onCreateOrUpdateMeetingCriteriaChanged',
      criteria: [{ field: 'Rating', op: 'equals', value: 'Hot' }],
      actions: [{ type: 'fieldUpdate', field: 'Description', formula: '"marked hot"' }]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'Account', { Name: 'Transitioning' });
    await updateRecord(ctx, 'Account', id, { Rating: 'Hot' });
    expect((await getRecord(ctx, 'Account', id))!.Description).toBe('marked hot');

    // Clear the marker; a further save while still Hot must not set it again.
    await updateRecord(ctx, 'Account', id, { Description: null });
    await updateRecord(ctx, 'Account', id, { Phone: '020 7629 5126' });
    expect((await getRecord(ctx, 'Account', id))!.Description ?? null).toBeNull();

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'OnTransition'`));
  });

  it('supports formula criteria', async () => {
    await addWorkflow({
      apiName: 'FormulaCriteria',
      label: 'Formula criteria',
      objectApi: 'GuestVisit__c',
      criteriaFormula: 'AND(GuestCount__c >= 3, Outlet__c = "Dining Room")',
      actions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Booked' }]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', {
      Name: 'Formula match',
      GuestCount__c: 3,
      Outlet__c: 'Dining Room',
      MemberPresent__c: true
    });
    expect((await getRecord(ctx, 'GuestVisit__c', id))!.Status__c).toBe('Booked');

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'FormulaCriteria'`));
  });
});

describe('workflow actions', () => {
  it('queues an email alert with merged fields', async () => {
    await addWorkflow({
      apiName: 'ConfirmGuests',
      label: 'Email the host',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'Outlet__c', op: 'equals', value: 'Dining Room' }],
      actions: [
        {
          type: 'emailAlert',
          template: 'GuestConfirmation',
          recipients: [{ type: 'email', value: 'reservations@orientalclub.org.uk' }]
        }
      ]
    });

    const ctx = context();
    await insertRecord(ctx, 'GuestVisit__c', {
      Name: 'Dinner booking',
      GuestCount__c: 2,
      Outlet__c: 'Dining Room',
      VisitDate__c: '2026-09-15',
      MemberPresent__c: true
    });

    const rows = await org.tenant((c) =>
      c.query(`SELECT to_addrs, subject, body_text, status FROM email_outbound ORDER BY created_at DESC LIMIT 1`)
    );
    expect(rows.rows[0].status).toBe('Queued');
    expect(rows.rows[0].subject).toBe('Your guests on 2026-09-15');
    expect(rows.rows[0].body_text).toContain('2 guests in the Dining Room');

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'ConfirmGuests'`));
  });

  it('creates a follow-up task', async () => {
    await addWorkflow({
      apiName: 'ChaseLargeParty',
      label: 'Chase large parties',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'GuestCount__c', op: 'greaterOrEqual', value: 5 }],
      actions: [{ type: 'task', subject: 'Confirm arrangements for {!Name}', dueDays: 3, priority: 'High' }]
    });

    const ctx = context();
    const visit = await insertRecord(ctx, 'GuestVisit__c', { Name: 'Six for lunch', GuestCount__c: 6, MemberPresent__c: true });

    const tasks = await runQuery(ctx, `SELECT Subject, Priority, WhatId FROM Task WHERE WhatId = '${visit}'`);
    expect(tasks.totalSize).toBe(1);
    expect(tasks.records[0].Subject).toBe('Confirm arrangements for Six for lunch');
    expect(tasks.records[0].Priority).toBe('High');

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'ChaseLargeParty'`));
  });

  it('queues an outbound message rather than posting inside the transaction', async () => {
    await addWorkflow({
      apiName: 'NotifyDoor',
      label: 'Notify the door system',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'Status__c', op: 'equals', value: 'Confirmed' }],
      actions: [{ type: 'outboundMessage', endpoint: 'https://door.example/api/visits', fields: ['Name', 'GuestCount__c'] }]
    });

    const ctx = context();
    await insertRecord(ctx, 'GuestVisit__c', { Name: 'Door notify', GuestCount__c: 1, Status__c: 'Confirmed', MemberPresent__c: true });

    const queued = await org.tenant((c) =>
      c.query(`SELECT kind, payload, status FROM time_trigger_queue WHERE kind = 'outboundMessage'`)
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0].status).toBe('Pending');
    const payload = typeof queued.rows[0].payload === 'string' ? JSON.parse(queued.rows[0].payload) : queued.rows[0].payload;
    expect(payload.endpoint).toBe('https://door.example/api/visits');
    expect(payload.payload).toEqual({ Name: 'Door notify', GuestCount__c: 1 });

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'NotifyDoor'`));
  });
});

describe('time-based triggers', () => {
  it('schedules an action relative to a date field', async () => {
    await addWorkflow({
      apiName: 'RemindBeforeVisit',
      label: 'Remind the day before',
      objectApi: 'GuestVisit__c',
      criteria: [{ field: 'Status__c', op: 'equals', value: 'Booked' }],
      timeTriggers: [
        { offsetHours: -24, base: 'VisitDate__c', actions: [{ type: 'emailAlert', template: 'GuestConfirmation', recipients: [] }] }
      ]
    });

    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', {
      Name: 'Future visit',
      GuestCount__c: 2,
      Status__c: 'Booked',
      VisitDate__c: '2026-12-24',
      MemberPresent__c: true
    });

    const queued = await org.tenant((c) =>
      c.query(`SELECT fire_at, status FROM time_trigger_queue WHERE kind = 'workflow' AND record_id = $1`, [id])
    );
    expect(queued.rows).toHaveLength(1);
    expect(new Date(queued.rows[0].fire_at).toISOString()).toBe('2026-12-23T00:00:00.000Z');
  });

  it('withdraws a pending trigger when the record stops matching', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'GuestVisit__c', {
      Name: 'Cancelling visit',
      GuestCount__c: 2,
      Status__c: 'Booked',
      VisitDate__c: '2026-12-24',
      MemberPresent__c: true
    });
    expect(
      (await org.tenant((c) => c.query(`SELECT 1 FROM time_trigger_queue WHERE record_id = $1 AND status = 'Pending'`, [id]))).rows
    ).toHaveLength(1);

    await updateRecord(ctx, 'GuestVisit__c', id, { Status__c: 'Cancelled' });
    expect(
      (await org.tenant((c) => c.query(`SELECT 1 FROM time_trigger_queue WHERE record_id = $1 AND status = 'Pending'`, [id]))).rows
    ).toHaveLength(0);

    await org.tenant((c) => c.query(`DELETE FROM workflow_rule WHERE api_name = 'RemindBeforeVisit'`));
  });
});

describe('helpers', () => {
  it('evaluates filter operators', () => {
    const record = { Name: 'Oriental', Count: 5, Empty: null };
    expect(matchesFilters(record, [{ field: 'Name', op: 'equals', value: 'oriental' }])).toBe(true);
    expect(matchesFilters(record, [{ field: 'Count', op: 'greaterThan', value: 4 }])).toBe(true);
    expect(matchesFilters(record, [{ field: 'Count', op: 'lessThan', value: 4 }])).toBe(false);
    expect(matchesFilters(record, [{ field: 'Name', op: 'startsWith', value: 'Ori' }])).toBe(true);
    expect(matchesFilters(record, [{ field: 'Empty', op: 'isNull', value: true }])).toBe(true);
    expect(matchesFilters(record, [{ field: 'Name', op: 'in', value: ['Oriental', 'Other'] }])).toBe(true);
    // Filters are AND-joined.
    expect(
      matchesFilters(record, [
        { field: 'Name', op: 'equals', value: 'Oriental' },
        { field: 'Count', op: 'equals', value: 9 }
      ])
    ).toBe(false);
  });

  it('merges fields and blanks unresolved ones', async () => {
    const meta = await org.meta();
    const obj = meta.objects.get('account')!;
    const record = { Name: 'The Oriental Club', Industry: null };
    expect(mergeFields('Welcome to {!Name}', { object: obj, record })).toBe('Welcome to The Oriental Club');
    expect(mergeFields('Welcome to {!Account.Name}', { object: obj, record })).toBe('Welcome to The Oriental Club');
    expect(mergeFields('Industry: {!Industry}.', { object: obj, record })).toBe('Industry: .');
    expect(mergeFields('Unknown: {!Nope}.', { object: obj, record })).toBe('Unknown: .');
  });
});
