import { describe, expect, it } from 'vitest';
import { computeMdr, feeFor, type MerchantProfile } from '../../src/rules/mdr.js';
import { MDR_2026 } from '../../src/config/rules.js';

const reform = MDR_2026;
const general: MerchantProfile = { category: 'GENERAL', smallMerchant: false };
const rs = (n: number) => Math.round(n * 100); // rupees -> paise

describe('computeMdr (Oct 2026 slabs)', () => {
  it.each([
    ['P2M under threshold', general, rs(1999), 0],
    ['P2M exactly at threshold is free', general, rs(2000), 0],
    ['P2M just over threshold pays 0.4%', general, rs(2000.01), Math.round(200001 * 0.004)],
    ['P2M ₹5,000 → ₹20', general, rs(5000), rs(20)],
    ['P2M ₹75,000 hits the ₹300 cap exactly', general, rs(75000), rs(300)],
    ['P2M ₹1,00,000 capped at ₹300', general, rs(100000), rs(300)],
    ['P2P always free', { category: 'P2P', smallMerchant: false }, rs(50000), 0],
    ['small merchant exempt', { category: 'GENERAL', smallMerchant: true }, rs(50000), 0],
    ['exempt sector flat ₹5', { category: 'EXEMPT_SECTOR', smallMerchant: false }, rs(50000), rs(5)],
    ['exempt sector under threshold free', { category: 'EXEMPT_SECTOR', smallMerchant: false }, rs(1500), 0],
    ['capital markets 0.02%', { category: 'CAPITAL_MARKETS', smallMerchant: false }, rs(100000), rs(20)],
    ['capital markets capped ₹300', { category: 'CAPITAL_MARKETS', smallMerchant: false }, rs(2000000), rs(300)],
  ] as const)('%s', (_name, profile, amount, expected) => {
    expect(computeMdr({ amountPaise: amount, profile, rules: reform })).toBe(expected);
  });

  it('rounds half-up to the paisa', () => {
    // 2000.13 * 0.4% = 8.00052 rupees = 800.052 paise -> 800; 2001.25 * 0.4% = 800.5 paise -> 801
    expect(computeMdr({ amountPaise: 200013, profile: general, rules: reform })).toBe(800);
    expect(computeMdr({ amountPaise: 200125, profile: general, rules: reform })).toBe(801);
  });

  it('is zero under the legacy zero-MDR regime', () => {
    expect(computeMdr({ amountPaise: rs(50000), profile: general, rules: null })).toBe(0);
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => computeMdr({ amountPaise: 10.5, profile: general, rules: reform })).toThrow();
    expect(() => computeMdr({ amountPaise: -1, profile: general, rules: reform })).toThrow();
  });
});

describe('feeFor', () => {
  it('applies percent + flat with optional cap', () => {
    expect(feeFor(rs(5000), { percentBps: 0, flatPaise: rs(8) })).toBe(rs(8));
    expect(feeFor(rs(5000), { percentBps: 180, flatPaise: 0 })).toBe(rs(90));
    expect(feeFor(rs(50000), { percentBps: 100, flatPaise: rs(2), capPaise: rs(100) })).toBe(rs(100));
  });
});
