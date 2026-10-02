import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { MockPsp } from '../../src/psp/mock.js';
import { HealthTracker } from '../../src/routing/health.js';
import { Router } from '../../src/routing/router.js';
import type { PspResult } from '../../src/psp/types.js';

const OK = (id = 'x'): PspResult => ({ kind: 'SUCCESS', pspTxnId: id });
const TIMEOUT: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'TIMEOUT' };
const BANK_DOWN: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'BANK_UNAVAILABLE' };
const NO_FUNDS: PspResult = { kind: 'BUSINESS_DECLINE', code: 'INSUFFICIENT_FUNDS' };

function setup(a: ConstructorParameters<typeof MockPsp>[1], b: ConstructorParameters<typeof MockPsp>[1] = {}) {
  const clock = new FakeClock('2026-10-15T08:00:00Z');
  const pspA = new MockPsp('pspA', a);
  const pspB = new MockPsp('pspB', b);
  const health = new HealthTracker({}, clock);
  const router = new Router([pspA, pspB], health, clock, clock.sleep, { random: () => 0.5 });
  const run = (candidates = ['pspA', 'pspB']) =>
    router.execute({ op: 'mandate', candidates, amountPaise: 49900, mandateRef: 'UMN1', baseRef: 'dbt_1' });
  return { clock, pspA, pspB, health, router, run };
}

describe('Router', () => {
  it('succeeds on the first healthy PSP', async () => {
    const { run, pspB } = setup({ script: [OK('a1')] });
    const out = await run();
    expect(out.result).toEqual(OK('a1'));
    expect(out.pspId).toBe('pspA');
    expect(out.hadTechnicalDecline).toBe(false);
    expect(pspB.calls).toHaveLength(0);
  });

  it('on timeout, checks status first and does NOT re-debit when the PSP actually succeeded', async () => {
    const { run, pspA, pspB } = setup({ script: [{ ...TIMEOUT, settleAs: OK('late') }] });
    const out = await run();
    expect(out.result).toEqual(OK('late'));
    expect(pspA.calls.map((c) => c.op)).toEqual(['execute', 'status']);
    expect(pspB.calls).toHaveLength(0);
    expect(out.hadTechnicalDecline).toBe(true);
  });

  it('waits 3-5s after a timeout before polling status', async () => {
    const { run, clock } = setup({ script: [{ ...TIMEOUT, settleAs: OK() }] });
    const t0 = clock.now().getTime();
    await run();
    const waited = clock.now().getTime() - t0;
    expect(waited).toBeGreaterThanOrEqual(3000);
    expect(waited).toBeLessThanOrEqual(5000);
  });

  it('on timeout with no record at the PSP, retries once on the same PSP with the same txnRef', async () => {
    const { run, pspA, pspB } = setup({ script: [TIMEOUT, OK('a2')] });
    const out = await run();
    expect(out.result).toEqual(OK('a2'));
    const executes = pspA.calls.filter((c) => c.op === 'execute');
    expect(executes).toHaveLength(2);
    expect(executes[0]!.txnRef).toBe(executes[1]!.txnRef);
    expect(pspB.calls).toHaveLength(0);
  });

  it('returns PENDING and stops when status is still pending (never retry an in-flight debit)', async () => {
    const { run, pspA, pspB } = setup({ script: [{ ...TIMEOUT, settleAs: { kind: 'PENDING' } }] });
    const out = await run();
    expect(out.result).toEqual({ kind: 'PENDING' });
    expect(out.pspId).toBe('pspA');
    expect(pspA.calls.filter((c) => c.op === 'execute')).toHaveLength(1);
    expect(pspB.calls).toHaveLength(0);
  });

  it('fails over to the next PSP with a fresh txnRef on bank unavailability', async () => {
    const { run, pspA, pspB } = setup({ script: [BANK_DOWN] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual(OK('b1'));
    expect(out.pspId).toBe('pspB');
    expect(pspB.calls[0]!.txnRef).not.toBe(pspA.calls[0]!.txnRef);
    expect(out.hadTechnicalDecline).toBe(true);
    expect(out.attempts).toHaveLength(2);
  });

  it('never retries or fails over a business decline', async () => {
    const { run, pspA, pspB } = setup({ script: [NO_FUNDS] }, { script: [OK()] });
    const out = await run();
    expect(out.result).toEqual(NO_FUNDS);
    expect(pspA.calls).toHaveLength(1);
    expect(pspB.calls).toHaveLength(0);
  });

  it('returns the last technical decline when every PSP fails', async () => {
    const { run } = setup({ script: [BANK_DOWN] }, { script: [TIMEOUT, TIMEOUT] });
    const out = await run();
    expect(out.result).toEqual(TIMEOUT);
    expect(out.hadTechnicalDecline).toBe(true);
  });

  it('only routes to the given candidates (non-portable mandate)', async () => {
    const { run, pspB } = setup({ script: [BANK_DOWN] }, { script: [OK()] });
    const out = await run(['pspA']);
    expect(out.result).toEqual(BANK_DOWN);
    expect(pspB.calls).toHaveLength(0);
  });

  it('prefers the healthier PSP once health data exists', async () => {
    const { run, health, pspB } = setup({ script: [] }, { script: [OK('b')] });
    for (let i = 0; i < 20; i++) health.record('pspA', BANK_DOWN);
    const out = await run();
    expect(out.pspId).toBe('pspB');
    expect(pspB.calls).toHaveLength(1);
  });

  it('stops attempting once the total time budget is spent', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const pspA = new MockPsp('pspA', { script: [TIMEOUT, TIMEOUT] });
    const pspB = new MockPsp('pspB', { script: [OK()] });
    const router = new Router([pspA, pspB], new HealthTracker({}, clock), clock, clock.sleep, {
      random: () => 0.5,
      maxTotalMs: 5000,
    });
    const out = await router.execute({ op: 'mandate', candidates: ['pspA', 'pspB'], amountPaise: 1, mandateRef: 'U', baseRef: 'd' });
    expect(out.result.kind).toBe('TECHNICAL_DECLINE');
    expect(pspB.calls).toHaveLength(0);
  });
});

describe('HealthTracker', () => {
  it('opens the circuit on a high technical-decline rate and half-opens after cooldown', () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const h = new HealthTracker({ minSamples: 10, openThreshold: 0.5, cooldownMs: 30_000 }, clock);
    for (let i = 0; i < 10; i++) h.record('pspA', BANK_DOWN);
    expect(h.state('pspA')).toBe('OPEN');
    expect(h.rank(['pspA', 'pspB'])).toEqual(['pspB', 'pspA']);
    clock.advance(30_000);
    expect(h.state('pspA')).toBe('HALF_OPEN');
    h.record('pspA', OK());
    expect(h.state('pspA')).toBe('CLOSED');
  });

  it('ignores business declines — they are not the PSP’s fault', () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const h = new HealthTracker({ minSamples: 5 }, clock);
    for (let i = 0; i < 20; i++) h.record('pspA', NO_FUNDS);
    expect(h.state('pspA')).toBe('CLOSED');
    expect(h.snapshot().find((s) => s.pspId === 'pspA')?.samples).toBe(0);
  });

  it('re-opens if the half-open probe fails', () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const h = new HealthTracker({ minSamples: 4, cooldownMs: 1000 }, clock);
    for (let i = 0; i < 4; i++) h.record('pspA', BANK_DOWN);
    clock.advance(1000);
    h.record('pspA', TIMEOUT);
    expect(h.state('pspA')).toBe('OPEN');
  });
});
