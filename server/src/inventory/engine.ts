import type { DbClient } from '../db/index.js';
import type { RequestContext } from '../runtime/context.js';
import { Errors } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { encodeSpan, stepFor, stepsBetween, type Grain } from './span.js';
import type {
  Allocation,
  AvailabilityRequest,
  AvailabilityResult,
  AvailabilitySlot,
  BookingWindow,
  ReserveRequest,
  Resource,
  ResourceInput
} from './types.js';

/** Allocations get their own key prefix so an id says what it is, as Salesforce ids do. */
const RESOURCE_PREFIX = '0Rs';
const ALLOCATION_PREFIX = '0Al';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

/* ------------------------------------------------------------------ resources */

function rowToResource(row: any): Resource {
  return {
    id: row.id,
    apiName: row.api_name,
    label: row.label,
    kind: row.kind,
    mode: row.mode,
    capacity: Number(row.capacity),
    overbook: Number(row.overbook),
    grain: row.grain as Grain,
    ordinal: BigInt(row.ordinal),
    windows: row.windows ? (typeof row.windows === 'string' ? JSON.parse(row.windows) : row.windows) : null,
    active: row.active,
    attributes: row.attributes
      ? typeof row.attributes === 'string'
        ? JSON.parse(row.attributes)
        : row.attributes
      : {}
  };
}

/** Define a bookable resource. The ordinal is assigned here and never changes. */
export async function defineResource(ctx: RequestContext, input: ResourceInput): Promise<Resource> {
  const mode = input.mode ?? 'exclusive';
  if (mode === 'exclusive' && (input.capacity ?? 1) !== 1) {
    throw Errors.invalidOperation(
      `resource '${input.apiName}' is exclusive, so its capacity is 1; use mode 'pool' for capacity`
    );
  }
  const id = generateId(RESOURCE_PREFIX);
  return ctx.tenant(async (c) => {
    const res = await c.query(
      `INSERT INTO inventory_resource
         (id, api_name, label, kind, mode, capacity, overbook, grain, ordinal, windows, active, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, nextval('inventory_resource_ordinal_seq'), $9,$10,$11)
       RETURNING *`,
      [
        id,
        input.apiName,
        input.label ?? input.apiName,
        input.kind ?? 'Resource',
        mode,
        input.capacity ?? 1,
        input.overbook ?? 0,
        input.grain ?? 'minute',
        input.windows ? JSON.stringify(input.windows) : null,
        input.active ?? true,
        JSON.stringify(input.attributes ?? {})
      ]
    );
    return rowToResource(res.rows[0]);
  });
}

export async function getResource(c: DbClient, apiNameOrId: string): Promise<Resource | null> {
  const res = await c.query(`SELECT * FROM inventory_resource WHERE api_name = $1 OR id = $1`, [apiNameOrId]);
  return res.rows.length ? rowToResource(res.rows[0]) : null;
}

export async function listResources(ctx: RequestContext, kind?: string): Promise<Resource[]> {
  return ctx.tenant(async (c) => {
    const res = kind
      ? await c.query(`SELECT * FROM inventory_resource WHERE kind = $1 ORDER BY label`, [kind])
      : await c.query(`SELECT * FROM inventory_resource ORDER BY kind, label`);
    return res.rows.map(rowToResource);
  });
}

async function requireResource(c: DbClient, key: string): Promise<Resource> {
  const resource = await getResource(c, key);
  if (!resource) throw Errors.invalidOperation(`there is no bookable resource called '${key}'`);
  if (!resource.active) throw Errors.invalidOperation(`'${resource.label}' is not currently bookable`);
  return resource;
}

/* -------------------------------------------------------------- opening hours */

