import { api } from '../api/client.js';
import { caseBadge } from '../components/badges.js';
import { errorBox, loading } from '../components/panels.js';
import { money, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

export async function renderOverview(el) {
  mount(el, loading());
  let o, needs;
  try {
    [o, needs] = await Promise.all([api.overview(), api.cases({ status: 'NEEDS_ACTION', limit: 5 })]);
  } catch (e) {
    return mount(el, errorBox(e.message));
  }

  const tile = (value, label, href, attention = false) =>
    html`<a class="card kpi${attention && value > 0 ? ' attention' : ''}" href="${href}">
      <div class="value num">${value.toLocaleString('en-IN')}</div>
      <div class="label">${label}</div>
    </a>`;

  mount(
    el,
    html`<div class="page-head"><h1>What's happening with my payments</h1></div>
      <div class="kpis">
        ${tile(o.casesNeedingAction, 'Issues needing action', '#/cases?status=NEEDS_ACTION', true)}
        ${tile(o.debitedNotCaptured, 'Customer debited, not captured', '#/payments?status=DEBITED_NOT_CAPTURED', true)}
        ${tile(o.needsInvestigation, 'Needs manual investigation', '#/payments?status=NEEDS_INVESTIGATION', true)}
        ${tile(o.reversalsPending, 'Auto-reversals in progress', '#/payments?status=REVERSAL_IN_PROGRESS')}
        ${tile(o.inProgress, 'In progress (processing, verifying or scheduled)', '#/payments')}
        ${tile(o.succeeded, 'Successful (captured)', '#/payments?status=SUCCEEDED')}
        ${tile(o.failed, 'Failed', '#/payments?status=FAILED')}
        ${tile(o.total, 'Total payments', '#/payments')}
      </div>
      <section class="card">
        <div class="page-head tight">
          <h2 class="m0">Needs action</h2>
          <a href="#/cases?status=NEEDS_ACTION">Open Dispute Desk →</a>
        </div>
        ${needs.data.length === 0
          ? html`<p class="muted m0">Nothing needs your attention right now.</p>`
          : html`<div class="table-wrap"><table>
              <thead><tr><th>Opened</th><th>Issue</th><th>Order</th><th class="right">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>${needs.data.map(
                (c) => html`<tr>
                  <td>${when(c.openedAt)}</td><td>${c.reasonLabel}</td><td class="mono">${c.payment.orderId ?? '—'}</td>
                  <td class="right num">${money(c.payment.amountPaise)}</td><td>${caseBadge(c.status, c.statusLabel)}</td>
                  <td><a href="#/cases/${c.id}">Investigate</a></td>
                </tr>`,
              )}</tbody></table></div>`}
      </section>`,
  );
}
