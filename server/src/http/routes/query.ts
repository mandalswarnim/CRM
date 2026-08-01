import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { runQuery, runQueryMore } from '../../soql/index.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';

/** /query, /queryAll and the queryMore locator endpoint. */
export function queryRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  const run = (includeDeleted: boolean) =>
    asyncHandler(async (req, res) => {
      const soql = req.query.q;
      if (typeof soql !== 'string' || !soql.trim()) {
        throw Errors.malformedQuery("The 'q' parameter is required and must contain a SOQL query");
      }
      const ctx = ctxOf(req);
      const result = await runQuery(ctx, soql, {
        includeDeleted,
        apiVersion: String(req.params.version),
        batchSize: req.query.batchSize ? Number(req.query.batchSize) : undefined
      });
      res.json(result);
    });

  r.get('/query', run(false));
  r.get('/queryAll', run(true));

  r.get(
    '/query/:locator',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const result = await runQueryMore(ctx, String(req.params.locator), { apiVersion: String(req.params.version) });
      res.json(result);
    })
  );

  r.get(
    '/queryAll/:locator',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const result = await runQueryMore(ctx, String(req.params.locator), {
        apiVersion: String(req.params.version),
        includeDeleted: true
      });
      res.json(result);
    })
  );

  return r;
}
