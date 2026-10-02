import type { WindowConfig } from '../rules/windows.js';

/**
 * Regulatory parameters, versioned by effective date.
 *
 * Every number here comes from the "UPI Taxation Business Gap Analysis" brief
 * (Taxation and Other Laws (Amendment) Bill 2026, NPCI MDR circular effective
 * 15 Oct 2026, NPCI AutoPay execution windows). Verify against the latest
 * NPCI/RBI circulars before go-live — change values here, not in code.
 */

export interface MdrRules {
  /** P2M transactions up to and including this amount carry zero MDR. */
  freeUptoPaise: number;
  /** General P2M rate above the threshold, in basis points (40 = 0.4%). */
  generalBps: number;
  generalCapPaise: number;
  /** Flat fee for exempted sectors (railways, telecom, insurance, fuel, utilities). */
  exemptSectorFlatPaise: number;
  capitalMarketsBps: number;
  capitalMarketsCapPaise: number;
}

export interface RuleSet {
  id: string;
  effectiveFrom: Date;
  windows: WindowConfig;
  /** null = zero-MDR regime (all UPI P2M free). */
  mdr: MdrRules | null;
  preDebitNoticeHours: number;
}

export const DEFAULT_WINDOWS: WindowConfig = {
  peak: [
    { start: '10:00', end: '13:00' },
    { start: '17:00', end: '21:30' },
  ],
  blackout: [{ start: '23:30', end: '00:30' }],
  preferred: [{ start: '13:00', end: '17:00' }],
};

export const RULE_SETS: readonly RuleSet[] = [
  {
    id: 'zero-mdr-legacy',
    effectiveFrom: new Date('2020-01-01T00:00:00+05:30'),
    windows: DEFAULT_WINDOWS,
    mdr: null,
    preDebitNoticeHours: 24,
  },
  {
    id: 'npci-mdr-2026-10',
    effectiveFrom: new Date('2026-10-15T00:00:00+05:30'),
    windows: DEFAULT_WINDOWS,
    mdr: {
      freeUptoPaise: 2_000_00,
      generalBps: 40,
      generalCapPaise: 300_00,
      exemptSectorFlatPaise: 5_00,
      capitalMarketsBps: 2,
      capitalMarketsCapPaise: 300_00,
    },
    preDebitNoticeHours: 24,
  },
];

export function getRuleSet(at: Date, sets: readonly RuleSet[] = RULE_SETS): RuleSet {
  let chosen: RuleSet | undefined;
  for (const s of sets) {
    if (s.effectiveFrom.getTime() <= at.getTime() && (!chosen || s.effectiveFrom > chosen.effectiveFrom)) {
      chosen = s;
    }
  }
  if (!chosen) throw new Error(`No rule set effective at ${at.toISOString()}`);
  return chosen;
}
