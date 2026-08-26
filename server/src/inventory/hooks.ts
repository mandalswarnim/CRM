import { registerDmlHooks, type DmlEvent, type DmlHooks } from '../dml/hooks.js';
import type { ObjectMeta } from '../metadata/types.js';
import { Errors } from '../util/errors.js';
import { allocationsForRecord, releaseForRecord, reserveOn } from './engine.js';
import type { BookingConfig } from './types.js';

/**
 * Booking records drive allocation through the ordinary DML hooks.
 *
 * Nothing here knows what a bedroom is. An object declares `booking` in its metadata — which field
 * names the resource, which holds the start, which the end — and this reserves against whatever
 * those fields say. `Booking__c` stays an ordinary metadata object, which is the whole point.
 */

function bookingConfig(object: ObjectMeta): BookingConfig | null {
  return object.booking ?? null;
}

function readDate(record: Record<string, any>, field: string, what: string): Date {
  const raw = record[field];
  if (raw === null || raw === undefined || raw === '') {
    throw Errors.invalidOperation(`a booking needs ${what} (${field})`);
  }
  const at = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(at.getTime())) throw Errors.invalidOperation(`'${raw}' is not a valid ${what}`);
  return at;
}

function isCancelled(config: BookingConfig, record: Record<string, any>): boolean {
  if (!config.statusField) return false;
  const values = config.cancelledValues ?? ['Cancelled'];
  return values.some((v) => String(record[config.statusField!] ?? '').toLowerCase() === v.toLowerCase());
}

/** The fields that, when changed, mean the existing allocation no longer describes the booking. */
function allocationChanged(config: BookingConfig, before: Record<string, any> | null, after: Record<string, any>): boolean {
  if (!before) return true;
  const watched = [config.resourceField, config.startField, config.endField, config.quantityField, config.statusField]
    .filter(Boolean) as string[];
  return watched.some((f) => String(before[f] ?? '') !== String(after[f] ?? ''));
}

async function applyBooking(e: DmlEvent, config: BookingConfig): Promise<void> {
  for (const change of e.changes) {
    const after = change.after;

    // Deleted, or the record is gone: give the capacity back.
    if (!after) {
      await releaseForRecord(e.client, change.id);
      continue;
    }

    if (!allocationChanged(config, change.before, after)) continue;

    // Re-reserving from scratch is simpler than diffing, and the release happens in the same
    // transaction — so a booking that moves to an unavailable slot rolls back to where it was.
    await releaseForRecord(e.client, change.id);

    if (isCancelled(config, after)) continue;

    const resource = after[config.resourceField];
    if (resource === null || resource === undefined || resource === '') {
      throw Errors.invalidOperation(`a booking needs a resource (${config.resourceField})`);
    }

    const quantityRaw = config.quantityField ? after[config.quantityField] : 1;
    const quantity = quantityRaw === null || quantityRaw === undefined || quantityRaw === '' ? 1 : Number(quantityRaw);
    if (!Number.isFinite(quantity) || quantity < 1) {
      throw Errors.invalidOperation(`'${quantityRaw}' is not a valid number of places`);
    }

    await reserveOn(e.client, e.ctx, {
      resource: String(resource),
      objectApi: e.object.apiName,
      recordId: change.id,
      startsAt: readDate(after, config.startField, 'a start'),
      endsAt: readDate(after, config.endField, 'an end'),
      quantity,
      holdMinutes: config.holdMinutes
    });
  }
}

const inventoryHooks: DmlHooks = {
  name: 'inventory',

  /**
   * Allocation runs in `validate`, not `sideEffects`.
   *
   * Losing the race for the last room must abort the save, exactly as a validation rule does —
   * a booking record that exists without the capacity behind it is the bug this engine exists to
   * prevent. Running later would leave the record written and the guest without a room.
   */
  async validate(e: DmlEvent): Promise<void> {
    const config = bookingConfig(e.object);
    if (!config) return;
    if (e.operation !== 'insert' && e.operation !== 'update') return;
    await applyBooking(e, config);
  },

  /**
   * Delete and undelete never reach `validate` — the pipeline does not run that stage for them —
   * so they are handled here. A restored booking has to re-claim its capacity, which may since
   * have been sold; failing loudly is right, because the alternative is a booking with no room
   * behind it.
   */
  async afterSave(e: DmlEvent): Promise<void> {
    const config = bookingConfig(e.object);
    if (!config) return;
    if (e.operation !== 'delete' && e.operation !== 'undelete') return;
    await applyBooking(e, config);
  }
};

export function installInventory(): void {
  registerDmlHooks(inventoryHooks);
}

export { allocationsForRecord };
