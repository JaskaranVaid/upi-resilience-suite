import { describe, expect, it } from 'vitest';
import { buildAdapters, PspConfigError } from '../../src/psp/factory.js';

const base = {
  NODE_ENV: 'development' as const,
  MOCK_PSPS: 'pspA,pspB',
  MOCK_PSP_RATES: undefined,
  ALLOW_MOCK_PSPS: 'false' as const,
  CASHFREE_CLIENT_ID: undefined,
  CASHFREE_CLIENT_SECRET: undefined,
  CASHFREE_ENV: 'sandbox' as const,
  CASHFREE_TIMEOUT_MS: 10_000,
};

describe('buildAdapters', () => {
  it('builds mocks by default (development)', () => {
    expect(buildAdapters(base).map((a) => [a.id, a.mode])).toEqual([
      ['pspA', 'MOCK'],
      ['pspB', 'MOCK'],
    ]);
  });

  it('puts Cashfree first when configured, in sandbox by default', () => {
    const adapters = buildAdapters({ ...base, CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 'secret' });
    expect(adapters.map((a) => [a.id, a.mode])).toEqual([
      ['cashfree', 'SANDBOX'],
      ['pspA', 'MOCK'],
      ['pspB', 'MOCK'],
    ]);
  });

  it('runs Cashfree alone when mocks are switched off', () => {
    expect(buildAdapters({ ...base, MOCK_PSPS: '', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 's', CASHFREE_ENV: 'production' }).map((a) => [a.id, a.mode])).toEqual([['cashfree', 'LIVE']]);
  });

  it('rejects half-configured credentials', () => {
    expect(() => buildAdapters({ ...base, CASHFREE_CLIENT_ID: 'id' })).toThrow(PspConfigError);
  });

  it('refuses mock PSPs in production unless explicitly allowed', () => {
    expect(() => buildAdapters({ ...base, NODE_ENV: 'production' })).toThrow(/Refusing to start in production with mock PSPs/);
    const warnings: string[] = [];
    const adapters = buildAdapters({ ...base, NODE_ENV: 'production', ALLOW_MOCK_PSPS: 'true' }, { warn: (m) => warnings.push(m) });
    expect(adapters).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/MOCK PSP adapters/);
  });

  it('warns when production points at the Cashfree sandbox', () => {
    const warnings: string[] = [];
    buildAdapters({ ...base, NODE_ENV: 'production', MOCK_PSPS: '', CASHFREE_CLIENT_ID: 'id', CASHFREE_CLIENT_SECRET: 's' }, { warn: (m) => warnings.push(m) });
    expect(warnings.join(' ')).toMatch(/Cashfree test environment/);
  });

  it('refuses an empty configuration and duplicate ids', () => {
    expect(() => buildAdapters({ ...base, MOCK_PSPS: '' })).toThrow(/No payment providers/);
    expect(() => buildAdapters({ ...base, MOCK_PSPS: 'cashfree', CASHFREE_CLIENT_ID: 'i', CASHFREE_CLIENT_SECRET: 's' })).toThrow(/Duplicate PSP id/);
  });
});
