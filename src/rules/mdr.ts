import type { MdrRules } from '../config/rules.js';

export type MerchantCategory = 'GENERAL' | 'EXEMPT_SECTOR' | 'CAPITAL_MARKETS' | 'P2P';

export interface MerchantProfile {
  category: MerchantCategory;
  /** Receives < ₹1 lakh/month via direct QR — exempt from MDR. */
  smallMerchant: boolean;
}

export interface FeeSpec {
  percentBps: number;
  flatPaise: number;
  capPaise?: number;
}

export function assertPaise(amountPaise: number): void {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw new RangeError(`Amount must be a non-negative integer number of paise, got ${amountPaise}`);
  }
}

/** Basis-point fee rounded half-up to the paisa (amounts are positive, so Math.round is half-up). */
function bpsOf(amountPaise: number, bps: number): number {
  return Math.round((amountPaise * bps) / 10_000);
}

export function feeFor(amountPaise: number, spec: FeeSpec): number {
  assertPaise(amountPaise);
  const fee = bpsOf(amountPaise, spec.percentBps) + spec.flatPaise;
  return spec.capPaise === undefined ? fee : Math.min(fee, spec.capPaise);
}

/** UPI MDR the merchant bears on a single P2M transaction. */
export function computeMdr(args: { amountPaise: number; profile: MerchantProfile; rules: MdrRules | null }): number {
  const { amountPaise, profile, rules } = args;
  assertPaise(amountPaise);
  if (!rules) return 0;
  if (profile.category === 'P2P' || profile.smallMerchant) return 0;
  if (amountPaise <= rules.freeUptoPaise) return 0;
  switch (profile.category) {
    case 'EXEMPT_SECTOR':
      return rules.exemptSectorFlatPaise;
    case 'CAPITAL_MARKETS':
      return Math.min(bpsOf(amountPaise, rules.capitalMarketsBps), rules.capitalMarketsCapPaise);
    case 'GENERAL':
      return Math.min(bpsOf(amountPaise, rules.generalBps), rules.generalCapPaise);
  }
}
