import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installObject } from '../src/metadata/installer.js';
import { invalidateOrgMeta } from '../src/metadata/registry.js';
import { ADMIN_PERMS } from '../src/db/provision.js';
import { RequestContext } from '../src/runtime/context.js';
import { LimitContext } from '../src/runtime/limits.js';
import { clearDmlHooks, deleteRecords, insertRecord, undeleteRecords, updateRecord } from '../src/dml/index.js';
import { runQuery } from '../src/soql/index.js';
import {
  availability,
  confirm,
  decodeSpan,
  defineResource,
  encodeSpan,
  expireHolds,
  installInventory,
  listResources,
  release,
  releaseForRecord,
  reserve,
  stepsBetween,
  STRIDE
} from '../src/inventory/index.js';
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

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  org = await testOrg();
  installInventory();

  // The club's real shapes: a named suite, a pool of King rooms, a dining room with covers.
  await defineResource(context(), {
    apiName: 'Wellington_Suite',
    label: 'Wellington Suite',
    kind: 'Bedroom',
    mode: 'exclusive',
    grain: 'day'
  });
  await defineResource(context(), {
    apiName: 'Boardroom',
    label: 'Boardroom',
    kind: 'Venue',
    mode: 'exclusive',
    grain: 'minute'
  });
  await defineResource(context(), {
    apiName: 'King_Room',
    label: 'King Room',
    kind: 'Bedroom',
    mode: 'pool',
    capacity: 4,
    grain: 'day'
  });
  await defineResource(context(), {
    apiName: 'Dining_Room',
    label: 'Dining Room',
    kind: 'Cover',
    mode: 'pool',
    capacity: 60,
    grain: 'day'
  });
  // The Members' Bar opens Tuesday to Friday only — data on the resource, not code.
  await defineResource(context(), {
    apiName: 'Members_Bar',
    label: "Members' Bar",
    kind: 'Cover',
    mode: 'pool',
    capacity: 20,
    grain: 'minute',
    windows: [
      { day: 2, from: '11:30', to: '14:00' },
      { day: 3, from: '11:30', to: '14:00' },
      { day: 4, from: '11:30', to: '14:00' },
      { day: 5, from: '11:30', to: '14:00' }
    ]
  });

  await org.tenant((c) =>
    installObject(c, {
      apiName: 'Booking__c',
      label: 'Booking',
      pluralLabel: 'Bookings',
      isCustom: true,
      booking: {
        resourceField: 'Resource__c',
        startField: 'Starts__c',
        endField: 'Ends__c',
        quantityField: 'Places__c',
        statusField: 'Status__c',
        cancelledValues: ['Cancelled']
      },
      fields: [
        { apiName: 'Resource__c', label: 'Resource', type: 'Text', length: 80 },
        { apiName: 'Starts__c', label: 'Starts', type: 'DateTime' },
        { apiName: 'Ends__c', label: 'Ends', type: 'DateTime' },
        { apiName: 'Places__c', label: 'Places', type: 'Number', precision: 4, scale: 0 },
        {
          apiName: 'Status__c',
          label: 'Status',
          type: 'Picklist',
          picklist: { values: ['Confirmed', 'Cancelled'] }
        }
      ]
    })
  );
  invalidateOrgMeta(org.orgId);
});

afterAll(() => {
  clearDmlHooks();
});

// --------------------------------------------------------------- span encoding

