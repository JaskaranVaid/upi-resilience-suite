// Merchantflo ops console: kill switch, operational metrics and the audit log, for Merchantflo staff.
// Every value shown is escaped by html`` (shared with the merchant dashboard).
import { html, mount } from '/dashboard/lib/html.js';

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const res = await fetch(`/ops/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'x-ops-request': '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && path !== '/login' && path !== '/me/password') signedOut();
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? `Request failed (${res.status})`);
  }
  return data;
}

const api = {
  login: (email, password, code) => request('POST', '/login', { email, password, code }),
  logout: () => request('POST', '/logout'),
  me: () => request('GET', '/me'),
  metrics: () => request('GET', '/metrics'),
  audit: () => request('GET', '/audit?limit=200'),
  merchants: (q) => request('GET', `/merchants?q=${encodeURIComponent(q)}`),
  pauses: (include) => request('GET', `/pauses?include=${include}`),
  pause: (p) => request('POST', '/pauses', p),
  lift: (id) => request('POST', `/pauses/${encodeURIComponent(id)}/lift`),
  changePassword: (current, next) => request('POST', '/me/password', { current, next }),
};

const root = document.getElementById('app');
let me = null;
const canAct = () => me && (me.role === 'OWNER' || me.role === 'OPERATOR');

function toast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = error ? 'toast error' : 'toast';
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }) + ' IST' : '—');
const scopeLabel = (p) => (p.scope === 'GLOBAL' ? 'Everything' : `${p.scope === 'MERCHANT' ? 'Merchant' : 'PSP'} ${p.target}`);

function signedOut() {
  me = null;
  renderLogin();
}

function renderLogin() {
  mount(
    root,
    html`<main class="login">
      <form class="card" id="login-form">
        <div>
          <h1>Merchantflo Ops</h1>
          <p class="muted mt4">Staff only. Sign in with your password and the 6-digit code from your authenticator app.</p>
        </div>
        <label class="field">Email<input name="email" type="email" autocomplete="username" required /></label>
        <label class="field">Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <label class="field">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></label>
        <p id="login-error" class="error-text" role="alert"></p>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </main>`,
  );
  const form = root.querySelector('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      me = (await api.login(form.email.value, form.password.value, form.code.value.trim())).operator;
      location.hash = '#/pauses';
      route();
    } catch (err) {
      form.code.value = '';
      root.querySelector('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

const VIEWS = {
  pauses: { label: 'Kill switch', render: renderPauses },
  metrics: { label: 'Metrics', render: renderMetrics },
  audit: { label: 'Audit log', render: renderAudit },
  account: { label: 'Account', render: renderAccount },
};

async function route() {
  if (!me) {
    try {
      me = (await api.me()).operator;
    } catch {
      return renderLogin();
    }
  }
  const key = location.hash.replace(/^#\//, '') in VIEWS ? location.hash.replace(/^#\//, '') : 'pauses';
  const active = await api.pauses('active').catch(() => ({ data: [] }));
  mount(
    root,
    html`<div class="shell">
      <aside class="sidebar">
        <div class="brand">Merchantflo Ops<small>Internal operations console</small></div>
        <nav class="nav" aria-label="Main">
          ${Object.entries(VIEWS).map(([k, v]) => html`<a href="#/${k}" ${k === key ? html`aria-current="page"` : ''}>${v.label}</a>`)}
        </nav>
        <div class="me">
          <div>${me.name}</div>
          <div class="muted">${me.role.toLowerCase()}</div>
          <button class="btn mt8" id="logout">Sign out</button>
        </div>
      </aside>
      <div class="main">
        ${active.data.length
          ? html`<div class="ops-banner" role="alert"><strong>Paused</strong>${active.data.map(scopeLabel).join(' · ')}</div>`
          : html`<div class="ops-calm" role="note">No pauses in force — money movement is running normally.</div>`}
        <div class="content" id="view"></div>
      </div>
    </div>`,
  );
  root.querySelector('#logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    signedOut();
  });
  const view = root.querySelector('#view');
  try {
    await VIEWS[key].render(view);
  } catch (err) {
    if (err.status !== 401) mount(view, html`<div class="callout warn">${err.message}</div>`);
  }
}

async function renderPauses(el) {
  const [active, recent] = await Promise.all([api.pauses('active'), api.pauses('recent')]);
  const row = (p, withLift) => html`<tr>
    <td>${scopeLabel(p)}</td>
    <td>${p.reason}</td>
    <td class="mono">${p.createdBy ?? 'system'}</td>
    <td>${when(p.createdAt)}</td>
    <td>${p.liftedAt ? when(p.liftedAt) : withLift && canAct() ? html`<button class="btn" data-lift="${p.id}">Lift</button>` : 'in force'}</td>
  </tr>`;
  const table = (rows, withLift) =>
    rows.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Scope</th><th>Reason</th><th>By</th><th>Since</th><th>Lifted</th></tr></thead>
          <tbody>${rows.map((p) => row(p, withLift))}</tbody>
        </table></div>`
      : html`<p class="empty">None.</p>`;
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Kill switch</h2></div>
      <p class="muted">A pause stops <em>new</em> money movement in its scope: no new AutoPay debits or pre-debit notices, no new payments
        (the API answers 503 EXECUTION_PAUSED), and a paused PSP is skipped by routing. Nothing is cancelled — status checks,
        reconciliation and webhooks carry on, and debits that waited run once the pause is lifted.</p>
      ${canAct()
        ? html`<form class="card pause-form mt" id="pause-form">
            <label class="field">Scope<select name="scope">
              <option value="MERCHANT">One merchant</option>
              <option value="PSP">One PSP</option>
              <option value="GLOBAL">Everything</option>
            </select></label>
            <label class="field">Target<input name="target" list="merchant-list" autocomplete="off" placeholder="Merchant id, PSP connection id or provider:cashfree" /></label>
            <datalist id="merchant-list"></datalist>
            <label class="field wide">Reason (recorded in the audit log)<input name="reason" required maxlength="500" /></label>
            <div class="wide btn-row"><button class="btn btn-danger" type="submit">Pause</button></div>
          </form>`
        : html`<div class="callout info mt">Your role can view pauses but not change them.</div>`}
      <h3 class="mt">In force</h3>
      ${table(active.data, true)}
      <h3 class="mt">Recent</h3>
      ${table(recent.data.filter((p) => p.liftedAt), false)}`,
  );

  el.querySelectorAll('[data-lift]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Lift this pause? Waiting debits and payments will continue.')) return;
      btn.disabled = true;
      try {
        await api.lift(btn.dataset.lift);
        toast('Pause lifted');
        route();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, { error: true });
      }
    }),
  );

  const form = el.querySelector('#pause-form');
  if (!form) return;
  const syncTarget = () => {
    form.target.disabled = form.scope.value === 'GLOBAL';
    form.target.required = form.scope.value !== 'GLOBAL';
  };
  form.scope.addEventListener('change', syncTarget);
  syncTarget();
  form.target.addEventListener('input', async () => {
    if (form.scope.value !== 'MERCHANT' || form.target.value.length < 2) return;
    const { data } = await api.merchants(form.target.value).catch(() => ({ data: [] }));
    mount(el.querySelector('#merchant-list'), html`${data.map((m) => html`<option value="${m.id}">${m.name} (${m.mode})</option>`)}`);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = form.scope.value;
    const what = scope === 'GLOBAL' ? 'ALL money movement for every merchant' : `${scope.toLowerCase()} ${form.target.value}`;
    if (!confirm(`Pause ${what}?`)) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.pause({ scope, ...(scope === 'GLOBAL' ? {} : { target: form.target.value.trim() }), reason: form.reason.value.trim() });
      toast('Paused');
      route();
    } catch (err) {
      btn.disabled = false;
      toast(err.message, { error: true });
    }
  });
}

const METRICS = [
  ['restrictedWindowExecutions', 'Restricted-window executions (15 min)', 'must be 0'],
  ['executionPausesActive', 'Pauses in force'],
  ['noticeFailures', 'Pre-debit notice failures (1 h)'],
  ['debitBacklog', 'Debit backlog'],
  ['pollerBacklog', 'Status-check backlog'],
  ['pollerOldestOverdueSeconds', 'Oldest overdue status check (s)'],
  ['webhookBacklog', 'Webhook backlog'],
  ['deadWebhooks24h', 'Dead webhooks (24 h)'],
  ['reconFailures24h', 'Reconciliation failures (24 h)'],
  ['pspCircuitsOpen', 'PSP circuits open (this instance)'],
];

async function renderMetrics(el) {
  const m = await api.metrics();
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Metrics</h2></div>
      <p class="muted">Live values of the numbers the CloudWatch alarms watch (docs/runbooks/alerts.md).</p>
      <div class="kpis mt">
        ${METRICS.map(([k, label, note]) => html`<div class="kpi ${m[k] > 0 ? 'alert' : ''}"><div class="value num">${m[k]}</div><div class="label">${label}${note ? html` <span class="muted">(${note})</span>` : ''}</div></div>`)}
      </div>
      ${m.openCircuits.length ? html`<p class="mt">Open circuits: <span class="mono">${m.openCircuits.join(', ')}</span></p>` : ''}`,
  );
}

