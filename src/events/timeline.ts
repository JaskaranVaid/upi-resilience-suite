import type { ActorType } from '../db/schema.js';
import { MERCHANT_STATUS_LABELS } from '../tracking/derive.js';
import type { CaseReason, CaseResolution, CaseStatus, ComplaintStatus, EventType } from '../tracking/types.js';

export interface EventRow {
  type: EventType;
  data: Record<string, unknown> | null;
  actorType: ActorType;
  actorId: string | null;
  createdAt: Date;
}

/** What the dashboard may show. Built from a whitelist — raw event data never passes through. */
export interface TimelineItem {
  at: Date;
  type: EventType;
  label: string;
  detail?: string;
  /** Display name of the dashboard user who acted. */
  actor?: string;
  /** For collapsed repeats (status checks). */
  count?: number;
}

export const CASE_REASON_LABELS: Record<CaseReason, string> = {
  DEBITED_NOT_CAPTURED: MERCHANT_STATUS_LABELS.DEBITED_NOT_CAPTURED,
  VERIFICATION_EXHAUSTED: 'Payment could not be verified automatically',
  STATUS_MISMATCH: MERCHANT_STATUS_LABELS.CAPTURED_AFTER_FAILURE,
  MERCHANT_RAISED: 'Raised by merchant',
  SETTLEMENT_MISMATCH: 'Settled amount differs from the captured amount',
  NOT_SETTLED: 'Captured but not yet settled to your account',
};

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  NEEDS_ACTION: 'Needs action',
  INVESTIGATING: 'Investigating (UDIR complaint open)',
  VERIFICATION_PENDING: 'Payment verification pending',
  REVERSAL_PENDING: 'Reversal pending',
  RESOLVED: 'Resolved',
};

export const CASE_RESOLUTION_LABELS: Record<CaseResolution, string> = {
  REVERSED_TO_CUSTOMER: 'Reversed to customer',
  CAPTURED: 'Payment captured',
  NOT_DEBITED: 'Customer was not debited',
  COMPLAINT_RESOLVED: 'UDIR complaint resolved',
  CLOSED_BY_MERCHANT: 'Closed by merchant',
  SETTLED: 'Settled to your account',
};

export const COMPLAINT_STATUS_LABELS: Record<ComplaintStatus, string> = {
  SUBMITTED: 'UDIR complaint submitted',
  IN_PROGRESS: 'UDIR complaint in progress',
  RESOLVED_REVERSED: 'UDIR complaint resolved — amount reversed',
  RESOLVED_NO_REVERSAL: 'UDIR complaint resolved — no reversal due',
  REJECTED: 'UDIR complaint rejected',
};

const AUDIT_ONLY: ReadonlySet<EventType> = new Set([
  'PAYMENT_VIEWED',
  'CASE_VIEWED',
  'USER_CREATED',
  'USER_UPDATED',
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
]);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function describe(type: EventType, data: Record<string, unknown>): { label: string; detail?: string } {
  switch (type) {
    case 'PAYMENT_CREATED':
      return { label: 'Payment initiated' };
    case 'PAYMENT_SUBMITTED': {
      const psp = str(data.pspId);
      return { label: 'Sent to payment provider', ...(psp ? { detail: `Provider: ${psp}` } : {}) };
    }
    case 'PAYMENT_STATE_CHANGED':
      return { label: data.to === 'SUCCEEDED' ? 'Payment marked successful' : data.to === 'FAILED' ? 'Payment marked failed' : 'Payment status updated' };
    case 'VERIFICATION_STARTED':
      return { label: 'Payment verification started' };
    case 'STATUS_CHECKED':
      return { label: 'Status checked with payment provider' };
    case 'RRN_RETRIEVED':
      return { label: 'UPI reference retrieved' };
    case 'CUSTOMER_DEBIT_DETECTED':
      return { label: 'Customer account debited' };
    case 'CAPTURE_CONFIRMED':
      return { label: 'Payment captured (PSP-confirmed)' };
    case 'REVERSAL_INITIATED':
      return { label: 'Auto-reversal to customer initiated' };
    case 'REVERSAL_COMPLETED':
      return { label: 'Auto-reversal to customer completed' };
    case 'SETTLEMENT_RECORDED': {
      const utr = str(data.utr);
      return { label: 'Settled to your account', ...(utr ? { detail: `Settlement UTR: ${utr}` } : {}) };
    }
    case 'VERIFICATION_RESOLVED':
      return { label: 'Verification complete' };
    case 'VERIFICATION_EXHAUSTED':
      return { label: 'Automatic verification ended — needs manual investigation' };
    case 'CASE_OPENED': {
      const reason = CASE_REASON_LABELS[data.reason as CaseReason];
      return { label: reason ? `Issue opened: ${reason}` : 'Issue opened' };
    }
    case 'CASE_STATUS_CHANGED': {
      const s = CASE_STATUS_LABELS[data.to as CaseStatus];
      return { label: s ? `Issue status: ${s}` : 'Issue status changed' };
    }
    case 'CASE_RESOLVED': {
      const r = CASE_RESOLUTION_LABELS[data.resolution as CaseResolution];
      return { label: r ? `Issue resolved: ${r}` : 'Issue resolved' };
    }
    case 'UDIR_COMPLAINT_RAISED': {
      const ref = str(data.pspComplaintRef);
      return {
        label:
          data.mode === 'MOCK'
            ? 'UDIR complaint raised (simulated — mock PSP, not sent to NPCI)'
            : data.mode === 'SANDBOX'
              ? 'UDIR complaint raised (PSP sandbox — test environment)'
              : 'UDIR complaint raised with PSP',
        ...(ref ? { detail: `Reference: ${ref}` } : {}),
      };
    }
    case 'UDIR_COMPLAINT_UPDATED':
      return { label: COMPLAINT_STATUS_LABELS[data.status as ComplaintStatus] ?? 'UDIR complaint updated' };
    case 'RECHECK_REQUESTED':
      return { label: 'Recheck requested' };
    case 'NOTE_ADDED':
      return { label: 'Note added' };
    default:
      return { label: type };
  }
}

/** Turn audit rows (oldest first) into the merchant-facing timeline. */
export function toTimeline(rows: EventRow[], userNames: ReadonlyMap<string, string>): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const row of rows) {
    if (AUDIT_ONLY.has(row.type)) continue;
    const prev = items.at(-1);
    if (row.type === 'STATUS_CHECKED' && prev?.type === 'STATUS_CHECKED') {
      prev.count = (prev.count ?? 1) + 1;
      prev.at = row.createdAt;
      continue;
    }
    const { label, detail } = describe(row.type, row.data ?? {});
    const actor = row.actorType === 'DASHBOARD_USER' && row.actorId ? (userNames.get(row.actorId) ?? 'Dashboard user') : undefined;
    items.push({ at: row.createdAt, type: row.type, label, ...(detail ? { detail } : {}), ...(actor ? { actor } : {}) });
  }
  return items;
}