describe('folding the resource into the range', () => {
  it('keeps every resource in its own band', () => {
    const a = encodeSpan(1n, at('2026-09-01T00:00:00Z'), at('2026-09-05T00:00:00Z'), 'day');
    const b = encodeSpan(2n, at('2026-09-01T00:00:00Z'), at('2026-09-05T00:00:00Z'), 'day');
    expect(decodeSpan(a).ordinal).toBe(1n);
    expect(decodeSpan(b).ordinal).toBe(2n);
    // Identical dates, but the ranges cannot overlap because the bands do not.
    expect(decodeSpan(a).from).toBe(decodeSpan(b).from);
    expect(BigInt(/\[(\d+)/.exec(b)![1]) - BigInt(/\[(\d+)/.exec(a)![1])).toBe(STRIDE);
  });

  it('treats the end as exclusive, so back-to-back stays do not clash', () => {
    const steps = stepsBetween(at('2026-09-01T00:00:00Z'), at('2026-09-05T00:00:00Z'), 'day');
    // Nights of the 1st, 2nd, 3rd and 4th — the 5th is free for the next guest.
    expect(steps).toHaveLength(4);
  });

  it('claims at least one step for a zero-length booking', () => {
    expect(stepsBetween(at('2026-09-01T12:00:00Z'), at('2026-09-01T12:00:00Z'), 'minute')).toHaveLength(1);
  });

  it('refuses dates outside the allocatable range', () => {
    expect(() => encodeSpan(1n, at('1969-01-01T00:00:00Z'), at('1969-01-02T00:00:00Z'), 'day')).toThrow(/before 1970/);
  });
});

// ------------------------------------------------------------------ exclusive

describe('an exclusive resource', () => {
  it('accepts a booking and refuses an overlapping one', async () => {
    const ctx = context();
    await reserve(ctx, {
      resource: 'Wellington_Suite',
      objectApi: 'Booking__c',
      recordId: '000000000000000001',
      startsAt: at('2026-10-01T00:00:00Z'),
      endsAt: at('2026-10-05T00:00:00Z')
    });

    await expect(
      reserve(ctx, {
        resource: 'Wellington_Suite',
        objectApi: 'Booking__c',
        recordId: '000000000000000002',
        startsAt: at('2026-10-04T00:00:00Z'),
        endsAt: at('2026-10-06T00:00:00Z')
      })
    ).rejects.toMatchObject({ errorCode: 'INVALID_OPERATION' });
  });

  it('allows a stay starting the day the last one ends', async () => {
    const ctx = context();
    const alloc = await reserve(ctx, {
      resource: 'Wellington_Suite',
      objectApi: 'Booking__c',
      recordId: '000000000000000003',
      startsAt: at('2026-10-05T00:00:00Z'),
      endsAt: at('2026-10-07T00:00:00Z')
    });
    expect(alloc.status).toBe('Reserved');
  });

  it('does not confuse one resource with another', async () => {
    const ctx = context();
    const alloc = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000004',
      startsAt: at('2026-10-01T09:00:00Z'),
      endsAt: at('2026-10-01T17:00:00Z')
    });
    expect(alloc.status).toBe('Reserved');
  });

  it('frees the dates again when released', async () => {
    const ctx = context();
    const first = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000005',
      startsAt: at('2026-11-01T09:00:00Z'),
      endsAt: at('2026-11-01T12:00:00Z')
    });
    await expect(
      reserve(ctx, {
        resource: 'Boardroom',
        objectApi: 'Booking__c',
        recordId: '000000000000000006',
        startsAt: at('2026-11-01T10:00:00Z'),
        endsAt: at('2026-11-01T11:00:00Z')
      })
    ).rejects.toThrow();

    await release(ctx, first.id);
    const second = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000006',
      startsAt: at('2026-11-01T10:00:00Z'),
      endsAt: at('2026-11-01T11:00:00Z')
    });
    expect(second.status).toBe('Reserved');
  });
});

// ----------------------------------------------------------------------- pool

