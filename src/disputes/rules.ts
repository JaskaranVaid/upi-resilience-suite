import type { PspRegistry } from '../psp/registry.js';
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
  reversalCompleted: boolean;
  /** The payment's PSP can raise UDIR complaints on the merchant's behalf. */
  providerSupportsComplaints: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (!i.submittedToPsp) return { ok: false, reason: 'This payment never reached a payment provider' };
  if (i.domainState === 'SUCCEEDED') return { ok: false, reason: 'This payment was captured successfully' };
  if (i.customerDebit === 'NOT_DEBITED') return { ok: false, reason: 'The customer was not debited for this payment' };
  if (i.activeComplaint) return { ok: false, reason: 'A UDIR complaint is already open for this payment' };
  if (i.reversalCompleted) return { ok: false, reason: 'The amount has already been reversed to the customer' };
  if (!i.providerSupportsComplaints) {
    return {
      ok: false,
      reason: "This payment provider doesn't accept merchant-raised UDIR complaints — the customer can raise one from their UPI app",
    };
  }
  return { ok: true };
}

/** Whether the PSP a payment went through can raise UDIR complaints (unknown PSP → no). */
export function supportsComplaints(psps: PspRegistry, pspId: string | null): boolean {
  if (!pspId) return false;
  try {
    return psps.get(pspId).capabilities.udirComplaints;
  } catch {
    return false;
  }
}