function minutesOfDay(at: Date): number {
  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

function parseClock(text: string, what: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw Errors.invalidOperation(`'${text}' is not a ${what} time; expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Opening hours are booking windows, and they are data on the resource.
 *
 * The Members' Bar opens Tuesday to Friday and the Calcutta Light Horse Bar closes on Sundays;
 * neither fact belongs in engine code, so a reservation outside a resource's declared windows is
 * refused here by consulting the rows.
 */
function assertWithinWindows(resource: Resource, starts: Date, ends: Date): void {
  const windows = resource.windows;
  if (!windows?.length) return;

  // A window must contain the whole booking, so check each day the booking touches.
  for (let cursor = new Date(starts); cursor < ends; cursor = new Date(cursor.getTime() + MS_PER_MINUTE * 60)) {
    const day = cursor.getUTCDay();
    const today = windows.filter((w) => w.day === day);
    if (!today.length) {
      throw Errors.invalidOperation(`'${resource.label}' is not open on that day`);
    }
    const at = minutesOfDay(cursor);
    const open = today.some((w: BookingWindow) => at >= parseClock(w.from, 'window start') && at < parseClock(w.to, 'window end'));
    if (!open) throw Errors.invalidOperation(`'${resource.label}' is not open at that time`);
  }
}

/* ------------------------------------------------------------------- reserving */

/**
 * Release holds that have lapsed on this resource.
 *
 * Called on the reserve path rather than left to the sweeper, so correctness never depends on how
 * recently the scheduled job ran — an expired hold must not keep a room off sale.
 */
async function releaseExpiredHolds(c: DbClient, resourceId: string): Promise<void> {
  const expired = await c.query<{ id: string; resource_id: string; quantity: number; starts_at: string; ends_at: string }>(
    `UPDATE inventory_allocation
        SET status = 'Released'
      WHERE resource_id = $1 AND status = 'Held' AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING id, resource_id, quantity, starts_at, ends_at`,
    [resourceId]
  );
  for (const row of expired.rows) await releaseUsage(c, row);
}

/** Give a pool booking's units back to every step it occupied. */
async function releaseUsage(
  c: DbClient,
  row: { resource_id: string; quantity: number; starts_at: string; ends_at: string }
): Promise<void> {
  const resource = await getResource(c, row.resource_id);
  if (!resource || resource.mode !== 'pool') return;
  const steps = stepsBetween(new Date(row.starts_at), new Date(row.ends_at), resource.grain);
  for (const step of steps) {
    await c.query(
      `UPDATE inventory_usage SET taken = GREATEST(0, taken - $3) WHERE resource_id = $1 AND step = $2`,
      [row.resource_id, step, row.quantity]
    );
  }
}

/**
 * Claim capacity, or fail.
 *
 * Two mechanisms, both enforced by the database rather than by a read-then-write the application
 * could lose a race on:
 *
 *   exclusive — the range exclusion constraint on `inventory_allocation`
 *   pool      — a per-step counter with `CHECK (taken <= ceiling)`
 *
 * Either way, two staff booking the last table at the same moment cannot both succeed: one of
 * them gets a constraint violation, which surfaces as a clear "not available".
 */
export async function reserve(ctx: RequestContext, request: ReserveRequest): Promise<Allocation> {
  return ctx.tenant(async (c) => reserveOn(c, ctx, request));
}

export async function reserveOn(c: DbClient, ctx: RequestContext, request: ReserveRequest): Promise<Allocation> {
  const resource = await requireResource(c, request.resource);
  const { startsAt, endsAt } = request;
  if (!(endsAt > startsAt)) {
    throw Errors.invalidOperation('a booking must end after it starts');
  }
  assertWithinWindows(resource, startsAt, endsAt);
  await releaseExpiredHolds(c, resource.id);

  const quantity = request.quantity ?? 1;
  if (resource.mode === 'exclusive' && quantity !== 1) {
    throw Errors.invalidOperation(`'${resource.label}' is booked whole; a quantity of ${quantity} is not meaningful`);
  }

  const id = generateId(ALLOCATION_PREFIX);
  const span = encodeSpan(resource.ordinal, startsAt, endsAt, resource.grain);
  const status = request.holdMinutes ? 'Held' : 'Reserved';
  const expiresAt = request.holdMinutes ? new Date(Date.now() + request.holdMinutes * MS_PER_MINUTE) : null;

  if (resource.mode === 'pool') {
    const ceiling = resource.capacity + resource.overbook;
    for (const step of stepsBetween(startsAt, endsAt, resource.grain)) {
      try {
        await c.query(
          `INSERT INTO inventory_usage (resource_id, step, taken, ceiling)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (resource_id, step)
             DO UPDATE SET taken = inventory_usage.taken + $3, ceiling = $4`,
          [resource.id, step, quantity, ceiling]
        );
      } catch (err: any) {
        if (isCapacityViolation(err)) throw notAvailable(resource.label, startsAt);
        throw err;
      }
    }
  }

  try {
    const res = await c.query(
      `INSERT INTO inventory_allocation
         (id, resource_id, object_api, record_id, quantity, starts_at, ends_at, span, exclusive, status, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::int8range,$9,$10,$11,$12)
       RETURNING *`,
      [
        id,
        resource.id,
        request.objectApi,
        request.recordId,
        quantity,
        startsAt.toISOString(),
        endsAt.toISOString(),
        span,
        resource.mode === 'exclusive',
        status,
        expiresAt?.toISOString() ?? null,
        ctx.userId
      ]
    );
    return rowToAllocation(res.rows[0]);
  } catch (err: any) {
    if (isExclusionViolation(err)) throw notAvailable(resource.label, startsAt);
    throw err;
  }
}

function notAvailable(label: string, at: Date) {
  return Errors.invalidOperation(`'${label}' is not available at ${at.toISOString()}`);
}

/** 23P01 exclusion_violation — someone else holds the overlapping span. */
function isExclusionViolation(err: any): boolean {
  return err?.code === '23P01' || /exclusion constraint/i.test(String(err?.message ?? ''));
}

/** 23514 check_violation on the capacity ceiling. */
function isCapacityViolation(err: any): boolean {
  return err?.code === '23514' || /check constraint/i.test(String(err?.message ?? ''));
}

function rowToAllocation(row: any): Allocation {
  return {
    id: row.id,
    resourceId: row.resource_id,
    objectApi: row.object_api,
    recordId: row.record_id,
    quantity: Number(row.quantity),
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null
  };
}

/** Turn a hold into a firm booking. */
export async function confirm(ctx: RequestContext, allocationId: string): Promise<Allocation> {
  return ctx.tenant(async (c) => {
    const res = await c.query(
      `UPDATE inventory_allocation
          SET status = 'Reserved', expires_at = NULL
        WHERE id = $1 AND status = 'Held'
        RETURNING *`,
      [allocationId]
    );
    if (!res.rows.length) {
      throw Errors.invalidOperation(`hold ${allocationId} has already lapsed or been confirmed`);
    }
    return rowToAllocation(res.rows[0]);
  });
}

/** Give the capacity back. Releasing something already released is not an error. */
export async function release(ctx: RequestContext, allocationId: string): Promise<void> {
  await ctx.tenant((c) => releaseOn(c, allocationId));
}

export async function releaseOn(c: DbClient, allocationId: string): Promise<void> {
  const res = await c.query(
    `UPDATE inventory_allocation SET status = 'Released'
      WHERE id = $1 AND status <> 'Released'
      RETURNING resource_id, quantity, starts_at, ends_at`,
    [allocationId]
  );
  for (const row of res.rows) await releaseUsage(c, row as any);
}

/** Release everything a record holds — what cancelling or deleting a booking does. */
export async function releaseForRecord(c: DbClient, recordId: string): Promise<number> {
  const res = await c.query(
    `UPDATE inventory_allocation SET status = 'Released'
      WHERE record_id = $1 AND status <> 'Released'
      RETURNING id, resource_id, quantity, starts_at, ends_at`,
    [recordId]
  );
  for (const row of res.rows) await releaseUsage(c, row as any);
  return res.rows.length;
}

export async function allocationsForRecord(c: DbClient, recordId: string): Promise<Allocation[]> {
  const res = await c.query(
    `SELECT * FROM inventory_allocation WHERE record_id = $1 AND status <> 'Released' ORDER BY starts_at`,
    [recordId]
  );
  return res.rows.map(rowToAllocation);
}

/* ---------------------------------------------------------------- availability */

/**
 * What is free, step by step.
 *
 * Expired holds are ignored rather than counted, so the answer matches what a reservation would
 * actually do — an availability screen that disagrees with the booking button is worse than none.
 */
export async function availability(ctx: RequestContext, request: AvailabilityRequest): Promise<AvailabilityResult> {
  return ctx.tenant(async (c) => {
    const resource = await requireResource(c, request.resource);
    const quantity = request.quantity ?? 1;
    const steps = stepsBetween(request.from, request.to, resource.grain);
    const slots: AvailabilitySlot[] = [];

    if (resource.mode === 'pool') {
      const rows = await c.query<{ step: string; taken: number }>(
        `SELECT step, taken FROM inventory_usage WHERE resource_id = $1 AND step = ANY($2)`,
        [resource.id, steps]
      );
      const taken = new Map(rows.rows.map((r) => [Number(r.step), Number(r.taken)]));
      const ceiling = resource.capacity + resource.overbook;
      for (const step of steps) {
        const used = taken.get(step) ?? 0;
        slots.push({ at: stepToIso(step, resource.grain), capacity: ceiling, taken: used, remaining: ceiling - used });
      }
    } else {
      const rows = await c.query<{ starts_at: string; ends_at: string }>(
        `SELECT starts_at, ends_at FROM inventory_allocation
          WHERE resource_id = $1
            AND status <> 'Released'
            AND NOT (status = 'Held' AND expires_at IS NOT NULL AND expires_at <= now())
            AND starts_at < $3 AND ends_at > $2`,
        [resource.id, request.from.toISOString(), request.to.toISOString()]
      );
      const busy = new Set<number>();
      for (const row of rows.rows) {
        for (const s of stepsBetween(new Date(row.starts_at), new Date(row.ends_at), resource.grain)) busy.add(s);
      }
      for (const step of steps) {
        const used = busy.has(step) ? 1 : 0;
        slots.push({ at: stepToIso(step, resource.grain), capacity: 1, taken: used, remaining: 1 - used });
      }
    }

    return {
      resource: resource.apiName,
      mode: resource.mode,
      grain: resource.grain,
      available: slots.every((s) => s.remaining >= quantity),
      slots
    };
  });
}

function stepToIso(step: number, grain: Grain): string {
  const minutes = grain === 'day' ? step * MINUTES_PER_DAY : step;
  return new Date(minutes * MS_PER_MINUTE).toISOString();
}

/**
 * Sweep lapsed holds across every resource. Housekeeping only — the reserve path releases the
 * holds it would otherwise trip over, so this exists to keep availability honest between bookings.
 */
export async function expireHolds(ctx: RequestContext): Promise<number> {
  return ctx.tenant(async (c) => {
    const res = await c.query(
      `UPDATE inventory_allocation SET status = 'Released'
        WHERE status = 'Held' AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id, resource_id, quantity, starts_at, ends_at`
    );
    for (const row of res.rows) await releaseUsage(c, row as any);
    return res.rows.length;
  });
}

export { stepFor };