describe('a pool resource', () => {
  it('sells up to capacity and no further', async () => {
    const ctx = context();
    for (let i = 0; i < 4; i++) {
      await reserve(ctx, {
        resource: 'King_Room',
        objectApi: 'Booking__c',
        recordId: `00000000000000010${i}`,
        startsAt: at('2026-12-01T00:00:00Z'),
        endsAt: at('2026-12-02T00:00:00Z')
      });
    }
    await expect(
      reserve(ctx, {
        resource: 'King_Room',
        objectApi: 'Booking__c',
        recordId: '000000000000000109',
        startsAt: at('2026-12-01T00:00:00Z'),
        endsAt: at('2026-12-02T00:00:00Z')
      })
    ).rejects.toMatchObject({ errorCode: 'INVALID_OPERATION' });
  });

  it('counts each night separately', async () => {
    const ctx = context();
    // The 2nd is untouched by the four bookings above, so it is still open.
    const alloc = await reserve(ctx, {
      resource: 'King_Room',
      objectApi: 'Booking__c',
      recordId: '000000000000000110',
      startsAt: at('2026-12-02T00:00:00Z'),
      endsAt: at('2026-12-03T00:00:00Z')
    });
    expect(alloc.status).toBe('Reserved');
  });

  it('takes a quantity in one go', async () => {
    const ctx = context();
    const alloc = await reserve(ctx, {
      resource: 'Dining_Room',
      objectApi: 'Booking__c',
      recordId: '000000000000000200',
      startsAt: at('2026-12-24T00:00:00Z'),
      endsAt: at('2026-12-25T00:00:00Z'),
      quantity: 50
    });
    expect(alloc.quantity).toBe(50);

    await expect(
      reserve(ctx, {
        resource: 'Dining_Room',
        objectApi: 'Booking__c',
        recordId: '000000000000000201',
        startsAt: at('2026-12-24T00:00:00Z'),
        endsAt: at('2026-12-25T00:00:00Z'),
        quantity: 11
      })
    ).rejects.toThrow(/not available/);
  });

  it('gives the places back on release', async () => {
    const ctx = context();
    const alloc = await reserve(ctx, {
      resource: 'Dining_Room',
      objectApi: 'Booking__c',
      recordId: '000000000000000202',
      startsAt: at('2027-01-05T00:00:00Z'),
      endsAt: at('2027-01-06T00:00:00Z'),
      quantity: 60
    });
    await release(ctx, alloc.id);
    const after = await availability(ctx, {
      resource: 'Dining_Room',
      from: at('2027-01-05T00:00:00Z'),
      to: at('2027-01-06T00:00:00Z')
    });
    expect(after.slots[0].taken).toBe(0);
  });

  it('rejects a quantity on an exclusive resource', async () => {
    await expect(
      reserve(context(), {
        resource: 'Wellington_Suite',
        objectApi: 'Booking__c',
        recordId: '000000000000000203',
        startsAt: at('2027-02-01T00:00:00Z'),
        endsAt: at('2027-02-02T00:00:00Z'),
        quantity: 3
      })
    ).rejects.toThrow(/booked whole/);
  });
});

// -------------------------------------------------------------- overbooking

describe('overbooking policy', () => {
  it('is refused by default and allowed by configuration', async () => {
    const ctx = context();
    await defineResource(ctx, {
      apiName: 'Terrace',
      label: 'Terrace',
      kind: 'Cover',
      mode: 'pool',
      capacity: 2,
      overbook: 1,
      grain: 'day'
    });
    for (let i = 0; i < 3; i++) {
      await reserve(ctx, {
        resource: 'Terrace',
        objectApi: 'Booking__c',
        recordId: `00000000000000030${i}`,
        startsAt: at('2027-03-01T00:00:00Z'),
        endsAt: at('2027-03-02T00:00:00Z')
      });
    }
    // Two places plus one of overbooking is the ceiling; the fourth is refused.
    await expect(
      reserve(ctx, {
        resource: 'Terrace',
        objectApi: 'Booking__c',
        recordId: '000000000000000309',
        startsAt: at('2027-03-01T00:00:00Z'),
        endsAt: at('2027-03-02T00:00:00Z')
      })
    ).rejects.toThrow(/not available/);
  });
});

// -------------------------------------------------------------------- holds

describe('holds', () => {
  it('blocks like a reservation, then lapses', async () => {
    const ctx = context();
    const hold = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000400',
      startsAt: at('2027-04-01T09:00:00Z'),
      endsAt: at('2027-04-01T12:00:00Z'),
      holdMinutes: 15
    });
    expect(hold.status).toBe('Held');

    await expect(
      reserve(ctx, {
        resource: 'Boardroom',
        objectApi: 'Booking__c',
        recordId: '000000000000000401',
        startsAt: at('2027-04-01T10:00:00Z'),
        endsAt: at('2027-04-01T11:00:00Z')
      })
    ).rejects.toThrow(/not available/);

    // Force it past its expiry; the next reservation should sweep it aside.
    await org.tenant((c) =>
      c.query(`UPDATE inventory_allocation SET expires_at = now() - interval '1 minute' WHERE id = $1`, [hold.id])
    );
    const taken = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000401',
      startsAt: at('2027-04-01T10:00:00Z'),
      endsAt: at('2027-04-01T11:00:00Z')
    });
    expect(taken.status).toBe('Reserved');
  });

  it('can be confirmed into a firm booking', async () => {
    const ctx = context();
    const hold = await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000402',
      startsAt: at('2027-05-01T09:00:00Z'),
      endsAt: at('2027-05-01T12:00:00Z'),
      holdMinutes: 15
    });
    const firm = await confirm(ctx, hold.id);
    expect(firm.status).toBe('Reserved');
    expect(firm.expiresAt).toBeNull();
    await expect(confirm(ctx, hold.id)).rejects.toThrow(/lapsed or been confirmed/);
  });

  it('is swept by the housekeeping job', async () => {
    const ctx = context();
    const hold = await reserve(ctx, {
      resource: 'Dining_Room',
      objectApi: 'Booking__c',
      recordId: '000000000000000403',
      startsAt: at('2027-06-01T00:00:00Z'),
      endsAt: at('2027-06-02T00:00:00Z'),
      quantity: 10,
      holdMinutes: 5
    });
    await org.tenant((c) =>
      c.query(`UPDATE inventory_allocation SET expires_at = now() - interval '1 minute' WHERE id = $1`, [hold.id])
    );
    expect(await expireHolds(ctx)).toBeGreaterThan(0);
    const free = await availability(ctx, {
      resource: 'Dining_Room',
      from: at('2027-06-01T00:00:00Z'),
      to: at('2027-06-02T00:00:00Z')
    });
    expect(free.slots[0].taken).toBe(0);
  });
});

