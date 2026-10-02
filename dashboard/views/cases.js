import { api } from '../api/client.js';
import { caseBadge, mockBadge } from '../components/badges.js';
import { errorBox, loading, moneyPanel, timeline } from '../components/panels.js';
import { busy, confirmDialog, toast } from '../components/ui.js';
import { watchForUpdates } from '../components/watch.js';
import { dash, money, typeLabel, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';
import { raiseComplaintFlow } from './payment-detail.js';
import { paymentHref } from './payments.js';

const TABS = ['NEEDS_ACTION', 'INVESTIGATING', 'VERIFICATION_PENDING', 'REVERSAL_PENDING', 'RESOLVED'];

export async function renderCases(el, { meta, query }) {
  const status = query.get('status') ?? 'NEEDS_ACTION';
  mount(el, loading());
  let r;
  try {
    r = await api.cases({ status, limit: 50 });
  } catch (e) {
    return mount(el, errorBox(e.message));
  }
  const label = (code) => meta.caseStatuses.find((s) => s.code === code)?.label ?? code;

  mount(
    el,
    html`<div class="page-head"><h1>Dispute Desk</h1><span class="muted">Payments that need attention or are being resolved</span></div>
      <nav class="tabs" aria-label="Issue status">
        ${TABS.map((t) => html`<a href="#/cases?status=${t}" ${t === status ? html`aria-current="page"` : ''}>${label(t)}<span class="count">${r.counts[t] ?? 0}</span></a>`)}
      </nav>
      <div class="table-wrap"><table>
        <thead><tr><th>Opened</th><th>Issue</th><th>Status</th><th>Order ID</th><th>Payment</th><th>UPI ref</th><th class="right">Amount</th><th>PSP</th><th></th></tr></thead>
        <tbody>
          ${r.data.length === 0
            ? html`<tr><td colspan="9" class="empty">${status === 'NEEDS_ACTION' ? 'Nothing needs action. 🎉' : 'No issues here.'}</td></tr>`
            : r.data.map(
                (c) => html`<tr>
                  <td>${when(c.openedAt)}</td>
                  <td>${c.reasonLabel}</td>
                  <td>${caseBadge(c.status, c.statusLabel)}</td>
                  <td class="mono">${dash(c.payment.orderId)}</td>
                  <td><a class="mono" href="${paymentHref(c.payment)}">${c.payment.id}</a></td>
                  <td class="mono">${dash(c.payment.upiRrn)}</td>
                  <td class="right num">${money(c.payment.amountPaise)}</td>
                  <td>${dash(c.payment.pspId)}</td>
                  <td><a href="#/cases/${c.id}">Investigate</a></td>
                </tr>`,
              )}
        </tbody>
      </table></div>`,
  );
}

export async function renderCaseDetail(el, { params }) {
  mount(el, loading());
  let c;
  try {
    c = await api.case(params.id);
  } catch (e) {
    return mount(el, errorBox(e.status === 404 ? 'Issue not found.' : e.message));
  }
  draw(c);

  function draw(c) {
    const p = c.payment;
    const can = (a) => c.actionsAllowed.includes(a);
    const type = p.type.toLowerCase();
    mount(
      el,
      html`<div class="page-head">
          <div>
            <div class="muted">Issue · <span class="mono">${c.id}</span></div>
            <h1>${c.reasonLabel} ${caseBadge(c.status, c.statusLabel)}</h1>
          </div>
          <div class="btn-row">
            ${can('RECHECK') ? html`<button class="btn" id="recheck">Recheck now</button>` : ''}
            ${can('RAISE_COMPLAINT') ? html`<button class="btn" id="complain">Raise UDIR complaint</button>` : ''}
            ${can('CLOSE') ? html`<button class="btn" id="close">Mark resolved…</button>` : ''}
          </div>
        </div>

        <div class="callout ${c.actionRequired ? 'warn' : 'info'}">
          <strong>${c.actionRequired ? 'Action needed' : c.status === 'RESOLVED' ? 'Resolved' : 'No action needed right now'}</strong>
          ${c.status === 'RESOLVED' ? c.resolutionLabel : p.resolution.nextStep}
        </div>

        <section class="card mb">
          <h3>What happened to the customer's money</h3>
          ${moneyPanel(p.money)}
        </section>

        <div class="grid grid-3">
          <section class="card">
            <h3>Issue</h3>
            <dl class="facts">
              <dt>Issue ID</dt><dd class="mono">${c.id}</dd>
              <dt>Status</dt><dd>${c.statusLabel}</dd>
              <dt>Opened</dt><dd>${when(c.openedAt)}</dd>
              ${c.resolvedAt ? html`<dt>Resolved</dt><dd>${when(c.resolvedAt)} · ${c.resolutionLabel}</dd>` : ''}
            </dl>
          </section>
          <section class="card">
            <h3>Order & payment</h3>
            <dl class="facts">
              <dt>Order ID</dt><dd class="mono">${dash(p.orderId)}</dd>
              <dt>Amount</dt><dd class="num">${money(p.amountPaise)}</dd>
              <dt>Payment</dt><dd><a class="mono" href="${paymentHref(p)}">${p.id}</a> · ${typeLabel(p.type)}</dd>
            </dl>
          </section>
          <section class="card">
            <h3>Transaction</h3>
            <dl class="facts">
              <dt>UPI ref (RRN)</dt><dd class="mono">${dash(p.upiRrn)}</dd>
              <dt>NPCI txn ID</dt><dd class="mono">${dash(p.npciTxnId)}</dd>
              <dt>PSP</dt><dd>${dash(p.pspId)} ${mockBadge(p.providerMode)}</dd>
            </dl>
          </section>
        </div>

        <section class="card mt">
          <h3>UDIR complaints</h3>
          ${c.complaints.length === 0
            ? html`<p class="muted m0">No complaint raised.${p.complaintUnavailableReason ? html` ${p.complaintUnavailableReason}.` : ''}</p>`
            : html`<div class="table-wrap"><table>
                <thead><tr><th>Reference</th><th>Status</th><th>Raised</th><th>By</th><th>Last update</th><th>Mode</th></tr></thead>
                <tbody>${c.complaints.map(
                  (x) => html`<tr><td class="mono">${x.reference}</td><td>${x.statusLabel}</td><td>${when(x.raisedAt)}</td>
                    <td>${dash(x.raisedBy)}</td><td>${when(x.lastStatusAt)}</td>
                    <td>${x.mode === 'LIVE' ? x.modeLabel : html`<span class="badge tone-mock" title="${x.modeLabel}">${x.mode === 'MOCK' ? 'Simulated' : 'Sandbox'}</span>`}</td></tr>`,
                )}</tbody></table></div>`}
        </section>

        <div class="grid grid-2 mt">
          <section class="card">
            <h3>Internal notes</h3>
            ${c.notes.length === 0 ? html`<p class="muted">No notes yet.</p>` : html`<ul class="notes">${c.notes.map((n) => html`<li>${n.body}<div class="when muted">${n.author} · ${when(n.createdAt)}</div></li>`)}</ul>`}
            ${can('ADD_NOTE')
              ? html`<form id="note-form" class="grid"><label class="field">Add a note (visible to your team only)<textarea name="body" required maxlength="4000"></textarea></label>
                  <div class="btn-row"><button class="btn btn-primary">Add note</button></div></form>`
              : ''}
          </section>
          <section class="card">
            <h3>Timeline</h3>
            ${timeline(c.timeline)}
          </section>
        </div>`,
    );

    watchForUpdates(el, {
      load: () => api.case(c.id),
      signature: (x) => JSON.stringify([x.status, x.timeline.filter((e) => e.type !== 'STATUS_CHECKED').length, x.complaints.map((k) => k.status), x.notes.length]),
      settled: (x) => x.status === 'RESOLVED',
      onRefresh: async () => draw(await api.case(c.id)),
    });

    el.querySelector('#recheck')?.addEventListener('click', async (e) => {
      const fresh = await busy(e.currentTarget, () => api.recheckCase(c.id));
      if (fresh) {
        toast('Status rechecked with the payment provider');
        draw(fresh);
      }
    });
    el.querySelector('#complain')?.addEventListener('click', (e) => raiseComplaintFlow(e.currentTarget, type, p.id, p.providerMode, draw));
    el.querySelector('#close')?.addEventListener('click', async (e) => {
      const choice = await confirmDialog({
        title: 'Mark this issue resolved?',
        body: 'Use this when you have handled it outside the system (for example, fulfilled the order). Explain what you did.',
        confirmLabel: 'Mark resolved',
        noteLabel: 'What was done',
      });
      if (!choice) return;
      const fresh = await busy(e.currentTarget, () => api.closeCase(c.id, choice.note));
      if (fresh) {
        toast('Issue resolved');
        draw(fresh);
      }
    });
    el.querySelector('#note-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = e.target.body.value.trim();
      if (!body) return;
      const fresh = await busy(e.target.querySelector('button'), () => api.addNote(c.id, body));
      if (fresh) draw(fresh);
    });
  }
}
