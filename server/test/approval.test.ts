import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { rawInsert, ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, getRecord, insertRecord, updateRecord } from '../src/dml/index.js';
import { installAutomation } from '../src/automation/index.js';
import {
  approve,
  historyForRecord,
  pendingForUser,
  recall,
  reject,
  submitForApproval
} from '../src/approval/index.js';
import { generateId, KEY_PREFIXES } from '../src/util/ids.js';
import { testOrg, type TestOrg } from './helpers.js';

let org: TestOrg;
const users: Record<string, string> = {};
let committeeQueueId: string;

function ctxFor(userId: string, admin = false): RequestContext {
  return new RequestContext({
    db: org.db,
    orgId: org.orgId,
    schema: org.schema,
    userId,
    perms: admin ? ADMIN_PERMS : {},
    limits: new LimitContext({ dmlRows: 5000, dmlStatements: 5000, soqlQueries: 5000, queryRows: 500000 })
  });
}

const adminCtx = () => ctxFor(org.adminUserId, true);

let standardProfileId: string;

async function makeUser(name: string, managerId?: string): Promise<string> {
  const userId = generateId(KEY_PREFIXES.User);
  const slug = name.toLowerCase().replace(/\s+/g, '.');
  await org.tenant((c) =>
    rawInsert(c, 'User', userId, name, {
      Username: `${slug}@orientalclub.org.uk`,
      Email: `${slug}@orientalclub.org.uk`,
      LastName: name,
      IsActive: true,
      ProfileId: standardProfileId,
      ManagerId: managerId ?? null
    })
  );
  return userId;
}

