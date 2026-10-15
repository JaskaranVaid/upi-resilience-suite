import { api } from '../api/client.js';
import { errorBox, forbidden, loading } from '../components/panels.js';
import { busy, toast } from '../components/ui.js';
import { dash, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

const DELIVERY_TONES = { delivered: 'good', pending: 'neutral', failed: 'bad' };
const DELIVERY_LABELS = { delivered: 'Delivered', pending: 'Pending', failed: 'Failed' };

const deliveryRow = (d) => html`<tr data-id="${d.id}">
  <td>${when(d.createdAt)}</td>
  <td><details class="payload"><summary class="mono">${d.event}</summary><div class="muted mono">${d.id}</div><pre class="mono">${JSON.stringify(d.data, null, 2)}</pre></details></td>
  <td><span class="badge tone-${DELIVERY_TONES[d.status]}">${DELIVERY_LABELS[d.status]}</span></td>
  <td class="right num">${d.attempts}</td>
  <td>${d.status === 'delivered' ? when(d.deliveredAt) : dash(d.lastError)}</td>
  <td>${d.status === 'pending' ? '' : html`<button class="btn" data-redeliver>Redeliver</button>`}</td>
</tr>`;

/** Developers (admins): how to integrate, API keys, PSP connections, and the webhook delivery log. */
export async function renderDevelopers(el, { me, query, navigate }) {
  if (me.user.role !== 'ADMIN') return mount(el, forbidden());
  mount(el, loading());
  const status = query.get('status') ?? '';
  let info, keys, connections, page;
  try {
    [info, { data: keys }, { data: connections }, page] = await Promise.all([
      api.developers(),
      api.apiKeys(),
      api.pspConnections(),
      api.webhookDeliveries({ status, limit: 25 }),
    ]);
  } catch (e) {
    return mount(el, errorBox(e.message));
  }
  const option = (value, label) => html`<option value="${value}" ${value === status ? 'selected' : ''}>${label}</option>`;

  mount(
    el,
    html`<div class="page-head"><h1>Developers</h1><span class="muted">${info.mode === 'TEST' ? 'Test mode' : 'Live mode'}</span></div>
      <section class="card mb">
        <h2>Integration</h2>
        <dl class="facts">
          <dt>API base URL</dt><dd class="mono">${info.apiBase || location.origin}</dd>
          <dt>Webhook URL</dt><dd class="mono">${info.webhookUrl ?? 'Not set — set it with PATCH /v1/merchants/me'}</dd>
          <dt>Reference</dt><dd><a href="${info.docsPath}" target="_blank" rel="noopener">API reference</a> · <a href="${info.openapiPath}" target="_blank" rel="noopener">OpenAPI document</a> · <a href="/checkout/demo.html" target="_blank" rel="noopener">checkout.js demo</a></dd>
        </dl>
      </section>

      <section class="mb">
        <h2>API keys</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th>Status</th></tr></thead>
          <tbody>${keys.map(
            (k) => html`<tr><td class="mono">${k.prefix}…</td><td>${dash(k.label)}</td><td>${when(k.createdAt)}</td><td>${when(k.lastUsedAt)}</td>
              <td>${k.revokedAt ? html`<span class="badge tone-neutral">Revoked</span>` : html`<span class="badge tone-good">Active</span>`}</td></tr>`,
          )}</tbody>
        </table></div>
        <p class="muted">Create and revoke keys with the API (POST /v1/api-keys). A key is shown only once, when created.</p>
      </section>

      <section class="mb">
        <h2>PSP connections</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Provider</th><th>Label</th><th>Environment</th><th>Credentials</th><th>Priority</th><th>Status</th></tr></thead>
          <tbody>${connections.length === 0
            ? html`<tr><td colspan="6" class="empty">No connections of your own yet — payments use the shared test PSPs.</td></tr>`
            : connections.map(
                (c) => html`<tr><td>${c.provider}</td><td>${dash(c.label)}</td><td>${c.environment}</td><td class="mono">${dash(c.credentialHint)}</td><td class="right num">${c.priority}</td>
                  <td><span class="badge tone-${c.status === 'ACTIVE' ? 'good' : 'neutral'}">${c.status === 'ACTIVE' ? 'Active' : 'Disabled'}</span></td></tr>`,
              )}</tbody>
        </table></div>
      </section>

      <section>
        <div class="page-head"><h2>Webhook deliveries</h2>
          <label class="field">Status<select id="status">${option('', 'Any')}${option('failed', 'Failed')}${option('pending', 'Pending')}${option('delivered', 'Delivered')}</select></label>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Created</th><th>Event (open for id and payload)</th><th>Status</th><th class="right">Attempts</th><th>Delivered / last error</th><th></th></tr></thead>
          <tbody id="deliveries">${page.data.length === 0 ? html`<tr><td colspan="6" class="empty">No webhooks yet.</td></tr>` : page.data.map(deliveryRow)}</tbody>
        </table></div>
        <div class="btn-row mt8">${page.nextBefore ? html`<button class="btn" id="more">Load older</button>` : ''}</div>
        <p class="muted">Redelivering sends the same event (same id — your handler can skip ids it has seen) signed with your current secret.</p>
      </section>`,
  );

  el.querySelector('#status').addEventListener('change', (e) => navigate(`#/developers${e.target.value ? `?status=${e.target.value}` : ''}`));

  const wire = (root) =>
    root.querySelectorAll('[data-redeliver]').forEach((b) =>
      b.addEventListener('click', async () => {
        const tr = b.closest('tr');
        const ok = await busy(b, () => api.redeliverWebhook(tr.dataset.id));
        if (ok) {
          toast('Queued for redelivery');
          renderDevelopers(el, { me, query, navigate });
        }
      }),
    );
  wire(el);

  let before = page.nextBefore;
  el.querySelector('#more')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const next = await busy(button, () => api.webhookDeliveries({ status, limit: 25, before }));
    if (!next) return;
    const tbody = el.querySelector('#deliveries');
    const tmp = document.createElement('tbody');
    mount(tmp, html`${next.data.map(deliveryRow)}`);
    wire(tmp);
    tbody.append(...tmp.children);
    before = next.nextBefore;
    if (!before) button.remove();
  });
}
