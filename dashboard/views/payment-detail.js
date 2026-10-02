import { api } from '../api/client.js';
import { caseBadge, mockBadge, statusBadge } from '../components/badges.js';
import { errorBox, loading, moneyPanel, timeline } from '../components/panels.js';
import { busy, confirmDialog, toast } from '../components/ui.js';
import { watchForUpdates } from '../components/watch.js';
import { dash, money, typeLabel, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

/** Shared by payment and case detail: run an action, then re-render with fresh server state. */
export async function raiseComplaintFlow(button, type, id, providerMode, after) {
  const choice = await confirmDialog({
    title: 'Raise UDIR complaint with the PSP?',
    body:
      providerMode === 'MOCK'
        ? 'This environment uses a mock PSP: the complaint is simulated and is NOT sent to a real PSP or NPCI.'
        : 'The PSP will raise a UDIR complaint for this transaction. We will track its progress automatically.',
    confirmLabel: 'Raise complaint',
  });
  if (!choice) return;
  const c = await busy(button, () => api.raiseComplaint(type, id, 'DEBITED_NOT_CREDITED'));
  if (c) {
    toast('UDIR complaint raised');
    after(c);
  }
}

export async function renderPaymentDetail(el, { params, navigate }) {
  const { type, id } = params;
  mount(el, loading());
  let d, events;
  try {
    [d, { events }] = await Promise.all([api.payment(type, id), api.timeline(type, id)]);
  } catch (e) {
    return mount(el, errorBox(e.status === 404 ? 'Payment not found.' : e.message));
  }
  const r = d.resolution;

  mount(
    el,
    html`<div class="page-head">
        <div>
          <div class="muted">${typeLabel(d.type)} payment · <span class="mono">${d.id}</span></div>
          <h1 class="num">${money(d.amountPaise)} ${statusBadge(d.merchantStatus, d.merchantStatusLabel)}</h1>
        </div>
        <div class="btn-row">
          ${d.actionsAllowed.includes('RECHECK') ? html`<button class="btn" id="recheck">Recheck now</button>` : ''}
          ${d.actionsAllowed.includes('RAISE_COMPLAINT') ? html`<button class="btn" id="complain">Raise UDIR complaint</button>` : ''}
        </div>
      </div>

      <div class="callout ${r.actionRequired ? 'warn' : 'info'}">
        <strong>${r.actionRequired ? 'Action needed' : 'What happens next'}</strong>${r.nextStep}
        ${r.openCase ? html` <a href="#/cases/${r.openCase.id}">View issue →</a>` : ''}
      </div>

      <section class="card mb">
        <h3>Customer money</h3>
        ${moneyPanel(d.money)}
      </section>

      <div class="grid grid-2">
        <section class="card">
          <h3>Payment</h3>
          <dl class="facts">
            <dt>Payment ID</dt><dd class="mono">${d.id}</dd>
            <dt>Order ID</dt><dd class="mono">${dash(d.orderId)}</dd>
            <dt>Type</dt><dd>${typeLabel(d.type)}</dd>
            <dt>Amount</dt><dd class="num">${money(d.amountPaise)}</dd>
            <dt>Created</dt><dd>${when(d.createdAt)}</dd>
            ${d.scheduledAt ? html`<dt>Scheduled for</dt><dd>${when(d.scheduledAt)}</dd>` : ''}
            <dt>Last update</dt><dd>${when(d.lastUpdatedAt)}</dd>
          </dl>
        </section>
        <section class="card">
          <h3>Transaction</h3>
          <dl class="facts">
            <dt>UPI reference (RRN)</dt><dd class="mono">${dash(d.upiRrn)}</dd>
            <dt>NPCI transaction ID</dt><dd class="mono">${dash(d.npciTxnId)}</dd>
            <dt>Payment provider</dt><dd>${dash(d.pspId)} ${mockBadge(d.providerMode)}</dd>
          </dl>
        </section>
        <section class="card">
          <h3>Resolution</h3>
          <dl class="facts">
            <dt>Verification</dt><dd>${r.verification.label}</dd>
            <dt>Open issue</dt><dd>${r.openCase ? html`<a href="#/cases/${r.openCase.id}">${r.openCase.id}</a> ${caseBadge(r.openCase.status, r.openCase.statusLabel)}` : 'None'}</dd>
            <dt>Merchant action</dt><dd>${r.actionRequired ? 'Required' : 'Not required'}</dd>
            ${d.complaintUnavailableReason ? html`<dt>UDIR complaint</dt><dd class="muted">${d.complaintUnavailableReason}</dd>` : ''}
          </dl>
        </section>
        <section class="card">
          <h3>What the customer sees</h3>
          <p class="m0">“${d.customerView.message}”</p>
        </section>
      </div>

      <section class="card mt">
        <h3>Timeline</h3>
        ${timeline(events)}
      </section>`,
  );

  const rerender = () => renderPaymentDetail(el, { params, navigate });
  watchForUpdates(el, {
    load: () => api.timeline(type, id),
    // Routine status checks aren't news; only meaningful events trigger the prompt.
    signature: (t) => JSON.stringify(t.events.filter((e) => e.type !== 'STATUS_CHECKED').map((e) => e.type)),
    settled: () => d.resolution.verification.code !== 'IN_PROGRESS' && !d.resolution.openCase,
    onRefresh: rerender,
  });
  el.querySelector('#recheck')?.addEventListener('click', async (e) => {
    const res = await busy(e.currentTarget, () => api.recheckPayment(type, id));
    if (res) {
      toast('Status rechecked with the payment provider');
      rerender();
    }
  });
  el.querySelector('#complain')?.addEventListener('click', (e) =>
    raiseComplaintFlow(e.currentTarget, type, id, d.providerMode, (c) => navigate(`#/cases/${c.id}`)),
  );
}
