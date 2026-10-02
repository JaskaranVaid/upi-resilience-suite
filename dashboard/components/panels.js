import { html } from '../lib/html.js';
import { when } from '../lib/format.js';

/** "Was the customer charged? Did we capture it? Has it gone back?" — answered side by side. */
export function moneyPanel(money) {
  const r = money.reversal;
  return html`
    <div class="money">
      <div class="cell">
        <div class="q">Was the customer debited?</div>
        <div class="a">${money.customerDebit.label}</div>
      </div>
      <div class="cell">
        <div class="q">Did the PSP confirm capture?</div>
        <div class="a">${money.capture.label}</div>
        <div class="note">${money.capture.note}</div>
      </div>
      <div class="cell">
        <div class="q">Auto-reversal to customer</div>
        <div class="a">${r.label}</div>
        ${r.initiatedAt ? html`<div class="note">Initiated ${when(r.initiatedAt)}</div>` : ''}
        ${r.completedAt ? html`<div class="note">Completed ${when(r.completedAt)}</div>` : ''}
      </div>
    </div>`;
}

export function timeline(events) {
  if (!events.length) return html`<p class="muted">No events recorded yet.</p>`;
  return html`<ol class="timeline">
    ${events.map(
      (e) => html`<li>
        <div>${e.label}${e.count > 1 ? html` <span class="muted">×${e.count}</span>` : ''}</div>
        <div class="when">${when(e.at)}${e.actor ? html` · ${e.actor}` : ''}${e.detail ? html` · ${e.detail}` : ''}</div>
      </li>`,
    )}
  </ol>`;
}

export const loading = () => html`<p class="muted">Loading…</p>`;
export const errorBox = (message) => html`<div class="callout warn"><strong>Something went wrong</strong>${message}</div>`;
export const forbidden = () => html`<div class="callout info"><strong>Not available</strong>Your role doesn't have access to this page.</div>`;
