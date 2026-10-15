import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { connectionAdapterFactory } from '../../src/psp/connections.js';
import { buildAdapters } from '../../src/psp/factory.js';
import { MockPsp, TEST_SCENARIOS } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const collect = (psp: MockPsp, txnRef: string, amountPaise: number) => psp.collect({ txnRef, channel: 'UPI_COLLECT', payerVpa: 'a@ok', amountPaise });
const at = (paise: number) => rs(2500) + paise;

describe('MockPsp test-mode scenarios (magic amounts)', () => {
  const psp = () => new MockPsp('pspA', { scenarios: true });

  it('is off unless asked for: a magic amount is an ordinary success', async () => {
    const plain = new MockPsp('pspA');
    expect(plain.scenarios).toBe(false);
    expect((await collect(plain, 'p-1', at(51))).kind).toBe('SUCCESS');
  });

  it('leaves other amounts alone', async () => {
    const p = psp();
    for (const amount of [rs(2500), at(50), at(58), at(99)]) expect((await collect(p, `p${amount}-1`, amount)).kind).toBe('SUCCESS');
  });

  it('.51 — the customer’s bank declines (not charged, never retried)', async () => {
    const p = psp();
    expect(await collect(p, 'p-1', at(51))).toEqual({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
    expect(await p.inquire('p-1')).toMatchObject({ found: true, outcome: 'FAILED', customerDebit: 'NOT_DEBITED' });
  });

  it('.52 — bank down at the first PSP tried only, so failover recovers it', async () => {
    const p = psp();
    expect(await collect(p, 'p-1', at(52))).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' });
    expect((await collect(p, 'p-2', at(52))).kind).toBe('SUCCESS');
  });

  it('.53 — a timeout that went through: the status check finds the success', async () => {
    const p = psp();
    expect(await collect(p, 'p-1', at(53))).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    expect((await p.status('p-1')).kind).toBe('SUCCESS');
  });

  it('.54 — a timeout that never reached the bank: nothing to find, not charged', async () => {
    const p = psp();
    expect(await collect(p, 'p-1', at(54))).toEqual({ kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' });
    expect(await p.status('p-1')).toEqual({ kind: 'NOT_FOUND' });
    expect(await p.inquire('p-1')).toEqual({ found: false });
  });

  it('.55 — failed but debited; the bank then reverses it', async () => {
    const p = psp();
    expect((await collect(p, 'p-1', at(55))).kind).toBe('TECHNICAL_DECLINE');
    const steps = [await p.inquire('p-1'), await p.inquire('p-1'), await p.inquire('p-1'), await p.inquire('p-1')];
    expect(steps.map((s) => s.found && [s.customerDebit, s.capture, s.reversal.status])).toEqual([
      ['DEBITED', 'NOT_CAPTURED', 'NONE'],
      ['DEBITED', 'NOT_CAPTURED', 'INITIATED'],
      ['DEBITED', 'NOT_CAPTURED', 'COMPLETED'],
      ['DEBITED', 'NOT_CAPTURED', 'COMPLETED'],
    ]);
  });

  it('.56 — failed but debited, and no reversal ever shows up', async () => {
    const p = psp();
    await collect(p, 'p-1', at(56));
    for (let i = 0; i < 3; i++) expect(await p.inquire('p-1')).toMatchObject({ found: true, customerDebit: 'DEBITED', capture: 'NOT_CAPTURED', reversal: { status: 'NONE' } });
  });

  it('.57 — reported failed, then captured after all (late success)', async () => {
    const p = psp();
    expect((await collect(p, 'p-1', at(57))).kind).toBe('TECHNICAL_DECLINE');
    expect(await p.inquire('p-1')).toMatchObject({ found: true, outcome: 'SUCCESS', customerDebit: 'DEBITED', capture: 'CAPTURED' });
  });

  it('applies to AutoPay executions too', async () => {
    const p = psp();
    const r = await p.executeMandate({ txnRef: 'd-1', mandateRef: 'UMN-1', amountPaise: at(51), noticeRef: 'n-1' });
    expect(r).toEqual({ kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' });
  });

  it('documents every scenario it implements', () => {
    expect(TEST_SCENARIOS.map((s) => s.paise)).toEqual([51, 52, 53, 54, 55, 56, 57]);
    for (const s of TEST_SCENARIOS) expect(s.description.length).toBeGreaterThan(10);
  });
});

describe('where scenarios are switched on', () => {
  const env = {
    NODE_ENV: 'development' as const, MOCK_PSPS: 'pspA', MOCK_PSP_RATES: undefined, ALLOW_MOCK_PSPS: 'false' as const,
    CASHFREE_CLIENT_ID: undefined, CASHFREE_CLIENT_SECRET: undefined, CASHFREE_ENV: 'sandbox' as const, CASHFREE_TIMEOUT_MS: 10_000,
  };

  it('on for test-mode (mock) merchant connections', () => {
    const adapter = connectionAdapterFactory()({ id: 'conn_1', provider: 'mock', environment: 'sandbox' } as never, null);
    expect((adapter as MockPsp).scenarios).toBe(true);
  });

  it('on for shared mocks outside production, off for a deliberate production demo', () => {
    expect((buildAdapters(env)[0] as MockPsp).scenarios).toBe(true);
    expect((buildAdapters({ ...env, NODE_ENV: 'production', ALLOW_MOCK_PSPS: 'true' }, { warn: () => {} })[0] as MockPsp).scenarios).toBe(false);
  });
});

describe('scenarios through the API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let clock: FakeClock;
  let key: string;

  const setup = async (pspIds: string[]) => {
    const { db } = await freshDb();
    clock = new FakeClock(ist('2026-10-15T14:00:00'));
    ctx = buildContext({ db, adapters: pspIds.map((id) => new MockPsp(id, { scenarios: true })), adminToken: 'admin-token-000000', clock, sleep: clock.sleep, router: { random: () => 0.5 } });
    app = buildApp(ctx);
    key = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: 'Bearer admin-token-000000' }, payload: { name: 'Shop' } })).json().apiKey;
  };
  const pay = (amountPaise: number, ref: string) =>
    app.inject({ method: 'POST', url: '/v1/payments', headers: { authorization: `Bearer ${key}` }, payload: { amountPaise, payerVpa: 'ravi@okicici', idempotencyKey: ref } });

  it('.51 fails the payment; .52 is recovered by failover; an ordinary amount succeeds', async () => {
    await setup(['pspA', 'pspB']);
    expect((await pay(at(51), 'o1')).json()).toMatchObject({ state: 'FAILED' });
    expect((await pay(at(52), 'o2')).json()).toMatchObject({ state: 'SUCCEEDED', pspId: 'pspB' });
    expect((await pay(rs(2500), 'o3')).json()).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('.54–.57 play out through the status poller as documented', async () => {
    await setup(['pspA']);
    const ids = await Promise.all([54, 55, 56, 57].map(async (paise) => (await pay(at(paise), `o${paise}`)).json().id as string));
    const statuses = async () =>
      Promise.all(ids.map(async (id) => (await app.inject({ method: 'GET', url: `/v1/payments/${id}`, headers: { authorization: `Bearer ${key}` } })).json().merchantStatus as string));
    const seen: string[][] = [await statuses()];
    for (let i = 0; i < 6; i++) {
      clock.advance(60_000);
      await ctx.poller.runOnce();
      seen.push(await statuses());
    }
    expect(seen[0]).toEqual(['VERIFYING', 'VERIFYING', 'VERIFYING', 'VERIFYING']);
    expect(seen.map((row) => row[1])).toContain('REVERSAL_IN_PROGRESS');
    expect(seen.at(-1)).toEqual(['FAILED', 'REVERSED', 'DEBITED_NOT_CAPTURED', 'CAPTURED_AFTER_FAILURE']);
  });

  it('.52 with a single PSP fails (nothing to fail over to); .53 is confirmed by the status check after the timeout', async () => {
    await setup(['pspA']);
    expect((await pay(at(52), 'o1')).json()).toMatchObject({ state: 'FAILED' });
    const p = (await pay(at(53), 'o2')).json();
    expect(p.state).toBe('SUCCEEDED'); // the router's own status check after the timeout finds it
  });
});
