import type { MdrRules } from '../config/rules.js';
import { assertPaise, computeMdr, feeFor, type FeeSpec, type MerchantProfile } from './mdr.js';

export const PAYMENT_METHODS = ['UPI', 'NETBANKING', 'RUPAY_DEBIT', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AltMethod = Exclude<PaymentMethod, 'UPI'>;

/** The merchant's negotiated cost for each non-UPI method it accepts. Absent = not accepted. */
export type MethodCosts = Partial<Record<AltMethod, FeeSpec>>;

export interface SteeringConfig {
  enabled: boolean;
  /** Share of the merchant's saving passed to the customer as a discount, in bps. */
  shareBps: number;
  /** Don't steer unless the merchant saves at least this much. */
  minSavingsPaise: number;
  maxDiscountPaise: number;
}

export const DEFAULT_STEERING: SteeringConfig = {
  enabled: true,
  shareBps: 2_500,
  minSavingsPaise: 5_00,
  maxDiscountPaise: 100_00,
};

export interface MethodQuote {
  method: PaymentMethod;
  merchantCostPaise: number;
  customerDiscountPaise: number;
  customerPayablePaise: number;
  /** What the merchant keeps: payable − cost. */
  merchantNetPaise: number;
}

export interface SteeringOffer {
  method: AltMethod;
  discountPaise: number;
  merchantNetSavingsPaise: number;
}

export interface MethodsQuote {
  amountPaise: number;
  methods: MethodQuote[];
  offer?: SteeringOffer;
}

/**
 * Cost every accepted payment method and, where another method is meaningfully cheaper
 * than UPI for the merchant, offer the customer a discount to choose it.
 *
 * Compliance: steering is discount-only. UPI is always priced at the cart amount and no
 * method's payable may exceed it — passing MDR to the customer as a surcharge is prohibited.
 */
export function quoteMethods(args: {
  amountPaise: number;
  profile: MerchantProfile;
  mdr: MdrRules | null;
  methodCosts: MethodCosts;
  steering: SteeringConfig;
}): MethodsQuote {
  const { amountPaise, profile, mdr, methodCosts, steering } = args;
  assertPaise(amountPaise);

  const upiCost = computeMdr({ amountPaise, profile, rules: mdr });
  const alts = (Object.entries(methodCosts) as Array<[AltMethod, FeeSpec]>).map(([method, spec]) => ({
    method,
    spec,
    cost: feeFor(amountPaise, spec),
  }));

  let offer: SteeringOffer | undefined;
  const best = alts.reduce<(typeof alts)[number] | undefined>((b, a) => (!b || a.cost < b.cost ? a : b), undefined);
  if (steering.enabled && best) {
    const savings = upiCost - best.cost;
    if (savings >= steering.minSavingsPaise && savings > 0) {
      const discount = Math.min(Math.floor((savings * steering.shareBps) / 10_000), steering.maxDiscountPaise, amountPaise);
      // Fee is charged on what the customer actually pays, so recompute on the discounted amount.
      const net = upiCost - (feeFor(amountPaise - discount, best.spec) + discount);
      if (discount > 0 && net > 0) {
        offer = { method: best.method, discountPaise: discount, merchantNetSavingsPaise: net };
      }
    }
  }

  const quote = (method: PaymentMethod, spec: FeeSpec | null): MethodQuote => {
    const discount = offer && offer.method === method ? offer.discountPaise : 0;
    const payable = amountPaise - discount;
    const cost = spec ? feeFor(payable, spec) : upiCost;
    return {
      method,
      merchantCostPaise: cost,
      customerDiscountPaise: discount,
      customerPayablePaise: payable,
      merchantNetPaise: payable - cost,
    };
  };

  return {
    amountPaise,
    methods: [quote('UPI', null), ...alts.map((a) => quote(a.method, a.spec))],
    ...(offer ? { offer } : {}),
  };
}