// ------------------------------------------------------------ opening hours

describe('opening hours are booking windows', () => {
  it('accepts a booking inside a window', async () => {
    // 2026-09-01 is a Tuesday.
    const alloc = await reserve(context(), {
      resource: 'Members_Bar',
      objectApi: 'Booking__c',
      recordId: '000000000000000500',
      startsAt: at('2026-09-01T12:00:00Z'),
      endsAt: at('2026-09-01T13:00:00Z'),
      quantity: 2
    });
    expect(alloc.status).toBe('Reserved');
  });

  it('refuses one outside the hours', async () => {
    await expect(
      reserve(context(), {
        resource: 'Members_Bar',
        objectApi: 'Booking__c',
        recordId: '000000000000000501',
        startsAt: at('2026-09-01T20:00:00Z'),
        endsAt: at('2026-09-01T21:00:00Z')
      })
    ).rejects.toThrow(/not open at that time/);
  });

  it('refuses one on a day it does not open', async () => {
    // 2026-09-07 is a Monday; the bar opens Tuesday to Friday.
    await expect(
      reserve(context(), {
        resource: 'Members_Bar',
        objectApi: 'Booking__c',
        recordId: '000000000000000502',
        startsAt: at('2026-09-07T12:00:00Z'),
        endsAt: at('2026-09-07T13:00:00Z')
      })
    ).rejects.toThrow(/not open on that day/);
  });
});

// ------------------------------------------------------------- availability

describe('availability', () => {
  it('reports remaining capacity per night', async () => {
    const ctx = context();
    await reserve(ctx, {
      resource: 'King_Room',
      objectApi: 'Booking__c',
      recordId: '000000000000000600',
      startsAt: at('2027-07-01T00:00:00Z'),
      endsAt: at('2027-07-02T00:00:00Z')
    });
    const result = await availability(ctx, {
      resource: 'King_Room',
      from: at('2027-07-01T00:00:00Z'),
      to: at('2027-07-03T00:00:00Z')
    });
    expect(result.mode).toBe('pool');
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].remaining).toBe(3);
    expect(result.slots[1].remaining).toBe(4);
  });

  it('reports an exclusive resource as busy or free', async () => {
    const ctx = context();
    await reserve(ctx, {
      resource: 'Wellington_Suite',
      objectApi: 'Booking__c',
      recordId: '000000000000000601',
      startsAt: at('2027-08-01T00:00:00Z'),
      endsAt: at('2027-08-03T00:00:00Z')
    });
    const busy = await availability(ctx, {
      resource: 'Wellington_Suite',
      from: at('2027-08-01T00:00:00Z'),
      to: at('2027-08-02T00:00:00Z')
    });
    expect(busy.available).toBe(false);

    const free = await availability(ctx, {
      resource: 'Wellington_Suite',
      from: at('2027-08-10T00:00:00Z'),
      to: at('2027-08-11T00:00:00Z')
    });
    expect(free.available).toBe(true);
  });

  it('answers for a requested party size', async () => {
    const result = await availability(context(), {
      resource: 'King_Room',
      from: at('2027-09-01T00:00:00Z'),
      to: at('2027-09-02T00:00:00Z'),
      quantity: 5
    });
    expect(result.available).toBe(false);
  });
});

// ------------------------------------------------- the club as ordinary data

