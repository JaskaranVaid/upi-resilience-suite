import { describe, expect, it } from 'vitest';
import { splitCart, SplitError } from '../../src/rules/split.js';
import type { MerchantProfile } from '../../src/rules/mdr.js';
import { RULE_SETS } from '../../src/config/rules.js';

const reform = RULE_SETS.find((r) => r.id === 'npci-mdr-2026-10')!.mdr;
const rs = (n: number) => Math.round(n * 100);
const general: MerchantProfile = { category: 'GENERAL', smallMerchant: false };

const vendors: Record<string, MerchantProfile> = {
  potter: { category: 'GENERAL', smallMerchant: true },
  weaver: general,
  jeweller: general,
};

describe('splitCart', () => {
  it('creates one leg per vendor, computed on each vendor profile', () => {
    const r = splitCart({
      lineItems: [
        { vendorId: 'potter', amountPaise: rs(1200) },
        { vendorId: 'weaver', amountPaise: rs(1500) },
        { vendorId: 'potter', amountPaise: rs(900) },
        { vendorId: 'jeweller', amountPaise: rs(2400) },
      ],
      vendors,
      platformProfile: general,
      mdr: reform,
    });
    expect(r.totalPaise).toBe(rs(6000));
    expect(r.legs).toEqual([
      { vendorId: 'potter', amountPaise: rs(2100), mdrPaise: 0, lineItemCount: 2 }, // small merchant exempt
      { vendorId: 'weaver', amountPaise: rs(1500), mdrPaise: 0, lineItemCount: 1 },
      { vendorId: 'jeweller', amountPaise: rs(2400), mdrPaise: rs(9.6), lineItemCount: 1 },
    ]);
    expect(r.splitMdrPaise).toBe(rs(9.6));
    expect(r.consolidatedMdrPaise).toBe(rs(24));
  });

  it('never splits a single vendor even when the amount is above the threshold', () => {
    const r = splitCart({
      lineItems: [
        { vendorId: 'weaver', amountPaise: rs(1500) },
        { vendorId: 'weaver', amountPaise: rs(1500) },
        { vendorId: 'weaver', amountPaise: rs(2000) },
      ],
      vendors, platformProfile: general, mdr: reform,
    });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.amountPaise).toBe(rs(5000));
    expect(r.legs[0]!.mdrPaise).toBe(rs(20));
  });

  it.each([
    ['empty cart', []],
    ['unknown vendor', [{ vendorId: 'ghost', amountPaise: 100 }]],
    ['non-integer amount', [{ vendorId: 'weaver', amountPaise: 10.5 }]],
    ['zero amount', [{ vendorId: 'weaver', amountPaise: 0 }]],
  ])('rejects %s', (_n, lineItems) => {
    expect(() => splitCart({ lineItems, vendors, platformProfile: general, mdr: reform })).toThrow(SplitError);
  });
});
