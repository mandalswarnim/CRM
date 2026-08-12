import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { approve, historyForRecord, pendingForUser, recall, reject, submitForApproval } from '../../approval/index.js';
import { asyncHandler, authenticate, ctxOf } from '../middleware.js';
import { Errors } from '../../util/errors.js';

/**
 * The approvals surface, shaped like Salesforce's /process/approvals plus a convenience inbox the
 * UI needs. Requests are a list so a batch of records can be submitted in one call.
 */
export function approvalRoutes(db: Db): Router {
  const r = Router({ mergeParams: true });
  r.use(authenticate(db));

  r.post(
    '/process/approvals',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const requests: any[] = req.body?.requests ?? [];
      if (!Array.isArray(requests) || !requests.length) {
        throw Errors.invalidBatch('requests must be a non-empty array');
      }

      const results = [];
      for (const request of requests) {
        try {
          const action = String(request.actionType ?? 'Submit');
          if (action === 'Submit') {
            const outcome = await submitForApproval(ctx, String(request.objectType ?? ''), String(request.contextId ?? ''), {
              processApiName: request.processDefinitionNameOrId,
              comment: request.comments
            });
            results.push({
              success: true,
              instanceStatus: outcome.status,
              actorIds: [],
              newWorkitemIds: outcome.workItemIds,
              errors: []
            });
          } else if (action === 'Approve' || action === 'Reject') {
            const fn = action === 'Approve' ? approve : reject;
            const outcome = await fn(ctx, String(request.workitemId ?? ''), { comment: request.comments });
            results.push({
              success: true,
              instanceStatus: outcome.status,
              actorIds: [ctx.userId],
              newWorkitemIds: outcome.workItemIds,
              errors: []
            });
          } else if (action === 'Removed') {
            const outcome = await recall(ctx, String(request.contextId ?? ''), { comment: request.comments });
            results.push({ success: true, instanceStatus: outcome.status, actorIds: [ctx.userId], newWorkitemIds: [], errors: [] });
          } else {
            throw Errors.invalidOperation(`Unsupported approval action: ${action}`);
          }
        } catch (err: any) {
          results.push({
            success: false,
            instanceStatus: null,
            actorIds: [],
            newWorkitemIds: [],
            errors: err?.toBody ? err.toBody() : [{ message: String(err?.message ?? err), errorCode: 'UNKNOWN_EXCEPTION', fields: [] }]
          });
        }
      }
      res.json(results);
    })
  );

  r.get(
    '/process/approvals',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      res.json({ approvals: await pendingForUser(ctx) });
    })
  );

  r.get(
    '/process/approvals/:recordId',
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      res.json({ history: await historyForRecord(ctx, String(req.params.recordId)) });
    })
  );

  return r;
}