describe('a Booking__c record drives allocation', () => {
  it('reserves on insert and refuses a clashing booking', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', {
      Name: 'Suite, October',
      Resource__c: 'Wellington_Suite',
      Starts__c: '2028-01-01T00:00:00Z',
      Ends__c: '2028-01-05T00:00:00Z',
      Status__c: 'Confirmed'
    });
    expect(id).toBeTruthy();

    await expect(
      insertRecord(ctx, 'Booking__c', {
        Name: 'Suite, clashing',
        Resource__c: 'Wellington_Suite',
        Starts__c: '2028-01-03T00:00:00Z',
        Ends__c: '2028-01-06T00:00:00Z',
        Status__c: 'Confirmed'
      })
    ).rejects.toMatchObject({ errorCode: 'INVALID_OPERATION' });

    // The losing booking must not exist — that is the whole point of allocating in `validate`.
    const rows = await runQuery(ctx, `SELECT Id FROM Booking__c WHERE Name = 'Suite, clashing'`);
    expect(rows.totalSize).toBe(0);
  });

  it('moves the allocation when the dates change', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', {
      Name: 'Boardroom, movable',
      Resource__c: 'Boardroom',
      Starts__c: '2028-02-01T09:00:00Z',
      Ends__c: '2028-02-01T10:00:00Z',
      Status__c: 'Confirmed'
    });

    await updateRecord(ctx, 'Booking__c', id, { Starts__c: '2028-02-01T14:00:00Z', Ends__c: '2028-02-01T15:00:00Z' });

    // The original slot is free again.
    const freed = await availability(ctx, {
      resource: 'Boardroom',
      from: at('2028-02-01T09:00:00Z'),
      to: at('2028-02-01T10:00:00Z')
    });
    expect(freed.available).toBe(true);
  });

  it('rolls back to the original dates when the new ones are taken', async () => {
    const ctx = context();
    await insertRecord(ctx, 'Booking__c', {
      Name: 'Boardroom, incumbent',
      Resource__c: 'Boardroom',
      Starts__c: '2028-03-01T09:00:00Z',
      Ends__c: '2028-03-01T10:00:00Z',
      Status__c: 'Confirmed'
    });
    const mover = await insertRecord(ctx, 'Booking__c', {
      Name: 'Boardroom, mover',
      Resource__c: 'Boardroom',
      Starts__c: '2028-03-02T09:00:00Z',
      Ends__c: '2028-03-02T10:00:00Z',
      Status__c: 'Confirmed'
    });

    await expect(
      updateRecord(ctx, 'Booking__c', mover, { Starts__c: '2028-03-01T09:00:00Z', Ends__c: '2028-03-01T10:00:00Z' })
    ).rejects.toThrow();

    // Its own slot must still be held: a failed move may not cost the booking its room.
    const original = await availability(ctx, {
      resource: 'Boardroom',
      from: at('2028-03-02T09:00:00Z'),
      to: at('2028-03-02T10:00:00Z')
    });
    expect(original.available).toBe(false);
  });

  it('releases capacity when the booking is cancelled', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', {
      Name: 'Dining, cancellable',
      Resource__c: 'Dining_Room',
      Starts__c: '2028-04-01T00:00:00Z',
      Ends__c: '2028-04-02T00:00:00Z',
      Places__c: 60,
      Status__c: 'Confirmed'
    });
    const full = await availability(ctx, {
      resource: 'Dining_Room',
      from: at('2028-04-01T00:00:00Z'),
      to: at('2028-04-02T00:00:00Z')
    });
    expect(full.slots[0].remaining).toBe(0);

    await updateRecord(ctx, 'Booking__c', id, { Status__c: 'Cancelled' });
    const freed = await availability(ctx, {
      resource: 'Dining_Room',
      from: at('2028-04-01T00:00:00Z'),
      to: at('2028-04-02T00:00:00Z')
    });
    expect(freed.slots[0].remaining).toBe(60);
  });

  it('releases capacity when the booking is deleted, and reclaims it on undelete', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Booking__c', {
      Name: 'Suite, deletable',
      Resource__c: 'Wellington_Suite',
      Starts__c: '2028-05-01T00:00:00Z',
      Ends__c: '2028-05-03T00:00:00Z',
      Status__c: 'Confirmed'
    });

    await deleteRecords(ctx, 'Booking__c', [id]);
    const freed = await availability(ctx, {
      resource: 'Wellington_Suite',
      from: at('2028-05-01T00:00:00Z'),
      to: at('2028-05-02T00:00:00Z')
    });
    expect(freed.available).toBe(true);

    await undeleteRecords(ctx, 'Booking__c', [id]);
    const retaken = await availability(ctx, {
      resource: 'Wellington_Suite',
      from: at('2028-05-01T00:00:00Z'),
      to: at('2028-05-02T00:00:00Z')
    });
    expect(retaken.available).toBe(false);
  });

  it('refuses a booking with no resource or no dates', async () => {
    const ctx = context();
    await expect(
      insertRecord(ctx, 'Booking__c', { Name: 'No resource', Starts__c: '2028-06-01T00:00:00Z', Ends__c: '2028-06-02T00:00:00Z' })
    ).rejects.toThrow(/needs a resource/);
    await expect(
      insertRecord(ctx, 'Booking__c', { Name: 'No dates', Resource__c: 'Boardroom' })
    ).rejects.toThrow(/needs a start/);
  });

  it('leaves objects without a booking config alone', async () => {
    const ctx = context();
    const id = await insertRecord(ctx, 'Contact', { LastName: 'Unbooked' });
    expect(id).toBeTruthy();
  });
});

