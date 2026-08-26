import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { parseSearchTerm, runSosl, runSoslQuery, suggest } from '../../sosl/index.js';
import type { SoslQuery } from '../../sosl/index.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';

/**
 * The search surface, in Salesforce's shapes:
 *
 *   GET /search/?q=FIND {term} RETURNING …   full SOSL
 *   GET /parameterizedSearch/?q=…&sobject=…  the same search without SOSL syntax
 *   GET /search/suggestions?q=…              typeahead for the header search box
 *
 * `/search/suggestions` is declared before `/search` so the literal path is not swallowed by the
 * SOSL handler.
 */
export function searchRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  r.get(
    '/search/suggestions',
    asyncHandler(async (req, res) => {
      const term = req.query.q;
      if (typeof term !== 'string' || !term.trim()) {
        throw Errors.malformedSearch("The 'q' parameter is required");
      }
      const objects = typeof req.query.sobject === 'string' ? req.query.sobject.split(',').map((s) => s.trim()) : [];
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const results = await suggest(ctxOf(req), term, { objects, limit });
      res.json({
        autoSuggestResults: results.map((s) => ({
          attributes: { type: s.objectApi, url: `/services/data/v${req.params.version}/sobjects/${s.objectApi}/${s.id}` },
          Id: s.id,
          Name: s.title,
          Icon: s.icon
        }))
      });
    })
  );

  r.get(
    '/search',
    asyncHandler(async (req, res) => {
      const sosl = req.query.q;
      if (typeof sosl !== 'string' || !sosl.trim()) {
        throw Errors.malformedSearch("The 'q' parameter is required and must contain a SOSL search");
      }
      res.json(await runSosl(ctxOf(req), sosl));
    })
  );

  /**
   * Parameterized search: the same engine driven by query parameters instead of SOSL text, for
   * callers that would otherwise have to build a SOSL string by hand.
   */
  r.get(
    '/parameterizedSearch',
    asyncHandler(async (req, res) => {
      const term = req.query.q;
      if (typeof term !== 'string' || !term.trim()) {
        throw Errors.malformedSearch("The 'q' parameter is required");
      }

      const group = String(req.query.in ?? 'ALL').toUpperCase();
      if (!['ALL', 'NAME', 'EMAIL', 'PHONE', 'SIDEBAR'].includes(group)) {
        throw Errors.malformedSearch(`'${group}' is not a search group`);
      }

      const objects = typeof req.query.sobject === 'string' ? req.query.sobject.split(',').map((s) => s.trim()) : [];
      const fields = typeof req.query.fields === 'string' ? req.query.fields : 'Id';

      const query: SoslQuery = {
        find: parseSearchTerm(term),
        group: group as SoslQuery['group'],
        returning: objects.map((objectApi) => ({
          objectApi,
          query: { select: fields.split(',').map((f) => ({ kind: 'field' as const, path: [f.trim()] })), from: objectApi }
        })),
        withClauses: [],
        limit: req.query.limit ? Number(req.query.limit) : undefined
      };

      res.json(await runSoslQuery(ctxOf(req), query));
    })
  );

  return r;
}
