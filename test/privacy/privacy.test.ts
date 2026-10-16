import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { totpCode } from '../../src/auth/totp.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import {
  checkoutQuotes,
  checkoutSessions,
  dashboardSessions,
  dashboardUsers,
  debits,
  mandates,
  operatorAudit,
  paymentCases,
  paymentEvents,
  payments,
  paymentTracking,
  webhookOutbox,
} from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { REDACTED } from '../../src/privacy/service.js';
import { MockPsp } from '../../src/psp/mock.js';
import { enqueueWebhook } from '../../src/webhooks/outbox.js';
import { freshDb, ist, rs, seedMandate, seedMerchant } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';
const DAY = 86_400_000;
const VPA = 'asha@okhdfc';
const PHONE = '9876543210';

describe('privacy: retention and erasure', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;

  beforeEach(async () => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep });
    app = buildApp(ctx);
  });

  const ago = (days: number) => new Date(clock.now().getTime() - days * DAY);
  const raw = async (q: ReturnType<typeof sql>) => ((await ctx.db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;

  async function payment(merchantId: string, o: { state?: 'PENDING' | 'SUCCEEDED' | 'FAILED'; daysAgo?: number; vpa?: string } = {}) {
    const id = newId('pay');
    const at = ago(o.daysAgo ?? 0);
    await ctx.db.insert(payments).values({
      id, merchantId, amountPaise: rs(100), payerVpa: o.vpa ?? VPA, customerAction: { type: 'UPI_COLLECT', vpa: o.vpa ?? VPA },
      idempotencyKey: id, state: o.state ?? 'SUCCEEDED', createdAt: at, updatedAt: at,
    });
    return id;
  }
  async function session(merchantId: string, o: { daysAgo: number; status?: 'OPEN' | 'PAID' | 'EXPIRED' }) {
    const at = ago(o.daysAgo);
    const quoteId = newId('quo');
    await ctx.db.insert(checkoutQuotes).values({ id: quoteId, merchantId, amountPaise: rs(100), ruleSetId: 'r', quote: {}, createdAt: at });
    const id = newId('cks');
    await ctx.db.insert(checkoutSessions).values({
      id, merchantId, quoteId, amountPaise: rs(100), customerPhone: PHONE, customerVpa: VPA, status: o.status ?? 'PAID',
      expiresAt: new Date(at.getTime() + 3600_000), createdAt: at, updatedAt: at,
    });
    return id;
  }
  async function debit(merchantId: string, mandateId: string, o: { daysAgo: number; state?: 'SCHEDULED' | 'SUCCEEDED' }) {
    const at = ago(o.daysAgo);
    await ctx.db.insert(debits).values({
      id: newId('dbt'), merchantId, mandateId, amountPaise: 100, idempotencyKey: newId('txn'), state: o.state ?? 'SUCCEEDED', requestedAt: at,
      requestedInPeak: false, scheduledAt: at, maxAttempts: 3, createdAt: at, updatedAt: at,
    });
  }
  const row = async <T>(q: Promise<T[]>) => (await q)[0]!;

  describe('retention (purgeExpired)', () => {
    it('redacts finished payments and checkout sessions only after the retention period', async () => {
      const m = await seedMerchant(ctx.db);
      const old = await payment(m.id, { daysAgo: 181 });
      const recent = await payment(m.id, { daysAgo: 179 });
      const pending = await payment(m.id, { daysAgo: 400, state: 'PENDING' });
      const disputed = await payment(m.id, { daysAgo: 400, state: 'FAILED' });
      const trk = newId('trk');
      await ctx.db.insert(paymentTracking).values({ id: trk, merchantId: m.id, subjectType: 'COLLECT', subjectId: disputed, customerDebit: 'DEBITED', verificationStatus: 'RESOLVED', reversalStatus: 'NONE' } as typeof paymentTracking.$inferInsert);
      await ctx.db.insert(paymentCases).values({ id: newId('cas'), merchantId: m.id, subjectType: 'COLLECT', subjectId: disputed, trackingId: trk, reason: 'DEBITED_NOT_CAPTURED', status: 'INVESTIGATING', openedAt: ago(390) });
      const oldSession = await session(m.id, { daysAgo: 200 });
      const recentSession = await session(m.id, { daysAgo: 10 });

      const counts = await ctx.privacy.purgeExpired();
      expect(counts).toMatchObject({ payments: 1, checkoutSessions: 1 });

      const p = async (id: string) => row(ctx.db.select().from(payments).where(eq(payments.id, id)));
      expect(await p(old)).toMatchObject({ payerVpa: null, customerAction: null, state: 'SUCCEEDED', amountPaise: rs(100) });
      for (const id of [recent, pending, disputed]) expect((await p(id)).payerVpa).toBe(VPA);
      const s = async (id: string) => row(ctx.db.select().from(checkoutSessions).where(eq(checkoutSessions.id, id)));
      expect(await s(oldSession)).toMatchObject({ customerPhone: null, customerVpa: null });
      expect(await s(recentSession)).toMatchObject({ customerPhone: PHONE, customerVpa: VPA });
    });

    it('keeps active mandates and revoked ones with recent debits; redacts revoked mandates long idle', async () => {
      const m = await seedMerchant(ctx.db);
      const active = await seedMandate(ctx.db, m.id, { customerVpa: VPA, createdAt: ago(500) });
      const idle = await seedMandate(ctx.db, m.id, { customerVpa: VPA, status: 'REVOKED', createdAt: ago(500) });
      await debit(m.id, idle.id, { daysAgo: 300 });
      const busy = await seedMandate(ctx.db, m.id, { customerVpa: VPA, status: 'REVOKED', createdAt: ago(500) });
      await debit(m.id, busy.id, { daysAgo: 20 });
      await debit(m.id, active.id, { daysAgo: 300 });

      expect((await ctx.privacy.purgeExpired()).mandates).toBe(1);
      const vpa = async (id: string) => (await row(ctx.db.select().from(mandates).where(eq(mandates.id, id)))).customerVpa;
      expect(await vpa(idle.id)).toBe(REDACTED);
      expect(await vpa(active.id)).toBe(VPA);
      expect(await vpa(busy.id)).toBe(VPA);
      // Idempotent.
      expect((await ctx.privacy.purgeExpired()).mandates).toBe(0);
    });

    it('deletes delivered and dead webhook log rows after 30 days, and expired sessions; writes one audit entry', async () => {
      const m = await seedMerchant(ctx.db);
      const hook = async (o: { deliveredDaysAgo?: number; deadDaysAgo?: number; createdDaysAgo: number }) => {
        const id = newId('whk');
        await ctx.db.insert(webhookOutbox).values({
          id, merchantId: m.id, event: 'payment.succeeded', payload: { payerVpa: VPA }, nextAttemptAt: ago(o.createdDaysAgo), createdAt: ago(o.createdDaysAgo),
          deliveredAt: o.deliveredDaysAgo === undefined ? null : ago(o.deliveredDaysAgo), deadAt: o.deadDaysAgo === undefined ? null : ago(o.deadDaysAgo),
        });
        return id;
      };
      const oldDelivered = await hook({ createdDaysAgo: 40, deliveredDaysAgo: 31 });
      const oldDead = await hook({ createdDaysAgo: 40, deadDaysAgo: 31 });
      const recent = await hook({ createdDaysAgo: 29, deliveredDaysAgo: 29 });
      const stillTrying = await hook({ createdDaysAgo: 40 });

      const user = newId('usr');
      await ctx.db.insert(dashboardUsers).values({ id: user, merchantId: m.id, email: 'a@b.c', name: 'A', passwordHash: 'x', role: 'ADMIN' });
      await ctx.db.insert(dashboardSessions).values({ id: newId('ses'), userId: user, tokenHash: 'old', createdAt: ago(10), lastSeenAt: ago(10), expiresAt: ago(9) });
      await ctx.db.insert(dashboardSessions).values({ id: newId('ses'), userId: user, tokenHash: 'live', createdAt: ago(0), lastSeenAt: ago(0), expiresAt: new Date(clock.now().getTime() + 3600_000) });

      const counts = await ctx.privacy.purgeExpired();
      expect(counts).toMatchObject({ webhookDeliveries: 2, sessions: 1 });
      const left = (await ctx.db.select({ id: webhookOutbox.id }).from(webhookOutbox)).map((r) => r.id).sort();
      expect(left).toEqual([recent, stillTrying].sort());
      expect(left).not.toContain(oldDelivered);
      expect(left).not.toContain(oldDead);
      expect((await ctx.db.select().from(dashboardSessions)).map((s) => s.tokenHash)).toEqual(['live']);

      const audit = await ctx.db.select().from(operatorAudit).where(eq(operatorAudit.action, 'DATA_RETENTION_PURGED'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ operatorId: null, details: expect.objectContaining({ webhookDeliveries: 2 }) });
    });

    it('runs from the worker at most once a day', async () => {
      const m = await seedMerchant(ctx.db);
      await payment(m.id, { daysAgo: 200 });
      expect(await ctx.privacy.runDue()).toMatchObject({ payments: 1 });
      await payment(m.id, { daysAgo: 200 });
      expect(await ctx.privacy.runDue()).toBeNull();
      clock.advance(DAY);
      expect(await ctx.privacy.runDue()).toMatchObject({ payments: 1 });
    });
  });

  describe('erasure', () => {
    let keyA: string;
    let keyB: string;
    let merchantA: string;
    let merchantB: string;

    beforeEach(async () => {
      const make = async (name: string) =>
        (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name } })).json();
      const a = await make('A');
      const b = await make('B');
      [keyA, keyB, merchantA, merchantB] = [a.apiKey, b.apiKey, a.merchant.id, b.merchant.id];
    });

    const erase = (key: string, payload: object) => app.inject({ method: 'POST', url: '/v1/privacy/erasure', headers: { authorization: `Bearer ${key}` }, payload });

    it("erases one customer's data for the requesting merchant only, including webhook payloads", async () => {
      for (const id of [merchantA, merchantB]) {
        await seedMandate(ctx.db, id, { customerVpa: 'Asha@OKHDFC' });
        await payment(id);
        await session(id, { daysAgo: 1 });
        await enqueueWebhook(ctx.db, { merchantId: id, event: 'payment.succeeded', payload: { id: 'pay_x', payerVpa: VPA, nested: { customerAction: { type: 'UPI_COLLECT', vpa: VPA } } }, now: clock.now() });
      }
      const other = await payment(merchantA, { vpa: 'someone@ybl' });

      const res = await erase(keyA, { vpa: ' asha@okhdfc ', phone: '+91 98765 43210' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ mandates: 1, payments: 1, checkoutSessions: 1, webhookDeliveries: 1 });

      const forMerchant = async (id: string) => ({
        mandates: (await ctx.db.select().from(mandates).where(eq(mandates.merchantId, id))).map((r) => r.customerVpa),
        payments: (await ctx.db.select().from(payments).where(eq(payments.merchantId, id))).map((r) => r.payerVpa),
        sessions: (await ctx.db.select().from(checkoutSessions).where(eq(checkoutSessions.merchantId, id))).map((r) => [r.customerPhone, r.customerVpa]),
        hooks: JSON.stringify((await ctx.db.select().from(webhookOutbox).where(eq(webhookOutbox.merchantId, id))).map((r) => r.payload)),
      });
      const a = await forMerchant(merchantA);
      expect(a.mandates).toEqual([REDACTED]);
      expect(a.payments.sort()).toEqual([null, 'someone@ybl'].sort());
      expect(a.sessions).toEqual([[null, null]]);
      expect(a.hooks).not.toContain('asha');
      expect(a.hooks).toContain('pay_x');
      const b = await forMerchant(merchantB);
      expect(b.mandates).toEqual(['Asha@OKHDFC']);
      expect(b.payments).toEqual([VPA]);
      expect(b.sessions).toEqual([[PHONE, VPA]]);
      expect(b.hooks).toContain(VPA);
      expect((await ctx.db.select().from(payments).where(eq(payments.id, other)))[0]!.payerVpa).toBe('someone@ybl');

      // Audited without the identifiers themselves.
      const events = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.type, 'DATA_ERASED'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ merchantId: merchantA, actorType: 'API_KEY', data: { mandates: 1, payments: 1, checkoutSessions: 1, webhookDeliveries: 1 } });
      expect(JSON.stringify(events[0])).not.toMatch(/asha|98765/i);
    });

    it('needs a VPA or a phone number', async () => {
      expect((await erase(keyA, {})).statusCode).toBe(400);
      expect((await erase(keyB, { vpa: 'not a vpa' })).statusCode).toBe(400);
    });

    it('lets Merchantflo operators erase on a merchant’s behalf (not viewers), audited with the reason', async () => {
      await payment(merchantA);
      const signIn = async (role: 'OPERATOR' | 'VIEWER') => {
        const email = `${role.toLowerCase()}@merchantflo.in`;
        const { password, otpauthUri } = await ctx.operators.create({ email, name: role, role }, null);
        const secret = new URL(otpauthUri).searchParams.get('secret')!;
        const res = await app.inject({ method: 'POST', url: '/ops/api/login', headers: { 'x-ops-request': '1' }, payload: { email, password, code: totpCode(secret, clock.now()) } });
        return `mf_ops=${res.cookies.find((c) => c.name === 'mf_ops')!.value}`;
      };
      const opsErase = (cookie: string, payload: object) =>
        app.inject({ method: 'POST', url: '/ops/api/privacy/erasure', headers: { cookie, 'x-ops-request': '1' }, payload });

      expect((await opsErase(await signIn('VIEWER'), { merchantId: merchantA, vpa: VPA, reason: 'DPDP request #12' })).statusCode).toBe(403);
      const operator = await signIn('OPERATOR');
      const res = await opsErase(operator, { merchantId: merchantA, vpa: VPA, reason: 'DPDP request #12' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ payments: 1 });
      const [audit] = await ctx.db.select().from(operatorAudit).where(eq(operatorAudit.action, 'DATA_ERASED'));
      expect(audit).toMatchObject({ target: merchantA, details: expect.objectContaining({ reason: 'DPDP request #12', payments: 1 }) });
      expect(JSON.stringify(audit)).not.toContain('asha');
      expect((await opsErase(operator, { merchantId: 'mer_nope', vpa: VPA, reason: 'x' })).statusCode).toBe(404);
    });
  });

  it('seals webhook payloads at rest', async () => {
    const m = await seedMerchant(ctx.db);
    await enqueueWebhook(ctx.db, { merchantId: m.id, event: 'payment.succeeded', payload: { payerVpa: VPA }, now: clock.now() });
    const [r] = await raw(sql`select payload::text as p from webhook_outbox`);
    expect(String(r!.p)).not.toContain('asha');
    expect((await ctx.db.select().from(webhookOutbox))[0]!.payload).toEqual({ payerVpa: VPA });
  });
});
