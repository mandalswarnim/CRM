import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { config } from '../../config.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';
import { sobjectRoutes } from './sobjects.js';
import { queryRoutes } from './query.js';
import { compositeRoutes } from './composite.js';
import { approvalRoutes } from './approvals.js';

/**
 * The root of the Salesforce-compatible REST surface. Only the version list and /limits live here
 * for now; sobjects, describe, query and composite land with the API task.
 */
export function dataRoutes(db: Db): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json(
      config.apiVersions.map((v) => ({
        label: `Meridian ${v}`,
        url: `/services/data/v${v}`,
        version: v
      }))
    );
  });

  r.use('/v:version', (req, _res, next) => {
    const version = String(req.params.version);
    if (!config.apiVersions.includes(version)) {
      return next(Errors.notFound(`The requested API version (${version}) is not supported.`));
    }
    next();
  });

  r.use('/v:version/sobjects', sobjectRoutes(db));
  r.use('/v:version', queryRoutes(db));
  r.use('/v:version', compositeRoutes(db));
  r.use('/v:version', approvalRoutes(db));

  r.get(
    '/v:version/recent',
    authenticate(db),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const rows = await ctx.tenant((c) =>
        c.query<{ record_id: string; object_api: string }>(
          `SELECT record_id, object_api FROM recent_item WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT 20`,
          [ctx.userId]
        )
      );
      res.json(
        rows.rows.map((row) => ({
          Id: row.record_id,
          attributes: {
            type: row.object_api,
            url: `/services/data/v${req.params.version}/sobjects/${row.object_api}/${row.record_id}`
          }
        }))
      );
    })
  );

  r.get(
    '/v:version/limits',
    authenticate(db),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const used = await db.query<{ requests: string }>(
        `SELECT requests FROM sys.api_usage WHERE org_id = $1 AND day = current_date`,
        [ctx.orgId]
      );
      const requests = Number(used.rows[0]?.requests ?? 0);
      const body = ctx.limits.toLimitsBody();
      body.DailyApiRequests = {
        Max: config.dailyApiRequests,
        Remaining: Math.max(0, config.dailyApiRequests - requests)
      };
      res.setHeader('Sforce-Limit-Info', `api-usage=${requests}/${config.dailyApiRequests}`);
      res.json(body);
    })
  );

  return r;
}
