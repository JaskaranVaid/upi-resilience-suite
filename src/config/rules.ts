import type { WindowConfig } from '../rules/windows.js';

/**
 * Regulatory parameters, versioned by effective date.
 *
 * Sources and verification status: docs/regulatory/fact-sheet.md. The MDR slabs match NPCI's
 * UPI MDR FAQs (15 Sep 2026); their start date was postponed past 15 Oct 2026 with no new date,
 * so it is configuration (MDR_EFFECTIVE_FROM), not code. Change values here, not in services.
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

/**
 * NPCI AutoPay non-peak execution rule (in force since 1 Aug 2025). Reports put the evening peak
 * start at 17:00 or 17:30; 17:00 is used because it is the stricter of the two and the preferred
 * window ends at 17:00 anyway, so it costs no capacity.
 */
export const DEFAULT_WINDOWS: WindowConfig = {
  peak: [
    { start: '10:00', end: '13:00' },
    { start: '17:00', end: '21:30' },
  ],
  blackout: [{ start: '23:30', end: '00:30' }],
  preferred: [{ start: '13:00', end: '17:00' }],
};

/**
 * Largest recurring debit that may run without the customer authenticating it (RBI e-mandate
 * framework, June 2022). Above it AutoPay needs the customer's PIN, so it can't run silently.
 */
export const AUTOPAY_NO_AFA_LIMIT_PAISE = 15_000_00;

/**
 * Higher limit reported for specific categories (mutual funds, insurance premiums, credit card
 * bills). Unverified (see fact sheet): a merchant may opt a mandate in, never beyond this.
 */
export const AUTOPAY_NO_AFA_MAX_PAISE = 1_00_000_00;

/** UPI P2M MDR slabs per NPCI's UPI MDR FAQs (15 Sep 2026). */
export const MDR_2026: MdrRules = {
  freeUptoPaise: 2_000_00,
  generalBps: 40,
  generalCapPaise: 300_00,
  exemptSectorFlatPaise: 5_00,
  capitalMarketsBps: 2,
  capitalMarketsCapPaise: 300_00,
};

export const LEGACY_RULE_SET: RuleSet = {
  id: 'zero-mdr-legacy',
  effectiveFrom: new Date('2020-01-01T00:00:00+05:30'),
  windows: DEFAULT_WINDOWS,
  mdr: null,
  preDebitNoticeHours: 24,
};

export const MDR_RULE_SET_ID = 'npci-mdr-2026';

/**
 * When the MDR regime starts. null = announced but not in force with a known date (NPCI postponed
 * the original 15 Oct 2026 start to "after Diwali 2026"). Set from MDR_EFFECTIVE_FROM at startup.
 */
let mdrEffectiveFrom: Date | null = null;

/** Set (or clear) the MDR start date. `date` is an IST calendar date, YYYY-MM-DD, or a Date. */
export function configureMdrEffectiveFrom(date: string | Date | null): void {
  if (date === null) {
    mdrEffectiveFrom = null;
    return;
  }
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00+05:30`) : date;
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid MDR effective date: ${String(date)}`);
  mdrEffectiveFrom = d;
}

export function getMdrEffectiveFrom(): Date | null {
  return mdrEffectiveFrom;
}

/** The rule sets currently configured, oldest first. */
export function ruleSets(): RuleSet[] {
  return mdrEffectiveFrom
    ? [LEGACY_RULE_SET, { id: MDR_RULE_SET_ID, effectiveFrom: mdrEffectiveFrom, windows: DEFAULT_WINDOWS, mdr: MDR_2026, preDebitNoticeHours: 24 }]
    : [LEGACY_RULE_SET];
}

export type MdrStatus = 'NOT_SCHEDULED' | 'SCHEDULED' | 'IN_FORCE';

/** Whether the MDR applies at `at`, is scheduled for later, or has no confirmed start date. */
export function mdrStatus(at: Date): { status: MdrStatus; effectiveFrom: Date | null } {
  if (!mdrEffectiveFrom) return { status: 'NOT_SCHEDULED', effectiveFrom: null };
  return { status: at >= mdrEffectiveFrom ? 'IN_FORCE' : 'SCHEDULED', effectiveFrom: mdrEffectiveFrom };
}

export function getRuleSet(at: Date, sets: readonly RuleSet[] = ruleSets()): RuleSet {
  let chosen: RuleSet | undefined;
  for (const s of sets) {
    if (s.effectiveFrom.getTime() <= at.getTime() && (!chosen || s.effectiveFrom > chosen.effectiveFrom)) {
      chosen = s;
    }
  }
  if (!chosen) throw new Error(`No rule set effective at ${at.toISOString()}`);
  return chosen;
}

/**
 * Extension point for regulatory reversal/refund deadlines (Phase 3 decision D1).
 *
 * Intentionally EMPTY. Different UPI failure categories carry different RBI treatment, so a
 * rule may only be added with an explicitly confirmed mapping to a transaction category and
 * a cited source. Nothing in the product computes or displays a due date while this is empty.
 */
export interface ReversalDeadlineRule {
  /** The documented UPI failure category this rule applies to. */
  failureCategory: string;
  /** Citation of the circular/notification the rule comes from. Required. */
  source: string;
  dueBy(debitedAt: Date): Date;
}

export const REVERSAL_DEADLINE_RULES: readonly ReversalDeadlineRule[] = [];
