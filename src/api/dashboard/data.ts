import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { recordEvents } from '../../events/record.js';
import { CASE_REASON_LABELS, CASE_RESOLUTION_LABELS, CASE_STATUS_LABELS, COMPLAINT_STATUS_LABELS } from '../../events/timeline.js';
import { MERCHANT_STATUS_LABELS, type MerchantStatus } from '../../tracking/derive.js';
import type { CaseStatus, SubjectType } from '../../tracking/types.js';
import { positivePaise } from '../schemas.js';
import { actorOf, OPERATOR_ROLES, requireRole, userOf } from './plugin.js';

const typeParam = z.enum(['collect', 'autopay']).transform((t) => t.toUpperCase() as SubjectType);
const subjectParams = z.object({ type: typeParam, id: z.string().min(1).max(100) });
const caseParams = z.object({ id: z.string().min(1).max(100) });
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const listQuery = z.object({
  status: z.enum(Object.keys(MERCHANT_STATUS_LABELS) as [MerchantStatus, ...MerchantStatus[]]).optional(),
  type: typeParam.optional(),
  psp: z.string().max(100).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  minAmount: z.coerce.number().pipe(positivePaise).optional(),
  maxAmount: z.coerce.number().pipe(positivePaise).optional(),
  orderId: z.string().max(200).optional(),
  paymentId: z.string().max(100).optional(),
  upiRrn: z.string().regex(/^\d{12}$/, 'UPI reference must be 12 digits').optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const CASE_STATUS_KEYS = Object.keys(CASE_STATUS_LABELS) as [CaseStatus, ...CaseStatus[]];
const caseListQuery = z.object({
  status: z.enum(CASE_STATUS_KEYS).optional(),
  before: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const complaintBody = z.object({ reason: z.enum(['DEBITED_NOT_CREDITED', 'STATUS_UNKNOWN']).default('DEBITED_NOT_CREDITED') });
const noteBody = z.object({ body: z.string().trim().min(1).max(4000) });
const closeBody = z.object({ note: z.string().trim().min(1).max(4000) });

const canOperate = (req: FastifyRequest) => OPERATOR_ROLES.includes(userOf(req).role);

/** Overview, payments, search, detail/timeline, Dispute Desk — all reads go through services. */
export const dashboardDataRoutes = (ctx: AppContext) => async (app: FastifyInstance) => {
  const audit = (req: FastifyRequest, type: 'PAYMENT_VIEWED' | 'CASE_VIEWED', subject: { type: SubjectType; id: string }, caseId?: string) =>
    recordEvents(ctx.db, { merchantId: userOf(req).merchantId, subjectType: subject.type, subjectId: subject.id, ...(caseId ? { caseId } : {}), actor: actorOf(req), now: ctx.clock.now() }, [
      { type },
    ]);

  app.get('/dashboard/api/overview', async (req) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    return ctx.queries.overview(userOf(req).merchantId, { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) });
  });

  app.get('/dashboard/api/payments', async (req) => {
    const q = listQuery.parse(req.query);
    const { cursor, limit, psp, minAmount, maxAmount, ...rest } = q;
    return ctx.queries.list(
      userOf(req).merchantId,
      {
        ...rest,
        ...(psp ? { pspId: psp } : {}),
        ...(minAmount !== undefined ? { minAmountPaise: minAmount } : {}),
        ...(maxAmount !== undefined ? { maxAmountPaise: maxAmount } : {}),
      },
      { ...(cursor ? { cursor } : {}), limit },
    );
  });

  app.get('/dashboard/api/payments/search', async (req) => {
    const { q } = z.object({ q: z.string().max(200) }).parse(req.query);
    return { matches: await ctx.queries.search(userOf(req).merchantId, q) };
  });

  app.get('/dashboard/api/payments/:type/:id', async (req) => {
    const { type, id } = subjectParams.parse(req.params);
    const detail = await ctx.queries.detail(userOf(req).merchantId, type, id, { canOperate: canOperate(req) });
    await audit(req, 'PAYMENT_VIEWED', { type, id });
    return detail;
  });

  app.get('/dashboard/api/payments/:type/:id/timeline', async (req) => {
    const { type, id } = subjectParams.parse(req.params);
    await ctx.queries.rowFor(userOf(req).merchantId, type, id); // 404 for other merchants' payments
    return { events: await ctx.queries.timeline(userOf(req).merchantId, type, id) };
  });

  app.post('/dashboard/api/payments/:type/:id/recheck', async (req) => {
    const u = requireRole(req, OPERATOR_ROLES);
    const { type, id } = subjectParams.parse(req.params);
    await ctx.disputes.recheck(u.merchantId, { type, id }, actorOf(req));
    return ctx.queries.detail(u.merchantId, type, id, { canOperate: true });
  });

  app.post('/dashboard/api/payments/:type/:id/complaints', async (req, reply) => {
    const u = requireRole(req, OPERATOR_ROLES);
    const { type, id } = subjectParams.parse(req.params);
    const { reason } = complaintBody.parse(req.body ?? {});
    const c = await ctx.disputes.raiseComplaint(u.merchantId, { type, id }, actorOf(req), reason);
    return reply.status(201).send(await caseDetail(c.id, req, false));
  });

  app.get('/dashboard/api/cases', async (req) => {
    const q = caseListQuery.parse(req.query);
    const merchantId = userOf(req).merchantId;
    const r = await ctx.disputes.listCases(merchantId, { ...(q.status ? { status: q.status } : {}), ...(q.before ? { before: q.before } : {}), limit: q.limit });
    const rows = await Promise.all(
      r.data.map(async (c) => {
        const p = await ctx.queries.rowFor(merchantId, c.subjectType, c.subjectId);
        return {
          id: c.id,
          status: c.status,
          statusLabel: CASE_STATUS_LABELS[c.status],
          reason: c.reason,
          reasonLabel: CASE_REASON_LABELS[c.reason],
          openedAt: c.openedAt,
          resolvedAt: c.resolvedAt,
          payment: { type: p.type, id: p.id, orderId: p.orderId, upiRrn: p.upiRrn, amountPaise: p.amountPaise, pspId: p.pspId, merchantStatusLabel: p.merchantStatusLabel },
        };
      }),
    );
    return { data: rows, counts: r.counts, nextBefore: r.nextBefore };
  });

  async function caseDetail(caseId: string, req: FastifyRequest, auditView: boolean) {
    const merchantId = userOf(req).merchantId;
    const { case: c, complaints, notes, userNames } = await ctx.disputes.getCase(merchantId, caseId);
    const payment = await ctx.queries.detail(merchantId, c.subjectType, c.subjectId, { canOperate: canOperate(req) });
    const timeline = await ctx.queries.timeline(merchantId, c.subjectType, c.subjectId);
    if (auditView) await audit(req, 'CASE_VIEWED', { type: c.subjectType, id: c.subjectId }, c.id);
    const actions = [...payment.actionsAllowed];
    if (canOperate(req)) actions.push('ADD_NOTE');
    if (canOperate(req) && c.status === 'NEEDS_ACTION') actions.push('CLOSE');
    return {
      id: c.id,
      status: c.status,
      statusLabel: CASE_STATUS_LABELS[c.status],
      reason: c.reason,
      reasonLabel: CASE_REASON_LABELS[c.reason],
      resolution: c.resolution,
      resolutionLabel: c.resolution ? CASE_RESOLUTION_LABELS[c.resolution] : null,
      openedAt: c.openedAt,
      resolvedAt: c.resolvedAt,
      actionRequired: c.status === 'NEEDS_ACTION',
      payment,
      complaints: complaints.map((x) => ({
        id: x.id,
        mode: x.mode,
        modeLabel: x.mode === 'MOCK' ? 'Simulated — mock PSP, not sent to NPCI' : 'Submitted to PSP',
        reference: x.pspComplaintRef,
        status: x.status,
        statusLabel: COMPLAINT_STATUS_LABELS[x.status],
        raisedBy: x.raisedByUserId ? (userNames.get(x.raisedByUserId) ?? 'Dashboard user') : null,
        raisedAt: x.raisedAt,
        lastStatusAt: x.lastStatusAt,
      })),
      notes: notes.map((n) => ({ id: n.id, body: n.body, author: userNames.get(n.authorUserId) ?? 'Dashboard user', createdAt: n.createdAt })),
      timeline,
      actionsAllowed: actions,
    };
  }

  app.get('/dashboard/api/cases/:id', async (req) => caseDetail(caseParams.parse(req.params).id, req, true));

  app.post('/dashboard/api/cases/:id/notes', async (req, reply) => {
    const u = requireRole(req, OPERATOR_ROLES);
    const { id } = caseParams.parse(req.params);
    const { body } = noteBody.parse(req.body);
    await ctx.disputes.addNote(u.merchantId, id, actorOf(req), body);
    return reply.status(201).send(await caseDetail(id, req, false));
  });

  app.post('/dashboard/api/cases/:id/recheck', async (req) => {
    const u = requireRole(req, OPERATOR_ROLES);
    const { id } = caseParams.parse(req.params);
    const { case: c } = await ctx.disputes.getCase(u.merchantId, id);
    await ctx.disputes.recheck(u.merchantId, { type: c.subjectType, id: c.subjectId }, actorOf(req));
    return caseDetail(id, req, false);
  });

  app.post('/dashboard/api/cases/:id/close', async (req) => {
    const u = requireRole(req, OPERATOR_ROLES);
    const { id } = caseParams.parse(req.params);
    const { note } = closeBody.parse(req.body);
    await ctx.disputes.closeCase(u.merchantId, id, actorOf(req), note);
    return caseDetail(id, req, false);
  });
};