// -------------------------------------------------------------- concurrency

describe('two staff booking at once', () => {
  it('lets exactly one win the last exclusive slot', async () => {
    const ctx = context();
    const attempt = (recordId: string) =>
      reserve(context(), {
        resource: 'Wellington_Suite',
        objectApi: 'Booking__c',
        recordId,
        startsAt: at('2029-01-01T00:00:00Z'),
        endsAt: at('2029-01-03T00:00:00Z')
      });

    const results = await Promise.allSettled([attempt('000000000000000700'), attempt('000000000000000701')]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    void ctx;
  });

  it('lets exactly one win the last place in a pool', async () => {
    const ctx = context();
    await defineResource(ctx, {
      apiName: 'Last_Table',
      label: 'Last Table',
      kind: 'Cover',
      mode: 'pool',
      capacity: 1,
      grain: 'day'
    });
    const attempt = (recordId: string) =>
      reserve(context(), {
        resource: 'Last_Table',
        objectApi: 'Booking__c',
        recordId,
        startsAt: at('2029-02-01T00:00:00Z'),
        endsAt: at('2029-02-02T00:00:00Z')
      });

    const results = await Promise.allSettled([attempt('000000000000000800'), attempt('000000000000000801')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ resources

describe('resource definitions', () => {
  it('lists what is bookable, by kind', async () => {
    const bedrooms = await listResources(context(), 'Bedroom');
    expect(bedrooms.map((r) => r.apiName).sort()).toEqual(['King_Room', 'Wellington_Suite']);
  });

  it('refuses a capacity on an exclusive resource', async () => {
    await expect(
      defineResource(context(), { apiName: 'Nonsense', mode: 'exclusive', capacity: 5 })
    ).rejects.toThrow(/capacity is 1/);
  });

  it('refuses a booking of an unknown or inactive resource', async () => {
    const ctx = context();
    await expect(
      reserve(ctx, {
        resource: 'No_Such_Room',
        objectApi: 'Booking__c',
        recordId: '000000000000000900',
        startsAt: at('2029-03-01T00:00:00Z'),
        endsAt: at('2029-03-02T00:00:00Z')
      })
    ).rejects.toThrow(/no bookable resource/);

    await defineResource(ctx, { apiName: 'Closed_Room', mode: 'exclusive', active: false });
    await expect(
      reserve(ctx, {
        resource: 'Closed_Room',
        objectApi: 'Booking__c',
        recordId: '000000000000000901',
        startsAt: at('2029-03-01T00:00:00Z'),
        endsAt: at('2029-03-02T00:00:00Z')
      })
    ).rejects.toThrow(/not currently bookable/);
  });

  it('refuses a booking that ends before it starts', async () => {
    await expect(
      reserve(context(), {
        resource: 'Boardroom',
        objectApi: 'Booking__c',
        recordId: '000000000000000902',
        startsAt: at('2029-04-01T12:00:00Z'),
        endsAt: at('2029-04-01T09:00:00Z')
      })
    ).rejects.toThrow(/must end after it starts/);
  });

  it('releases everything a record holds in one call', async () => {
    const ctx = context();
    await reserve(ctx, {
      resource: 'Boardroom',
      objectApi: 'Booking__c',
      recordId: '000000000000000903',
      startsAt: at('2029-05-01T09:00:00Z'),
      endsAt: at('2029-05-01T10:00:00Z')
    });
    const released = await ctx.tenant((c) => releaseForRecord(c, '000000000000000903'));
    expect(released).toBe(1);
  });
});
