import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { availability, confirm, listResources, release, reserve } from '../../inventory/index.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';

/**
 * The booking surface. Salesforce has no equivalent, so these are Meridian's own shapes — kept in
 * the same idiom as the rest of the API: plural nouns, `SfError` bodies, ISO instants.
 */
export function inventoryRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  const date = (value: unknown, what: string): Date => {
    if (typeof value !== 'string' || !value.trim()) {
      throw Errors.invalidOperation(`'${what}' is required and must be an ISO date-time`);
    }
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw Errors.invalidOperation(`'${value}' is not a valid ${what}`);
    return at;
  };

  r.get(
    '/inventory/resources',
    asyncHandler(async (req, res) => {
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const resources = await listResources(ctxOf(req), kind);
      res.json({
        resources: resources.map((resource) => ({
          apiName: resource.apiName,
          label: resource.label,
          kind: resource.kind,
          mode: resource.mode,
          capacity: resource.capacity,
          grain: resource.grain,
          windows: resource.windows,
          active: resource.active
        }))
      });
    })
  );

  /** What is free, step by step — what a booking screen asks before it offers a slot. */
  r.get(
    '/inventory/availability',
    asyncHandler(async (req, res) => {
      const resource = req.query.resource;
      if (typeof resource !== 'string' || !resource.trim()) {
        throw Errors.invalidOperation("The 'resource' parameter is required");
      }
      const result = await availability(ctxOf(req), {
        resource,
        from: date(req.query.from, 'from'),
        to: date(req.query.to, 'to'),
        quantity: req.query.quantity ? Number(req.query.quantity) : undefined
      });
      res.json(result);
    })
  );

  /**
   * Reserve directly, without a booking record.
   *
   * Most bookings should come from a `Booking__c` save, which allocates through the DML hooks —
   * this is for holds taken while a member is still deciding, before any record exists.
   */
  r.post(
    '/inventory/reservations',
    asyncHandler(async (req, res) => {
      const body = req.body ?? {};
      const allocation = await reserve(ctxOf(req), {
        resource: String(body.resource ?? ''),
        objectApi: String(body.objectApi ?? 'Booking__c'),
        recordId: String(body.recordId ?? ''),
        startsAt: date(body.startsAt, 'startsAt'),
        endsAt: date(body.endsAt, 'endsAt'),
        quantity: body.quantity ? Number(body.quantity) : undefined,
        holdMinutes: body.holdMinutes ? Number(body.holdMinutes) : undefined
      });
      res.status(201).json(allocation);
    })
  );

  r.post(
    '/inventory/reservations/:id/confirm',
    asyncHandler(async (req, res) => {
      res.json(await confirm(ctxOf(req), String(req.params.id)));
    })
  );

  r.delete(
    '/inventory/reservations/:id',
    asyncHandler(async (req, res) => {
      await release(ctxOf(req), String(req.params.id));
      res.status(204).end();
    })
  );

  return r;
}