async function renderAudit(el) {
  const { data } = await api.audit();
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Audit log</h2></div>
      <p class="muted">Every sign-in and operator action, newest first.</p>
      ${data.length
        ? html`<div class="table-wrap mt"><table>
            <thead><tr><th>When</th><th>Action</th><th>Operator</th><th>Target</th><th>Details</th></tr></thead>
            <tbody>${data.map(
              (a) => html`<tr>
                <td>${when(a.createdAt)}</td>
                <td class="mono">${a.action}</td>
                <td>${a.operatorEmail ?? 'system / CLI'}</td>
                <td class="mono">${a.target ?? ''}</td>
                <td>${a.details ? html`<pre class="details">${JSON.stringify(a.details)}</pre>` : ''}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
        : html`<p class="empty">Nothing yet.</p>`}`,
  );
}

async function renderAccount(el) {
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Account</h2></div>
      <dl class="facts card">
        <dt>Name</dt><dd>${me.name}</dd>
        <dt>Email</dt><dd>${me.email}</dd>
        <dt>Role</dt><dd>${me.role}</dd>
        <dt>Last sign-in</dt><dd>${when(me.lastLoginAt)}</dd>
      </dl>
      <form class="card mt" id="password-form">
        <h3 class="m0">Change password</h3>
        <label class="field">Current password<input name="current" type="password" autocomplete="current-password" required /></label>
        <label class="field">New password (at least 14 characters)<input name="next" type="password" autocomplete="new-password" minlength="14" required /></label>
        <p class="error-text" role="alert" id="password-error"></p>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Change password</button></div>
        <p class="muted">Changing it signs out your other sessions. A lost authenticator is reset by an owner with <span class="mono">npm run ops:operator -- reset-2fa</span>.</p>
      </form>`,
  );
  const form = el.querySelector('#password-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.changePassword(form.current.value, form.next.value);
      form.reset();
      el.querySelector('#password-error').textContent = '';
      toast('Password changed');
    } catch (err) {
      el.querySelector('#password-error').textContent = err.message;
    }
  });
}

window.addEventListener('hashchange', route);
route();
