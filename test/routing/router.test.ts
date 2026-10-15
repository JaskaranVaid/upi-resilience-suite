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

  it('gives providers the context they need to look a transaction up (mandate + base payment)', async () => {
    const { pspA } = setup({ script: [TIMEOUT, OK('a2')] });
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const router = new Router([pspA], new HealthTracker({}, clock), clock, clock.sleep, { random: () => 0.5 });
    await router.execute({ op: 'mandate', candidates: ['pspA'], amountPaise: 1, mandateRef: 'UMN1', noticeRef: 'dbt_1', baseRef: 'dbt_1-a1' });
    expect(pspA.calls.find((c) => c.op === 'execute')!.noticeRef).toBe('dbt_1');
    expect(pspA.calls.find((c) => c.op === 'status')!.ctx).toEqual({ kind: 'MANDATE', mandateRef: 'UMN1', noticeRef: 'dbt_1' });

    const pspC = new MockPsp('pspC', { script: [TIMEOUT, OK()] });
    const r2 = new Router([pspC], new HealthTracker({}, clock), clock, clock.sleep, { random: () => 0.5 });
    await r2.execute({ op: 'collect', candidates: ['pspC'], amountPaise: 1, payerVpa: 'ab@ok', baseRef: 'pay_1' });
    expect(pspC.calls.find((c) => c.op === 'status')!.ctx).toEqual({ kind: 'COLLECT' });
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
    // execute at A, status at A (nothing live there), execute at B
    expect(out.attempts.map((a) => [a.pspId, a.op])).toEqual([['pspA', 'execute'], ['pspA', 'status'], ['pspB', 'execute']]);
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

describe('Router — collect failover (status check before failover)', () => {
  const PSP_ERROR: PspResult = { kind: 'TECHNICAL_DECLINE', code: 'PSP_ERROR' };

  function collectSetup(a: ConstructorParameters<typeof MockPsp>[1], b: ConstructorParameters<typeof MockPsp>[1] = {}, maxTotalMs?: number) {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const pspA = new MockPsp('pspA', { sleep: clock.sleep, ...a });
    const pspB = new MockPsp('pspB', { sleep: clock.sleep, ...b });
    const router = new Router([pspA, pspB], new HealthTracker({}, clock), clock, clock.sleep, {
      random: () => 0.5,
      ...(maxTotalMs ? { maxTotalMs } : {}),
    });
    const run = () => router.execute({ op: 'collect', candidates: ['pspA', 'pspB'], amountPaise: 2500, payerVpa: 'a@ok', baseRef: 'pay_1' });
    return { pspA, pspB, run };
  }

  it('returns PENDING instead of sending a second collect when the first PSP has a live request', async () => {
    const { run, pspA, pspB } = collectSetup({ script: [{ ...PSP_ERROR, settleAs: { kind: 'PENDING' } }] }, { script: [OK()] });
    const out = await run();
    expect(out.result).toEqual({ kind: 'PENDING' });
    expect(out.pspId).toBe('pspA');
    expect(pspA.calls.map((c) => c.op)).toEqual(['collect', 'status']);
    expect(pspB.calls).toHaveLength(0);
  });

  it('returns success without failover when the errored request actually succeeded', async () => {
    const { run, pspB } = collectSetup({ script: [{ ...PSP_ERROR, settleAs: OK('a-late') }] }, { script: [OK()] });
    const out = await run();
    expect(out.result).toEqual(OK('a-late'));
    expect(pspB.calls).toHaveLength(0);
  });

  it('fails over when the first PSP has no record of the request', async () => {
    const { run, pspA, pspB } = collectSetup({ script: [{ ...PSP_ERROR, settleAs: { kind: 'NOT_FOUND' } }] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual(OK('b1'));
    expect(pspA.calls.map((c) => c.op)).toEqual(['collect', 'status']);
    expect(out.pspId).toBe('pspB');
  });

  it('fails over when the first PSP reports the request as declined', async () => {
    const { run, pspB } = collectSetup({ script: [BANK_DOWN] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual(OK('b1'));
    expect(pspB.calls).toHaveLength(1);
  });

  it('fails over when the status check itself errors', async () => {
    const { run, pspA, pspB } = collectSetup({ script: [BANK_DOWN] }, { script: [OK('b1')] });
    pspA.status = async () => {
      throw new Error('connection reset');
    };
    const out = await run();
    expect(out.result).toEqual(OK('b1'));
    expect(pspB.calls).toHaveLength(1);
  });

  it('does not fail over a collect when the time budget is spent (cannot confirm safely)', async () => {
    const { run, pspA, pspB } = collectSetup({ script: [BANK_DOWN], latencyMs: 2000 }, { script: [OK()] }, 1000);
    const out = await run();
    expect(out.result).toEqual(BANK_DOWN);
    expect(pspA.calls.map((c) => c.op)).toEqual(['collect']);
    expect(pspB.calls).toHaveLength(0);
  });

});

describe('Router — mandate failover (status check before failover)', () => {
  it('does not debit again via another PSP when the errored execution actually went through', async () => {
    const { run, pspA, pspB } = setup({ script: [{ ...BANK_DOWN, settleAs: OK('a-late') }] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual(OK('a-late'));
    expect(pspA.calls.map((c) => c.op)).toEqual(['execute', 'status']);
    expect(pspB.calls).toHaveLength(0);
  });

  it('stops at PENDING when the first PSP still has the execution in flight', async () => {
    const { run, pspB } = setup({ script: [{ ...BANK_DOWN, settleAs: { kind: 'PENDING' } }] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual({ kind: 'PENDING' });
    expect(pspB.calls).toHaveLength(0);
  });

  it('fails over once the first PSP confirms it never debited', async () => {
    const { run, pspA } = setup({ script: [BANK_DOWN] }, { script: [OK('b1')] });
    const out = await run();
    expect(out.result).toEqual(OK('b1'));
    expect(out.pspId).toBe('pspB');
    expect(pspA.calls.map((c) => c.op)).toEqual(['execute', 'status']);
  });

  it('does not fail over when there is no time left to confirm', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const slow = new MockPsp('pspA', { script: [BANK_DOWN], latencyMs: 31_000, sleep: clock.sleep });
    const pspB = new MockPsp('pspB', { script: [OK('b1')] });
    const router = new Router([slow, pspB], new HealthTracker({}, clock), clock, clock.sleep, { maxTotalMs: 30_000 });
    const out = await router.execute({ op: 'mandate', candidates: ['pspA', 'pspB'], amountPaise: 49900, mandateRef: 'UMN1', baseRef: 'dbt_1' });
    expect(out.result).toEqual(BANK_DOWN);
    expect(pspB.calls).toHaveLength(0);
  });
});

describe('HealthTracker — time decay and probing (no starvation)', () => {
  const S = 1000;
  const M = 60 * S;
  const fresh = (opts = {}) => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    return { clock, h: new HealthTracker({ probeIntervalMs: 60 * S, probeAfterPasses: 10, halfLifeMs: 10 * M, ...opts }, clock) };
  };
  const times = <T,>(n: number, f: () => T) => Array.from({ length: n }, f);
  /** Route n payments, recording that the first PSP handled each successfully; returns the firsts. */
  const pay = (h: HealthTracker, n: number, ids = ['pspA', 'pspB']) =>
    times(n, () => {
      const first = h.route(ids)[0]!;
      h.record(first, OK());
      return first;
    });

  it('lets old failures fade so the score reflects recent behaviour', () => {
    const { clock, h } = fresh();
    times(8, () => h.record('pspA', BANK_DOWN));
    const atFailure = h.score('pspA');
    clock.advance(30 * M); // three half-lives: the eight failures now weigh as one
    const later = h.score('pspA');
    expect(later).toBeGreaterThan(atFailure);
    expect(later).toBeLessThan(0.2); // falls back to its (poor) longer-run record, not to "unknown"
    times(3, () => h.record('pspA', OK()));
    expect(h.score('pspA')).toBeGreaterThan(0.55); // recent successes now outweigh the old failures
  });

  it('keeps a fresh tracker in configured priority order', () => {
    const { h } = fresh();
    expect(pay(h, 10)).toEqual(Array(10).fill('pspA'));
  });

  it('heavy traffic: probes an avoided provider about once per probe interval', () => {
    const { clock, h } = fresh();
    times(5, () => h.record('pspA', BANK_DOWN));
    let probes = 0;
    for (let sec = 0; sec < 10 * 60; sec += 2) {
      // a payment every 2 seconds for 10 minutes
      clock.set(new Date(Date.parse('2026-10-15T08:00:00Z') + sec * S));
      const first = h.route(['pspA', 'pspB'])[0]!;
      if (first === 'pspA') {
        probes++;
        h.record('pspA', BANK_DOWN); // still broken: probes keep failing
      } else h.record('pspB', OK());
    }
    expect(probes).toBeGreaterThanOrEqual(9);
    expect(probes).toBeLessThanOrEqual(10);
  });

  it('light traffic: probes at most 1 in (passes + 1) payments', () => {
    const { clock, h } = fresh();
    times(5, () => h.record('pspA', BANK_DOWN));
    let probes = 0;
    for (let day = 0; day < 44; day++) {
      clock.advance(24 * 60 * M); // one payment a day
      const first = h.route(['pspA', 'pspB'])[0]!;
      if (first === 'pspA') {
        probes++;
        h.record('pspA', BANK_DOWN);
      } else h.record('pspB', OK());
    }
    expect(probes).toBe(4); // 1 in 11
  });

  it('a recovered provider takes over once it is the healthier one', () => {
    const { clock, h } = fresh();
    times(5, () => h.record('pspA', BANK_DOWN));
    for (let minute = 1; minute <= 60; minute++) {
      clock.advance(M);
      const first = h.route(['pspA', 'pspB'])[0]!;
      const bDown = minute > 30; // A has recovered; B degrades after 30 minutes
      if (first === 'pspB' && bDown) {
        h.record('pspB', BANK_DOWN);
        h.record('pspA', OK()); // failover to A succeeds
      } else h.record(first, OK());
    }
    expect(h.rank(['pspA', 'pspB'])).toEqual(['pspA', 'pspB']);
  });

  it('does not probe a blocked (open-circuit) provider before its cooldown, then re-tests it', () => {
    const { clock, h } = fresh({ minSamples: 5, cooldownMs: 120 * S, probeAfterPasses: 1 });
    times(5, () => h.record('pspA', BANK_DOWN));
    expect(h.state('pspA')).toBe('OPEN');
    clock.advance(60 * S);
    expect(pay(h, 3)).toEqual(['pspB', 'pspB', 'pspB']);
    clock.advance(60 * S);
    expect(h.state('pspA')).toBe('HALF_OPEN');
    expect(h.route(['pspA', 'pspB'])[0]).toBe('pspA');
  });

  it('counts customer-declined and pending traffic as traffic (no needless probes)', () => {
    const { clock, h } = fresh({ probeAfterPasses: 1 });
    times(5, () => h.record('pspA', BANK_DOWN));
    times(5, () => h.record('pspB', OK()));
    h.route(['pspA', 'pspB']);
    clock.advance(60 * S);
    h.record('pspA', NO_FUNDS); // A handled a payment (customer declined), so it isn't idle
    expect(h.route(['pspA', 'pspB'])[0]).toBe('pspB');
  });
});

describe('Router — probing in practice', () => {
  it('a failed probe falls back like any failure (collect: status check, then failover)', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const health = new HealthTracker({ probeAfterPasses: 3 }, clock);
    const pspA = new MockPsp('pspA', { script: [BANK_DOWN] });
    const pspB = new MockPsp('pspB');
    const router = new Router([pspA, pspB], health, clock, clock.sleep, { random: () => 0.5 });
    for (let i = 0; i < 5; i++) health.record('pspA', BANK_DOWN);
    const run = (ref: string) => router.execute({ op: 'collect', candidates: ['pspA', 'pspB'], amountPaise: 1, payerVpa: 'ab@ok', baseRef: ref });

    for (let i = 0; i < 3; i++) expect((await run(`p${i}`)).pspId).toBe('pspB');
    expect(pspA.calls).toHaveLength(0); // A is avoided while its failures are recent

    clock.advance(60_000);
    const probe = await run('probe');
    expect(pspA.calls.map((c) => c.op)).toEqual(['collect', 'status']); // probed first, status-checked
    expect(probe.result.kind).toBe('SUCCESS');
    expect(probe.pspId).toBe('pspB');
  });

  it('a mandate probe that fails fails over to the healthy provider', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const health = new HealthTracker({ probeAfterPasses: 1 }, clock);
    const pspA = new MockPsp('pspA', { script: [BANK_DOWN] });
    const pspB = new MockPsp('pspB');
    const router = new Router([pspA, pspB], health, clock, clock.sleep, { random: () => 0.5 });
    for (let i = 0; i < 5; i++) health.record('pspA', BANK_DOWN);
    await router.execute({ op: 'mandate', candidates: ['pspA', 'pspB'], amountPaise: 1, mandateRef: 'U', baseRef: 'm0' });
    clock.advance(60_000);
    const out = await router.execute({ op: 'mandate', candidates: ['pspA', 'pspB'], amountPaise: 1, mandateRef: 'U', baseRef: 'm1' });
    expect(pspA.calls.map((c) => c.op)).toEqual(['execute', 'status']);
    expect(out).toMatchObject({ pspId: 'pspB', hadTechnicalDecline: false }); // a failed probe earns no recovery credit
  });

  it('marks probe attempts and never counts a failed probe as a recovered technical decline', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const health = new HealthTracker({ probeAfterPasses: 1 }, clock);
    const pspA = new MockPsp('pspA', { script: [BANK_DOWN, BANK_DOWN] });
    const pspB = new MockPsp('pspB', { script: [OK('b0'), OK('b1'), TIMEOUT, OK('b2')] });
    const router = new Router([pspA, pspB], health, clock, clock.sleep, { random: () => 0.5 });
    for (let i = 0; i < 5; i++) health.record('pspA', BANK_DOWN);
    const run = (ref: string) => router.execute({ op: 'mandate', candidates: ['pspA', 'pspB'], amountPaise: 1, mandateRef: 'U', baseRef: ref });
    await run('m0'); // B; A passed over once

    clock.advance(60_000);
    const probeOnly = await run('m1'); // probe A fails, B succeeds
    expect(probeOnly.attempts.map((a) => [a.pspId, a.op, a.probe ?? false])).toEqual([
      ['pspA', 'execute', true],
      ['pspA', 'status', true],
      ['pspB', 'execute', false],
    ]);
    expect(probeOnly.hadTechnicalDecline).toBe(false); // nothing was recovered: the router chose to risk A

    clock.advance(60_000);
    const real = await run('m2'); // probe A fails, then B times out and is safely retried
    expect(real.result).toEqual(OK('b2'));
    expect(real.hadTechnicalDecline).toBe(true); // B's own failure was genuinely recovered
  });

  it('only probes among the PSPs eligible for this payment', async () => {
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const health = new HealthTracker({ probeAfterPasses: 1 }, clock);
    const pspA = new MockPsp('pspA');
    const pspB = new MockPsp('pspB');
    const router = new Router([pspA, pspB], health, clock, clock.sleep, { random: () => 0.5 });
    for (let i = 0; i < 5; i++) health.record('pspA', BANK_DOWN);
    for (let i = 0; i < 3; i++) {
      clock.advance(60_000);
      await router.execute({ op: 'mandate', candidates: ['pspB'], amountPaise: 1, mandateRef: 'U', baseRef: `m${i}` });
    }
    expect(pspA.calls).toHaveLength(0);
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
