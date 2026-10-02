import type { CustomerDebit } from '../psp/types.js';
import type { DomainState } from '../tracking/types.js';

/**
 * When a UDIR complaint may be raised. Shared by the action endpoint (which enforces it) and
 * the dashboard detail views (which only use it to decide which buttons to show).
 */
export function complaintEligibility(i: {
  domainState: DomainState;
  customerDebit: CustomerDebit | null;
  submittedToPsp: boolean;
  activeComplaint: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!i.submittedToPsp) return { ok: false, reason: 'This payment never reached a payment provider' };
  if (i.domainState === 'SUCCEEDED') return { ok: false, reason: 'This payment was captured successfully' };
  if (i.customerDebit === 'NOT_DEBITED') return { ok: false, reason: 'The customer was not debited for this payment' };
  if (i.activeComplaint) return { ok: false, reason: 'A UDIR complaint is already open for this payment' };
  return { ok: true };
}
