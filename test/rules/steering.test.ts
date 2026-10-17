import { describe, expect, it } from 'vitest';
import { quoteMethods, DEFAULT_STEERING, type MethodCosts } from '../../src/rules/steering.js';
import type { MerchantProfile } from '../../src/rules/mdr.js';
import { MDR_2026 } from '../../src/config/rules.js';

const reform = MDR_2026;
const general: MerchantProfile = { category: 'GENERAL', smallMerchant: false };
const rs = (n: number) => Math.round(n * 100);

const costs: MethodCosts = {
  NETBANKING: { percentBps: 0, flatPaise: rs(8) },
  CARD: { percentBps: 180, flatPaise: 0 },
};

describe('quoteMethods', () => {
  it('offers a NetBanking discount on a ₹5,000 cart where UPI MDR is ₹20', () => {
    const q = quoteMethods({ amountPaise: rs(5000), profile: general, mdr: reform, methodCosts: costs, steering: DEFAULT_STEERING });
    const upi = q.methods.find((m) => m.method === 'UPI')!;
    expect(upi.merchantCostPaise).toBe(rs(20));
    expect(upi.customerPayablePaise).toBe(rs(5000));
    // savings = 20 - 8 = ₹12; 25% share = ₹3 discount
    expect(q.offer).toEqual({ method: 'NETBANKING', discountPaise: rs(3), merchantNetSavingsPaise: rs(9) });
    const nb = q.methods.find((m) => m.method === 'NETBANKING')!;
    expect(nb.customerDiscountPaise).toBe(rs(3));
    expect(nb.customerPayablePaise).toBe(rs(4997));
  });

  it('makes no offer below the threshold where UPI is free', () => {
    const q = quoteMethods({ amountPaise: rs(1500), profile: general, mdr: reform, methodCosts: costs, steering: DEFAULT_STEERING });
    expect(q.offer).toBeUndefined();
    expect(q.methods.every((m) => m.customerPayablePaise === rs(1500))).toBe(true);
  });

  it('makes no offer when savings are below the minimum', () => {
    const q = quoteMethods({
      amountPaise: rs(2500), // UPI MDR ₹10, NB ₹8 -> savings ₹2 < ₹5 min
      profile: general, mdr: reform, methodCosts: costs, steering: DEFAULT_STEERING,
    });
    expect(q.offer).toBeUndefined();
  });

  it('caps the discount at maxDiscountPaise', () => {
    const q = quoteMethods({
      amountPaise: rs(100000), profile: general, mdr: reform,
      methodCosts: costs, steering: { ...DEFAULT_STEERING, shareBps: 9000, maxDiscountPaise: rs(50) },
    });
    expect(q.offer?.discountPaise).toBe(rs(50));
  });

  it('never steers to RuPay debit — the card checkout takes any card — and steers to the next cheapest method', () => {
    const q = quoteMethods({
      amountPaise: rs(5000), profile: general, mdr: reform, steering: DEFAULT_STEERING,
      methodCosts: { ...costs, RUPAY_DEBIT: { percentBps: 0, flatPaise: 0 } }, // cheapest, but not enforceable
    });
    // NetBanking as in the first case: savings ₹20 − ₹8 = ₹12, 25% share = ₹3 discount, merchant nets ₹9.
    expect(q.offer).toEqual({ method: 'NETBANKING', discountPaise: rs(3), merchantNetSavingsPaise: rs(9) });
    expect(q.methods.find((m) => m.method === 'RUPAY_DEBIT')).toEqual({
      method: 'RUPAY_DEBIT', merchantCostPaise: 0, customerDiscountPaise: 0, customerPayablePaise: rs(5000), merchantNetPaise: rs(5000),
    });
  });

  it('makes no offer when RuPay debit is the only method cheaper than UPI', () => {
    const q = quoteMethods({
      amountPaise: rs(5000), profile: general, mdr: reform, steering: DEFAULT_STEERING,
      methodCosts: { RUPAY_DEBIT: { percentBps: 0, flatPaise: 0 }, CARD: { percentBps: 180, flatPaise: 0 } },
    });
    expect(q.offer).toBeUndefined();
    expect(q.methods.every((m) => m.customerPayablePaise === rs(5000))).toBe(true);
  });

  it('respects steering disabled', () => {
    const q = quoteMethods({ amountPaise: rs(5000), profile: general, mdr: reform, methodCosts: costs, steering: { ...DEFAULT_STEERING, enabled: false } });
    expect(q.offer).toBeUndefined();
  });

  it('invariants hold for random carts: no surcharge, UPI never repriced, merchant always better off', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const amount = 100 + Math.floor(rand() * rs(200000));
      const mc: MethodCosts = {
        NETBANKING: { percentBps: Math.floor(rand() * 60), flatPaise: Math.floor(rand() * rs(30)) },
        RUPAY_DEBIT: { percentBps: Math.floor(rand() * 40), flatPaise: 0, capPaise: rs(100) },
        CARD: { percentBps: 100 + Math.floor(rand() * 200), flatPaise: 0 },
      };
      const steering = { enabled: true, shareBps: Math.floor(rand() * 10000), minSavingsPaise: Math.floor(rand() * rs(10)), maxDiscountPaise: Math.floor(rand() * rs(200)) };
      const q = quoteMethods({ amountPaise: amount, profile: general, mdr: reform, methodCosts: mc, steering });
      for (const m of q.methods) {
        expect(m.customerPayablePaise).toBeLessThanOrEqual(amount);
        expect(m.customerDiscountPaise).toBeGreaterThanOrEqual(0);
      }
      expect(q.methods.find((m) => m.method === 'UPI')!.customerPayablePaise).toBe(amount);
      if (q.offer) {
        expect(q.offer.merchantNetSavingsPaise).toBeGreaterThan(0);
        expect(q.offer.discountPaise).toBeGreaterThan(0);
      }
    }
  });
});
