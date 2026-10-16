import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { MockPsp } from '../../src/psp/mock.js';
import { privacyBackfill } from '../../src/privacy/backfill.js';
import { configureFieldEncryption, isSealedField } from '../../src/security/fields.js';
import { SecretBox } from '../../src/security/secrets.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';
const key32 = () => randomBytes(32).toString('base64');

describe('personal field encryption', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let key: string;

  async function setup(opts: { secrets?: SecretBox; encryptPersonalFields?: boolean } = {}) {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: [new MockPsp('pspA')], adminToken: ADMIN, clock, sleep: clock.sleep, router: { random: () => 0.5 }, ...opts });
    app = buildApp(ctx);
    key = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Shop' } })).json().apiKey;
  }

  // Encryption settings are process-wide: put the default back for the next test.
  afterEach(() => configureFieldEncryption({ box: SecretBox.development(), enabled: true }));

  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
  const raw = async (q: ReturnType<typeof sql>) => ((await ctx.db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;

  describe('enabled (default)', () => {
    beforeEach(() => setup());

    it('seals VPAs, phones and the customer action at rest, and the API reads them back in the clear', async () => {
      const mandate = (await call('POST', '/v1/mandates', { mandateRef: 'UMN-1', customerVpa: 'asha@okhdfc', maxAmountPaise: rs(500) })).json();
      const collect = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okaxis', idempotencyKey: 'c1' })).json();
      const qr = (await call('POST', '/v1/payments', { amountPaise: rs(100), idempotencyKey: 'q1', channel: 'UPI_QR' })).json();
      const session = (await call('POST', '/v1/checkout/sessions', { amountPaise: rs(2500), customer: { phone: '9876543210', vpa: 'meera@ybl' } })).json();

      const [m] = await raw(sql`select customer_vpa from mandates where id = ${mandate.id}`);
      const [c] = await raw(sql`select payer_vpa from payments where id = ${collect.id}`);
      const [q] = await raw(sql`select customer_action::text as action from payments where id = ${qr.id}`);
      const [s] = await raw(sql`select customer_phone, customer_vpa from checkout_sessions where id = ${session.id}`);
      for (const v of [m!.customer_vpa, c!.payer_vpa, s!.customer_phone, s!.customer_vpa]) expect(isSealedField(String(v))).toBe(true);
      expect(String(q!.action)).not.toContain('upi://');
      expect(JSON.stringify([m, c, q, s])).not.toMatch(/asha|ravi|meera|9876543210/);

      expect((await call('GET', `/v1/mandates/${mandate.id}`)).json().customerVpa).toBe('asha@okhdfc');
      expect((await call('GET', `/v1/payments/${collect.id}`)).json().payerVpa).toBe('ravi@okaxis');
      expect((await call('GET', `/v1/payments/${qr.id}`)).json().customerAction).toMatchObject({ type: 'UPI_QR', qrData: expect.stringMatching(/^upi:\/\/pay/) });
      expect(qr.customerAction).toMatchObject({ type: 'UPI_QR' }); // .returning() decrypts too
    });

    it('treats an idempotent replay as the same request (compares decrypted values)', async () => {
      const first = await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okaxis', idempotencyKey: 'same' });
      const again = await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okaxis', idempotencyKey: 'same' });
      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(first.json().id);
      const qr = { amountPaise: rs(100), idempotencyKey: 'qr', channel: 'UPI_QR' };
      const q1 = (await call('POST', '/v1/payments', qr)).json();
      const q2 = await call('POST', '/v1/payments', qr);
      expect(q2.statusCode).toBe(200);
      expect(q2.json().customerAction).toEqual(q1.customerAction);
      // A different VPA under the same key is still a conflict.
      expect((await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'other@okaxis', idempotencyKey: 'same' })).statusCode).toBe(409);
    });

    it('still reads rows written before encryption, and the backfill seals them', async () => {
      // A pending QR payment: its customer action is shown, so the read path is visible through the API.
      const p = (await call('POST', '/v1/payments', { amountPaise: rs(100), idempotencyKey: 'old', channel: 'UPI_QR' })).json();
      await ctx.db.execute(sql`update payments set payer_vpa = 'legacy@okicici', customer_action = '{"type":"UPI_QR","qrData":"upi://pay?pa=x"}'::jsonb where id = ${p.id}`);
      const before = (await call('GET', `/v1/payments/${p.id}`)).json();
      expect(before.payerVpa).toBe('legacy@okicici');
      expect(before.customerAction).toEqual({ type: 'UPI_QR', qrData: 'upi://pay?pa=x' });

      const counts = await privacyBackfill(ctx.db, { batchSize: 1 });
      expect(counts.payments).toBeGreaterThanOrEqual(1);
      const [row] = await raw(sql`select payer_vpa, customer_action::text as action from payments where id = ${p.id}`);
      expect(isSealedField(String(row!.payer_vpa))).toBe(true);
      expect(String(row!.action)).not.toContain('upi://');
      expect((await call('GET', `/v1/payments/${p.id}`)).json()).toMatchObject({ payerVpa: 'legacy@okicici', customerAction: { qrData: 'upi://pay?pa=x' } });
      // Nothing left to do on a second run.
      expect(await privacyBackfill(ctx.db, { batchSize: 1 })).toEqual({ mandates: 0, payments: 0, checkoutSessions: 0, webhookDeliveries: 0 });
    });
  });

  it('writes plaintext when turned off, and still reads sealed rows', async () => {
    await setup();
    const sealed = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okaxis', idempotencyKey: 's' })).json();
    configureFieldEncryption({ box: SecretBox.development(), enabled: false });
    const plain = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'neha@okaxis', idempotencyKey: 'p' })).json();
    const [row] = await raw(sql`select payer_vpa from payments where id = ${plain.id}`);
    expect(row!.payer_vpa).toBe('neha@okaxis');
    expect((await call('GET', `/v1/payments/${sealed.id}`)).json().payerVpa).toBe('ravi@okaxis');
  });

  it('survives key rotation: old rows open with the old key, the backfill re-seals them with the new one', async () => {
    const k1 = `k1:${key32()}`;
    const credentials = SecretBox.fromKeyRing(k1);
    await setup({ secrets: credentials });
    const p = (await call('POST', '/v1/payments', { amountPaise: rs(100), payerVpa: 'ravi@okaxis', idempotencyKey: 'r' })).json();
    const [before] = await raw(sql`select payer_vpa from payments where id = ${p.id}`);

    configureFieldEncryption({ box: SecretBox.fromKeyRing(`k2:${key32()},${k1}`), enabled: true });
    expect((await call('GET', `/v1/payments/${p.id}`)).json().payerVpa).toBe('ravi@okaxis');
    expect((await privacyBackfill(ctx.db)).payments).toBe(1);
    const [after] = await raw(sql`select payer_vpa from payments where id = ${p.id}`);
    expect(after!.payer_vpa).not.toBe(before!.payer_vpa);
    expect(String(after!.payer_vpa)).toMatch(/^pf1\.k2\./);

    // Fields use a key derived from the credentials key, never the credentials key itself.
    expect(() => credentials.open(String(before!.payer_vpa).slice(4))).toThrow();
  });
});
