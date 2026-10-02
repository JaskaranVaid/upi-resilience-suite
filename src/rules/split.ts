import type { MdrRules } from '../config/rules.js';
import { computeMdr, type MerchantProfile } from './mdr.js';

export class SplitError extends Error {
  override name = 'SplitError';
}

export interface LineItem {
  vendorId: string;
  amountPaise: number;
  sku?: string;
}

export interface SplitLeg {
  vendorId: string;
  amountPaise: number;
  mdrPaise: number;
  lineItemCount: number;
}

export interface SplitResult {
  totalPaise: number;
  legs: SplitLeg[];
  splitMdrPaise: number;
  /** MDR had the platform been merchant of record for the whole cart — for transparency. */
  consolidatedMdrPaise: number;
}

/**
 * Split a marketplace cart into one payment leg per vendor, where each vendor is the
 * genuine merchant of record for its own line items.
 *
 * Compliance: legs are derived only from line-item ownership. A single vendor's amount is
 * never broken into multiple legs — chunking one merchant's payment to stay under the MDR
 * threshold is fee structuring and is deliberately unsupported.
 */
export function splitCart(args: {
  lineItems: LineItem[];
  vendors: Record<string, MerchantProfile>;
  platformProfile: MerchantProfile;
  mdr: MdrRules | null;
}): SplitResult {
  const { lineItems, vendors, platformProfile, mdr } = args;
  if (lineItems.length === 0) throw new SplitError('Cart has no line items');

  const legs = new Map<string, SplitLeg>();
  for (const item of lineItems) {
    if (!Number.isSafeInteger(item.amountPaise) || item.amountPaise <= 0) {
      throw new SplitError(`Line item amount must be a positive integer of paise, got ${item.amountPaise}`);
    }
    if (!Object.hasOwn(vendors, item.vendorId)) throw new SplitError(`Unknown vendor ${item.vendorId}`);
    const leg = legs.get(item.vendorId) ?? { vendorId: item.vendorId, amountPaise: 0, mdrPaise: 0, lineItemCount: 0 };
    leg.amountPaise += item.amountPaise;
    leg.lineItemCount += 1;
    legs.set(item.vendorId, leg);
  }

  for (const leg of legs.values()) {
    leg.mdrPaise = computeMdr({ amountPaise: leg.amountPaise, profile: vendors[leg.vendorId]!, rules: mdr });
  }

  const legList = [...legs.values()];
  const totalPaise = legList.reduce((s, l) => s + l.amountPaise, 0);
  const itemTotal = lineItems.reduce((s, i) => s + i.amountPaise, 0);
  if (totalPaise !== itemTotal) throw new SplitError('Legs do not sum to cart total');

  return {
    totalPaise,
    legs: legList,
    splitMdrPaise: legList.reduce((s, l) => s + l.mdrPaise, 0),
    consolidatedMdrPaise: computeMdr({ amountPaise: totalPaise, profile: platformProfile, rules: mdr }),
  };
}