async function defineProcess(p: {
  apiName: string;
  objectApi: string;
  steps: any[];
  entryCriteria?: any;
  lockRecord?: boolean;
  allowRecall?: boolean;
  initialSubmitActions?: any[];
  finalApproveActions?: any[];
  finalRejectActions?: any[];
  recallActions?: any[];
}): Promise<string> {
  const id = generateId(KEY_PREFIXES.ApprovalProcess);
  await org.tenant((c) =>
    c.query(
      `INSERT INTO approval_process
         (id, object_api, api_name, label, entry_criteria, lock_record, allow_recall, steps,
          initial_submit_actions, final_approve_actions, final_reject_actions, recall_actions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        p.objectApi,
        p.apiName,
        p.apiName,
        p.entryCriteria ? JSON.stringify(p.entryCriteria) : null,
        p.lockRecord ?? true,
        p.allowRecall ?? true,
        JSON.stringify(p.steps),
        JSON.stringify(p.initialSubmitActions ?? []),
        JSON.stringify(p.finalApproveActions ?? []),
        JSON.stringify(p.finalRejectActions ?? []),
        JSON.stringify(p.recallActions ?? [])
      ]
    )
  );
  return id;
}

const dropProcess = (apiName: string) =>
  org.tenant((c) => c.query(`DELETE FROM approval_process WHERE api_name = $1`, [apiName]));

const clearWorkItems = () => org.tenant((c) => c.query(`DELETE FROM approval_work_item`));

/** A membership application: the club's real approval shape. */
async function newApplication(fields: Record<string, any> = {}): Promise<string> {
  return insertRecord(adminCtx(), 'Application__c', {
    Name: 'Application',
    Category__c: 'Full',
    Status__c: 'Draft',
    ...fields
  });
}

beforeAll(async () => {
  org = await testOrg();
  installAutomation();

  const profiles = await org.tenant((c) => c.query<{ id: string }>(`SELECT id FROM profile WHERE name = 'Standard User'`));
  standardProfileId = profiles.rows[0].id;

  users.secretary = await makeUser('Sylvia Secretary');
  users.chair = await makeUser('Charles Chair');
  users.proposer = await makeUser('Percy Proposer', users.secretary);
  users.committeeA = await makeUser('Clara Committee');
  users.committeeB = await makeUser('Cyril Committee');
  users.outsider = await makeUser('Oswald Outsider');

  committeeQueueId = generateId(KEY_PREFIXES.Group);
  await org.tenant((c) =>
    c.query(
      `INSERT INTO group_def (id, api_name, label, type, member_ids) VALUES ($1,'SubCommittee','Membership Sub-Committee','Queue',$2)`,
      [committeeQueueId, JSON.stringify([users.committeeA, users.committeeB])]
    )
  );

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Application__c',
      label: 'Membership Application',
      pluralLabel: 'Membership Applications',
      isCustom: true,
      fields: [
        { apiName: 'Category__c', label: 'Category', type: 'Picklist', picklist: { values: ['Full', 'Associate', 'OC7'] } },
        {
          apiName: 'Status__c',
          label: 'Status',
          type: 'Picklist',
          picklist: { values: ['Draft', 'Submitted', 'Waiting List', 'Elected', 'Declined', 'Withdrawn'] }
        },
        { apiName: 'Proposer__c', label: 'Proposer', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'Proposed' },
        { apiName: 'Seconder__c', label: 'Seconder', type: 'Lookup', referenceTo: 'Contact', relationshipName: 'Seconded' },
        { apiName: 'Notes__c', label: 'Notes', type: 'TextArea' }
      ]
    })
  );

  // CRUD on the custom object for the standard profile, which provisioning could not know about.
  await org.tenant((c) =>
    c.query(
      `INSERT INTO object_perm (id, parent_id, object_api, can_create, can_read, can_edit, can_delete)
       VALUES ($1,$2,'Application__c',true,true,true,true)`,
      [generateId('0PS'), standardProfileId]
    )
  );

  invalidateOrgMeta(org.orgId);
  const { invalidateUserAccess } = await import('../src/security/index.js');
  invalidateUserAccess(org.orgId);
});

afterAll(() => {
  clearDmlHooks();
});

describe('submission', () => {
  it('creates a work item for the first step', async () => {
    await defineProcess({
      apiName: 'SingleStep',
      objectApi: 'Application__c',
      steps: [{ name: 'Membership Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const id = await newApplication();
    const result = await submitForApproval(adminCtx(), 'Application__c', id);
    expect(result.status).toBe('Pending');
    expect(result.stepName).toBe('Membership Secretary');
    expect(result.workItemIds).toHaveLength(1);

    const inbox = await pendingForUser(ctxFor(users.secretary));
    expect(inbox.map((i) => i.recordId)).toContain(id);

    await clearWorkItems();
    await dropProcess('SingleStep');
  });

  it('refuses a record already awaiting approval', async () => {
    await defineProcess({
      apiName: 'Duplicate',
      objectApi: 'Application__c',
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const id = await newApplication();
    await submitForApproval(adminCtx(), 'Application__c', id);
    await expect(submitForApproval(adminCtx(), 'Application__c', id)).rejects.toMatchObject({
      errorCode: 'INVALID_OPERATION'
    });

    await clearWorkItems();
    await dropProcess('Duplicate');
  });

  it('refuses a record that does not meet the entry criteria', async () => {
    await defineProcess({
      apiName: 'FullOnly',
      objectApi: 'Application__c',
      entryCriteria: [{ field: 'Category__c', op: 'equals', value: 'Full' }],
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const associate = await newApplication({ Category__c: 'Associate' });
    await expect(submitForApproval(adminCtx(), 'Application__c', associate)).rejects.toMatchObject({
      errorCode: 'INVALID_OPERATION'
    });

    const full = await newApplication({ Category__c: 'Full' });
    await expect(submitForApproval(adminCtx(), 'Application__c', full)).resolves.toMatchObject({ status: 'Pending' });

    await clearWorkItems();
    await dropProcess('FullOnly');
  });

  it('runs initial submit actions', async () => {
    await defineProcess({
      apiName: 'MarkSubmitted',
      objectApi: 'Application__c',
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }],
      initialSubmitActions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Submitted' }]
    });

    const id = await newApplication();
    await submitForApproval(adminCtx(), 'Application__c', id);
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).toBe('Submitted');

    await clearWorkItems();
    await dropProcess('MarkSubmitted');
  });

  it('routes to the submitter’s manager', async () => {
    await defineProcess({
      apiName: 'ManagerStep',
      objectApi: 'Application__c',
      steps: [{ name: 'Line manager', approverType: 'manager' }]
    });

    const id = await newApplication();
    const result = await submitForApproval(ctxFor(users.proposer), 'Application__c', id);
    const items = await pendingForUser(ctxFor(users.secretary));
    expect(items.map((i) => i.id)).toContain(result.workItemIds[0]);

    await clearWorkItems();
    await dropProcess('ManagerStep');
  });

  it('explains itself when the manager route has no manager', async () => {
    await defineProcess({
      apiName: 'NoManager',
      objectApi: 'Application__c',
      steps: [{ name: 'Line manager', approverType: 'manager' }]
    });

    const id = await newApplication();
    await expect(submitForApproval(ctxFor(users.outsider), 'Application__c', id)).rejects.toMatchObject({
      errorCode: 'INVALID_OPERATION'
    });

    await dropProcess('NoManager');
  });
});

describe('record locking', () => {
  beforeAll(async () => {
    await defineProcess({
      apiName: 'Locking',
      objectApi: 'Application__c',
      lockRecord: true,
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });
  });

  afterAll(async () => {
    await clearWorkItems();
    await dropProcess('Locking');
  });

  it('locks the record while the approval is pending', async () => {
    const id = await newApplication();
    await submitForApproval(ctxFor(users.proposer), 'Application__c', id);

    await expect(updateRecord(ctxFor(users.proposer), 'Application__c', id, { Notes__c: 'sneaky' })).rejects.toMatchObject({
      errorCode: 'ENTITY_IS_LOCKED'
    });
  });

  it('lets an administrator edit a locked record', async () => {
    const id = await newApplication();
    await submitForApproval(ctxFor(users.proposer), 'Application__c', id);
    await expect(updateRecord(adminCtx(), 'Application__c', id, { Notes__c: 'admin override' })).resolves.toBeUndefined();
  });

  it('unlocks once the approval completes', async () => {
    const id = await newApplication();
    const submitted = await submitForApproval(ctxFor(users.proposer), 'Application__c', id);
    await approve(ctxFor(users.secretary), submitted.workItemIds[0]);
    await expect(updateRecord(ctxFor(users.proposer), 'Application__c', id, { Notes__c: 'now allowed' })).resolves.toBeUndefined();
  });
});

describe('multi-step approval', () => {
  it('advances through the steps and finishes approved', async () => {
    await defineProcess({
      apiName: 'TwoStep',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [
        { name: 'Membership Secretary', approverType: 'user', approverId: users.secretary },
        { name: 'Chair', approverType: 'user', approverId: users.chair }
      ],
      finalApproveActions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Elected' }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);
    expect(submitted.stepName).toBe('Membership Secretary');

    const first = await approve(ctxFor(users.secretary), submitted.workItemIds[0], { comment: 'Knows the candidate well.' });
    expect(first.status).toBe('Pending');
    expect(first.stepName).toBe('Chair');

    const second = await approve(ctxFor(users.chair), first.workItemIds[0]);
    expect(second.status).toBe('Approved');
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).toBe('Elected');

    await clearWorkItems();
    await dropProcess('TwoStep');
  });

  it('skips a step whose criteria the record does not meet', async () => {
    await defineProcess({
      apiName: 'ConditionalStep',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [
        { name: 'Secretary', approverType: 'user', approverId: users.secretary },
        {
          name: 'Chair for Full only',
          approverType: 'user',
          approverId: users.chair,
          criteria: [{ field: 'Category__c', op: 'equals', value: 'Full' }]
        }
      ]
    });

    const associate = await newApplication({ Category__c: 'Associate' });
    const submitted = await submitForApproval(adminCtx(), 'Application__c', associate);
    const result = await approve(ctxFor(users.secretary), submitted.workItemIds[0]);
    expect(result.status).toBe('Approved'); // the Chair step was skipped

    await clearWorkItems();
    await dropProcess('ConditionalStep');
  });

  it('rejects outright and stops the process', async () => {
    await defineProcess({
      apiName: 'Rejectable',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [
        { name: 'Secretary', approverType: 'user', approverId: users.secretary },
        { name: 'Chair', approverType: 'user', approverId: users.chair }
      ],
      finalRejectActions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Declined' }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);
    const result = await reject(ctxFor(users.secretary), submitted.workItemIds[0], { comment: 'Not this year.' });

    expect(result.status).toBe('Rejected');
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).toBe('Declined');
    expect(await pendingForUser(ctxFor(users.chair))).toHaveLength(0);

    await clearWorkItems();
    await dropProcess('Rejectable');
  });
});

describe('queue approvals', () => {
  it('gives every queue member a work item and lets the first response decide', async () => {
    await defineProcess({
      apiName: 'CommitteeFirst',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [{ name: 'Sub-Committee', approverType: 'queue', approverId: committeeQueueId }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);
    expect(submitted.workItemIds).toHaveLength(2);

    const result = await approve(ctxFor(users.committeeA), submitted.workItemIds[0]);
    expect(result.status).toBe('Approved');
    // The other member's item is closed, not left dangling.
    expect(await pendingForUser(ctxFor(users.committeeB))).toHaveLength(0);

    await clearWorkItems();
    await dropProcess('CommitteeFirst');
  });

  it('waits for every member when the step is unanimous', async () => {
    await defineProcess({
      apiName: 'CommitteeUnanimous',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [{ name: 'Sub-Committee', approverType: 'queue', approverId: committeeQueueId, unanimity: true }],
      finalApproveActions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Elected' }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);

    const first = await approve(ctxFor(users.committeeA), submitted.workItemIds[0]);
    expect(first.status).toBe('Pending');
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).not.toBe('Elected');

    const second = await approve(ctxFor(users.committeeB), submitted.workItemIds[1]);
    expect(second.status).toBe('Approved');
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).toBe('Elected');

    await clearWorkItems();
    await dropProcess('CommitteeUnanimous');
  });
});

describe('permissions and recall', () => {
  it('refuses a decision from someone who is not an approver', async () => {
    await defineProcess({
      apiName: 'Guarded',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);
    await expect(approve(ctxFor(users.outsider), submitted.workItemIds[0])).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY'
    });

    await clearWorkItems();
    await dropProcess('Guarded');
  });

  it('refuses a second decision on a settled item', async () => {
    await defineProcess({
      apiName: 'Settled',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id);
    await approve(ctxFor(users.secretary), submitted.workItemIds[0]);
    await expect(approve(ctxFor(users.secretary), submitted.workItemIds[0])).rejects.toMatchObject({
      errorCode: 'INVALID_OPERATION'
    });

    await clearWorkItems();
    await dropProcess('Settled');
  });

  it('lets the submitter recall, and nobody else', async () => {
    await defineProcess({
      apiName: 'Recallable',
      objectApi: 'Application__c',
      lockRecord: true,
      allowRecall: true,
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }],
      recallActions: [{ type: 'fieldUpdate', field: 'Status__c', value: 'Withdrawn' }]
    });

    const id = await newApplication();
    await submitForApproval(ctxFor(users.proposer), 'Application__c', id);

    await expect(recall(ctxFor(users.outsider), id)).rejects.toMatchObject({
      errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY'
    });

    await recall(ctxFor(users.proposer), id);
    expect((await getRecord(adminCtx(), 'Application__c', id))!.Status__c).toBe('Withdrawn');
    expect(await pendingForUser(ctxFor(users.secretary))).toHaveLength(0);
    // The lock is released with the recall.
    await expect(updateRecord(ctxFor(users.proposer), 'Application__c', id, { Notes__c: 'ok now' })).resolves.toBeUndefined();

    await clearWorkItems();
    await dropProcess('Recallable');
  });

  it('honours a process that forbids recall', async () => {
    await defineProcess({
      apiName: 'NoRecall',
      objectApi: 'Application__c',
      lockRecord: false,
      allowRecall: false,
      steps: [{ name: 'Secretary', approverType: 'user', approverId: users.secretary }]
    });

    const id = await newApplication();
    await submitForApproval(ctxFor(users.proposer), 'Application__c', id);
    await expect(recall(ctxFor(users.proposer), id)).rejects.toMatchObject({ errorCode: 'INVALID_OPERATION' });

    await clearWorkItems();
    await dropProcess('NoRecall');
  });
});

describe('history', () => {
  it('records the trail with comments', async () => {
    await defineProcess({
      apiName: 'Audited',
      objectApi: 'Application__c',
      lockRecord: false,
      steps: [
        { name: 'Secretary', approverType: 'user', approverId: users.secretary },
        { name: 'Chair', approverType: 'user', approverId: users.chair }
      ]
    });

    const id = await newApplication();
    const submitted = await submitForApproval(adminCtx(), 'Application__c', id, { comment: 'Proposed and seconded.' });
    const next = await approve(ctxFor(users.secretary), submitted.workItemIds[0], { comment: 'Content.' });
    await approve(ctxFor(users.chair), next.workItemIds[0], { comment: 'Agreed.' });

    const history = await historyForRecord(adminCtx(), id);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.status === 'Approved')).toBe(true);
    const secretaryItem = history.find((h) => h.stepName === 'Secretary')!;
    expect(secretaryItem.actorId).toBe(users.secretary);
    expect(secretaryItem.comments.map((c) => c.comment)).toContain('Content.');

    await clearWorkItems();
    await dropProcess('Audited');
  });
});
