import { api } from '../api/client.js';
import { statusBadge } from '../components/badges.js';
import { errorBox, loading } from '../components/panels.js';
import { toast } from '../components/ui.js';
import { dash, istDayEnd, istDayStart, money, rupeesToPaise, typeLabel, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

export const paymentHref = (p) => `#/payments/${p.type.toLowerCase()}/${encodeURIComponent(p.id)}`;

export function paymentRows(rows) {
  if (rows.length === 0) return html`<tr><td colspan="9" class="empty">No payments match.</td></tr>`;
  return html`${rows.map(
    (p) => html`<tr>
      <td>${when(p.createdAt)}</td>
      <td class="mono">${dash(p.orderId)}</td>
      <td class="mono">${p.id}</td>
      <td>${typeLabel(p.type)}</td>
      <td class="right num">${money(p.amountPaise)}</td>
      <td>${statusBadge(p.merchantStatus, p.merchantStatusLabel)}${p.caseId ? html` <a href="#/cases/${p.caseId}" title="Open issue">⚑</a>` : ''}</td>
      <td class="mono">${dash(p.upiRrn)}</td>
      <td>${dash(p.pspId)}</td>
      <td><a href="${paymentHref(p)}">View</a></td>
    </tr>`,
  )}`;
}

export const paymentTable = (rows) => html`<div class="table-wrap"><table>
  <thead><tr><th>Time</th><th>Order ID</th><th>Payment ID</th><th>Type</th><th class="right">Amount</th><th>Status</th><th>UPI ref</th><th>PSP</th><th></th></tr></thead>
  <tbody id="rows">${paymentRows(rows)}</tbody>
</table></div>`;

export async function renderPayments(el, { meta, query }) {
  const f = Object.fromEntries(query);
  const option = (value, label, current) => html`<option value="${value}" ${value === (current ?? '') ? 'selected' : ''}>${label}</option>`;

  mount(
    el,
    html`<div class="page-head"><h1>Payments</h1><span class="muted">Collect and AutoPay, newest first</span></div>
      <form class="filters card" id="filters">
        <label class="field">Status<select name="status">${option('', 'Any')}${meta.merchantStatuses.map((s) => option(s.code, s.label, f.status))}</select></label>
        <label class="field">Type<select name="type">${option('', 'Any')}${option('collect', 'Collect', f.type)}${option('autopay', 'AutoPay', f.type)}</select></label>
        <label class="field">PSP<select name="psp">${option('', 'Any')}${meta.psps.map((p) => option(p.id, p.id, f.psp))}</select></label>
        <label class="field">From<input type="date" name="fromDay" value="${f.fromDay ?? ''}" /></label>
        <label class="field">To<input type="date" name="toDay" value="${f.toDay ?? ''}" /></label>
        <label class="field">Min ₹<input name="min" inputmode="decimal" value="${f.min ?? ''}" /></label>
        <label class="field">Max ₹<input name="max" inputmode="decimal" value="${f.max ?? ''}" /></label>
        <label class="field">Order ID<input name="orderId" value="${f.orderId ?? ''}" /></label>
        <label class="field">Payment ID<input name="paymentId" value="${f.paymentId ?? ''}" /></label>
        <label class="field">UPI ref (12 digits)<input name="upiRrn" inputmode="numeric" pattern="\\d{12}" value="${f.upiRrn ?? ''}" /></label>
        <div class="btn-row"><button class="btn btn-primary">Apply</button><a class="btn" href="#/payments">Reset</a></div>
      </form>
      <div id="list">${loading()}</div>`,
  );

  el.querySelector('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v !== ''));
    location.hash = `#/payments${data.toString() ? `?${data}` : ''}`;
  });

  const params = {
    status: f.status,
    type: f.type,
    psp: f.psp,
    from: istDayStart(f.fromDay),
    to: istDayEnd(f.toDay),
    minAmount: f.min ? rupeesToPaise(f.min) : null,
    maxAmount: f.max ? rupeesToPaise(f.max) : null,
    orderId: f.orderId,
    paymentId: f.paymentId,
    upiRrn: f.upiRrn,
    limit: 25,
  };
  const list = el.querySelector('#list');
  let page;
  try {
    page = await api.payments(params);
  } catch (e) {
    return mount(list, errorBox(e.message));
  }
  mount(list, html`${paymentTable(page.data)}<div class="btn-row mt"><button class="btn" id="more" ${page.nextCursor ? '' : 'hidden'}>Load more</button></div>`);

  const more = list.querySelector('#more');
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      page = await api.payments({ ...params, cursor: page.nextCursor });
      if (page.data.length) list.querySelector('#rows').insertAdjacentHTML('beforeend', paymentRows(page.data).value);
      more.hidden = !page.nextCursor;
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      more.disabled = false;
    }
  });
}

export async function renderSearch(el, { query, navigate }) {
  const q = query.get('q') ?? '';
  mount(el, loading());
  let matches;
  try {
    ({ matches } = await api.search(q));
  } catch (e) {
    return mount(el, errorBox(e.message));
  }
  if (matches.length === 1) return navigate(paymentHref(matches[0]), { replace: true });
  mount(
    el,
    html`<div class="page-head"><h1>Search results</h1><span class="muted">for “${q}”</span></div>
      ${matches.length === 0
        ? html`<div class="card empty">No payment found. Try the 12-digit UPI reference from the customer's bank app, a payment ID, or your order ID.</div>`
        : paymentTable(matches)}`,
  );
}
