import { html } from '../lib/html.js';

// Colour only: maps server-provided status codes to a visual tone. Labels come from the API.
const MERCHANT_TONES = {
  SUCCEEDED: 'good',
  REVERSED: 'neutral',
  FAILED: 'neutral',
  SCHEDULED: 'info',
  PROCESSING: 'info',
  VERIFYING: 'info',
  REVERSAL_IN_PROGRESS: 'info',
  DEBITED_NOT_CAPTURED: 'warn',
  CAPTURED_AFTER_FAILURE: 'bad',
  NEEDS_INVESTIGATION: 'bad',
};

const CASE_TONES = {
  NEEDS_ACTION: 'bad',
  INVESTIGATING: 'info',
  VERIFICATION_PENDING: 'info',
  REVERSAL_PENDING: 'warn',
  RESOLVED: 'good',
};

export const statusBadge = (code, label) => html`<span class="badge tone-${MERCHANT_TONES[code] ?? 'neutral'}">${label}</span>`;
export const caseBadge = (code, label) => html`<span class="badge tone-${CASE_TONES[code] ?? 'neutral'}">${label}</span>`;
export const mockBadge = (mode) =>
  mode === 'MOCK'
    ? html`<span class="badge tone-mock" title="Simulated provider — no real PSP or NPCI calls are made">Mock PSP</span>`
    : mode === 'SANDBOX'
      ? html`<span class="badge tone-mock" title="The PSP's test environment — no real money moves">PSP sandbox</span>`
      : '';
