// Merchantflo ops console: kill switch, pilots, operational metrics and the audit log, for Merchantflo staff.
// Every value shown is escaped by html`` (shared with the merchant dashboard).
import { ApiError } from '/dashboard/api/client.js';
import { busy, confirmDialog, toast } from '/dashboard/components/ui.js';
import { money } from '/dashboard/lib/format.js';
import { html, mount } from '/dashboard/lib/html.js';

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
  erase: (body) => request('POST', '/privacy/erasure', body),
  pilots: () => request('GET', '/pilots'),
  pilot: (id, month) => request('GET', `/pilots/${encodeURIComponent(id)}?month=${encodeURIComponent(month)}`),
  changeStage: (id, body) => request('POST', `/pilots/${encodeURIComponent(id)}/stage`, body),
  duplicates: (status) => request('GET', `/duplicates${status ? `?status=${status}` : ''}`),
  resolveDuplicate: (id, resolution, note) => request('POST', `/duplicates/${encodeURIComponent(id)}/resolve`, { resolution, note }),
};

const root = document.getElementById('app');
let me = null;
const canAct = () => me && (me.role === 'OWNER' || me.role === 'OPERATOR');

/** Merchant-id suggestions for an input with a datalist, asked for once typing pauses. */
function suggestMerchants(input, datalist, enabled = () => true) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!enabled() || input.value.length < 2) return;
    timer = setTimeout(async () => {
      const { data } = await api.merchants(input.value).catch(() => ({ data: [] }));
      mount(datalist, html`${data.map((m) => html`<option value="${m.id}">${m.name} (${m.mode})</option>`)}`);
    }, 200);
  });
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
  pilots: { label: 'Pilots', render: renderPilots },
  duplicates: { label: 'Duplicates', render: renderDuplicates },
  metrics: { label: 'Metrics', render: renderMetrics },
  audit: { label: 'Audit log', render: renderAudit },
  privacy: { label: 'Data erasure', render: renderPrivacy },
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
  // #/<view>, or #/<view>/<id> for one item (a pilot).
  const [requested, param] = location.hash.replace(/^#\//, '').split('/').map(decodeURIComponent);
  const key = requested in VIEWS ? requested : 'pauses';
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
    await VIEWS[key].render(view, { active: active.data, param });
  } catch (err) {
    if (err.status !== 401) mount(view, html`<div class="callout warn">${err.message}</div>`);
  }
}

async function renderPauses(el, { active }) {
  const recent = await api.pauses('recent');
  const row = (p) => html`<tr>
    <td>${scopeLabel(p)}</td>
    <td>${p.reason}</td>
    <td class="mono">${p.createdBy ?? 'system'}</td>
    <td>${when(p.createdAt)}</td>
    <td>${p.liftedAt ? when(p.liftedAt) : canAct() ? html`<button class="btn" data-lift="${p.id}">Lift</button>` : 'in force'}</td>
  </tr>`;
  const table = (rows) =>
    rows.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Scope</th><th>Reason</th><th>By</th><th>Since</th><th>Lifted</th></tr></thead>
          <tbody>${rows.map(row)}</tbody>
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
      ${table(active)}
      <h3 class="mt">Recent</h3>
      ${table(recent.data.filter((p) => p.liftedAt))}`,
  );

  el.querySelectorAll('[data-lift]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Lift this pause? Waiting debits and payments will continue.')) return;
      if (await busy(btn, () => api.lift(btn.dataset.lift))) {
        toast('Pause lifted');
        route();
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
  suggestMerchants(form.target, el.querySelector('#merchant-list'), () => form.scope.value === 'MERCHANT');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const scope = form.scope.value;
    const what = scope === 'GLOBAL' ? 'ALL money movement for every merchant' : `${scope.toLowerCase()} ${form.target.value}`;
    if (!confirm(`Pause ${what}?`)) return;
    const body = { scope, ...(scope === 'GLOBAL' ? {} : { target: form.target.value.trim() }), reason: form.reason.value.trim() };
    if (await busy(form.querySelector('button'), () => api.pause(body))) {
      toast('Paused');
      route();
    }
  });
}

const STAGE_TONE = { SHADOW: 'info', CANARY: 'warn', FULL: 'good' };
const STATUS_TONE = { PASS: 'good', FAIL: 'bad', PENDING: 'warn', NO_DATA: 'neutral' };
const stageBadge = (stage, percent) => html`<span class="badge tone-${STAGE_TONE[stage]}">${stage}${stage === 'CANARY' ? ` ${percent}%` : ''}</span>`;
const pct = (x, digits = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
/** A difference of two rates, in percentage points. */
const pp = (x) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)} pp`);
const istMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);

async function renderPilots(el, { param }) {
  if (param) return renderPilot(el, param);
  const { data } = await api.pilots();
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Pilots</h2></div>
      <p class="muted">Merchants moving from shadow (their own system executes; Merchantflo only plans) through a canary slice of mandates to
        full execution, and any merchant with a stage history. Every other merchant is FULL. Playbook: docs/runbooks/pilot.md.</p>
      ${data.length
        ? html`<div class="table-wrap mt"><table>
            <thead><tr><th>Merchant</th><th>Mode</th><th>Stage</th><th>Since</th><th class="right">Unreviewed suspects</th></tr></thead>
            <tbody>${data.map(
              (p) => html`<tr>
                <td><a href="#/pilots/${encodeURIComponent(p.merchantId)}">${p.name}</a> <span class="muted mono">${p.merchantId}</span></td>
                <td>${p.mode}</td>
                <td>${stageBadge(p.stage, p.canaryPercent)}</td>
                <td>${when(p.since)}</td>
                <td class="right">${p.openSuspects ? html`<span class="badge tone-bad">${p.openSuspects}</span>` : '0'}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
        : html`<p class="empty">No merchant is in a pilot. A merchant's first switch to live mode puts it in SHADOW.</p>`}`,
  );
}

/** The numbers behind one scorecard criterion, in a line. */
function criterionFigures(c) {
  const d = c.details;
  switch (c.key) {
    case 'doubleDebits':
      return `${d.open} unreviewed · ${d.confirmed} confirmed · ${d.dismissed} dismissed`;
    case 'restrictedWindowExecutions':
      return `${d.count} execution${d.count === 1 ? '' : 's'}`;
    case 'autopayUplift':
      return d.canary.n && d.control.n
        ? `canary ${d.canary.succeeded}/${d.canary.n} (${pct(d.canary.rate)}) vs control ${d.control.succeeded}/${d.control.n} (${pct(d.control.rate)}): ${pp(d.difference)} (95%: ${pp(d.low)} to ${pp(d.high)})`
        : `canary ${d.canary.n} · control ${d.control.n} final outcomes`;
    case 'webhooksOnTime':
      return d.judged ? `${d.onTime}/${d.judged} on time (${pct(d.share, 2)}) · ${d.failed} failed` : 'no webhooks to judge';
    case 'statementReconciles':
      return `${d.reconciled}/${d.payments} settled · ${d.awaiting} within grace · ${d.overdue} overdue · ${d.mismatched} mismatched · ${d.unverifiable} unverifiable value events`;
    default:
      return '';
  }
}

async function renderPilot(el, merchantId, month = istMonth()) {
  const p = await api.pilot(merchantId, month);
  const { merchant: m, rollout, next, scorecard, report } = p;
  const canOverride = me.role === 'OWNER';
  const csvHref = `/ops/api/pilots/${encodeURIComponent(m.id)}/report.csv?month=${encodeURIComponent(month)}`;
  mount(
    el,
    html`<p class="m0"><a href="#/pilots">← Pilots</a></p>
      <div class="page-head mt">
        <h2 class="m0">${m.name} ${stageBadge(rollout.stage, rollout.canaryPercent)}</h2>
        <label class="field inline">Month<input type="month" id="pilot-month" value="${month}" /></label>
      </div>
      <p class="muted"><span class="mono">${m.id}</span> · ${m.mode} mode · stage since ${when(rollout.since)}${m.hasWebhookUrl ? '' : ' · no webhook URL'}</p>

      ${next === null
        ? html`<div class="callout info">Merchantflo executes every debit of this merchant (FULL).</div>`
        : next.problems.length
          ? html`<div class="callout warn"><strong>Not ready for ${next.stage}${next.canaryPercent ? ` ${next.canaryPercent}%` : ''}</strong>
              <ul class="m0">${next.problems.map((x) => html`<li>${x}</li>`)}</ul></div>`
          : html`<div class="callout info"><strong>Ready for ${next.stage}${next.canaryPercent ? ` ${next.canaryPercent}%` : ''}</strong>Every gate passes; a person still decides.</div>`}

      ${canAct()
        ? html`<form class="card pause-form stage-form" id="stage-form">
            <label class="field">Stage<select name="stage">
              ${['SHADOW', 'CANARY', 'FULL'].map((s) => html`<option value="${s}" ${s === (next?.stage ?? rollout.stage) ? html`selected` : ''}>${s}</option>`)}
            </select></label>
            <label class="field">Canary % of mandates<input name="canaryPercent" type="number" min="1" max="99" step="1" value="${rollout.canaryPercent ?? next?.canaryPercent ?? 5}" /></label>
            <label class="field wide">Reason (kept in the pilot history and the audit log)<input name="reason" required maxlength="500" /></label>
            ${canOverride ? html`<label class="wide check"><input type="checkbox" name="override" /> Override failed gates (owner; recorded with what was overridden)</label>` : ''}
            <div class="wide btn-row"><button class="btn btn-primary" type="submit">Change stage</button></div>
            <p class="wide muted m0">Moving back (rollback) is always allowed and affects new debit requests only: debits already accepted for Merchantflo still run — use the kill switch to stop those.</p>
          </form>`
        : ''}

      <h3 class="mt">Scorecard — ${scorecard.period.label}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Criterion</th><th>Bar</th><th>Status</th><th>Figures</th></tr></thead>
        <tbody>${scorecard.criteria.map(
          (c) => html`<tr>
            <td title="${c.methodNote}">${c.label}${c.gated ? '' : html` <span class="muted">(reported, not gated)</span>`}</td>
            <td class="wrap narrow">${c.target}</td>
            <td><span class="badge tone-${STATUS_TONE[c.status]}">${c.status.replace('_', ' ')}</span></td>
            <td class="wrap">${criterionFigures(c)}</td>
          </tr>`,
        )}</tbody>
      </table></div>
      <details class="mt"><summary>How each criterion is measured</summary>
        <dl class="facts mt">${scorecard.criteria.map((c) => html`<dt>${c.label}</dt><dd>${c.methodNote}</dd>`)}</dl>
      </details>

      <div class="page-head mt"><h3 class="m0">Shadow report — what Merchantflo would have saved</h3><a class="btn" href="${csvHref}" download>Download rows (CSV)</a></div>
      <div class="kpis">
        <div class="kpi"><div class="value num">${money(report.certainPaise)}</div><div class="label">Certain value</div></div>
        <div class="kpi"><div class="value num">${money(report.potentialPaise)}</div><div class="label">Potential value (upper bound)</div></div>
        <div class="kpi"><div class="value num">${report.estimate ? money(report.estimate.amountPaise) : '—'}</div><div class="label">${report.estimate ? `Estimate (${pct(report.estimate.recoveryRate, 0)} recovery, n=${report.estimate.sample})` : 'No estimate yet (too little live traffic)'}</div></div>
        <div class="kpi"><div class="value num">${pct(report.observed.successRate)}</div><div class="label">Observed success (${report.observed.count} executions)</div></div>
        <div class="kpi"><div class="value num">${pct(report.projectedSuccessRate.atLeast)}–${pct(report.projectedSuccessRate.atMost)}</div><div class="label">Projected success with Merchantflo</div></div>
        <div class="kpi ${report.awaitingOutcome ? 'attention' : ''}"><div class="value num">${pct(report.outcomeCoverage, 0)}</div><div class="label">Outcome coverage (${report.awaitingOutcome} awaiting)</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>What Merchantflo would have done</th><th class="right">Executions</th><th class="right">Amount</th><th>Value</th></tr></thead>
        <tbody>${report.classes.map(
          (c) => html`<tr><td class="wrap" title="${c.methodNote}">${c.label}</td><td class="right num">${c.count}</td><td class="right num">${money(c.amountPaise)}</td><td>${c.value.toLowerCase()}</td></tr>`,
        )}</tbody>
      </table></div>
      <p class="muted">${report.coverageNote}</p>

      <h3 class="mt">Suspected double debits</h3>
      ${duplicatesTable(p.duplicates, { showMerchant: false })}

      <h3 class="mt">Stage history</h3>
      ${p.history.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>${p.history.map(
              (h) => html`<tr>
                <td>${when(h.createdAt)}</td>
                <td>${stageBadge(h.fromStage, h.fromPercent)}</td>
                <td>${stageBadge(h.toStage, h.toPercent)}${h.override ? html` <span class="badge tone-bad">override</span>` : ''}</td>
                <td class="wrap">${h.reason}</td>
                <td class="mono">${h.operatorId ?? 'system'}</td>
              </tr>`,
            )}</tbody>
          </table></div>`
        : html`<p class="empty">No changes yet.</p>`}`,
  );

  el.querySelector('#pilot-month').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}$/.test(e.target.value)) renderPilot(el, merchantId, e.target.value).catch((err) => toast(err.message, { error: true }));
  });
  bindResolve(el, () => renderPilot(el, merchantId, month));

  const form = el.querySelector('#stage-form');
  if (!form) return;
  const syncPercent = () => {
    form.canaryPercent.disabled = form.stage.value !== 'CANARY';
  };
  form.stage.addEventListener('change', syncPercent);
  syncPercent();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const stage = form.stage.value;
    const body = {
      stage,
      ...(stage === 'CANARY' ? { canaryPercent: Number(form.canaryPercent.value) } : {}),
      reason: form.reason.value.trim(),
      ...(form.override?.checked ? { override: true } : {}),
    };
    const target = `${stage}${stage === 'CANARY' ? ` ${body.canaryPercent}%` : ''}`;
    if (!confirm(`Move ${m.name} to ${target}? New debit requests follow the new stage at once.`)) return;
    if (await busy(form.querySelector('button'), () => api.changeStage(m.id, body))) {
      toast(`${m.name} is now ${target}`);
      renderPilot(el, merchantId, month);
    }
  });
}

/** Suspected double debits, with Confirm / Dismiss for roles that can act on open ones. */
function duplicatesTable(rows, { showMerchant }) {
  const side = (s) => html`${s.kind === 'DEBIT' ? 'Merchantflo' : 'Merchant'}<br /><span class="mono small">${s.id}</span><br /><span class="muted">${when(s.at)}</span>`;
  return rows.length
    ? html`<div class="table-wrap"><table>
        <thead><tr><th>Detected</th>${showMerchant ? html`<th>Merchant</th>` : ''}<th>Mandate</th><th class="right">Amount</th><th>First</th><th>Second</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(
          (s) => html`<tr>
            <td class="wrap narrow">${when(s.detectedAt)}</td>
            ${showMerchant ? html`<td><a href="#/pilots/${encodeURIComponent(s.merchantId)}">${s.merchantName ?? s.merchantId}</a></td>` : ''}
            <td class="mono">${s.mandateRef}${s.sameOrder ? html` <span class="badge tone-bad">same order</span>` : ''}</td>
            <td class="right num">${money(s.amountPaise)}</td>
            <td class="wrap narrow">${side(s.first)}</td>
            <td class="wrap narrow">${side(s.second)}</td>
            <td><span class="badge tone-${s.status === 'OPEN' ? 'bad' : s.status === 'CONFIRMED' ? 'warn' : 'neutral'}">${s.status}</span>${s.resolutionNote ? html`<br /><span class="muted">${s.resolutionNote}</span>` : ''}</td>
            <td>${s.status === 'OPEN' && canAct()
              ? html`<div class="btn-row"><button class="btn btn-danger" data-resolve="${s.id}" data-resolution="CONFIRMED">Confirm</button><button class="btn" data-resolve="${s.id}" data-resolution="DISMISSED">Dismiss</button></div>`
              : ''}</td>
          </tr>`,
        )}</tbody>
      </table></div>`
    : html`<p class="empty">None.</p>`;
}

function bindResolve(el, after) {
  el.querySelectorAll('[data-resolve]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const confirmed = btn.dataset.resolution === 'CONFIRMED';
      const answer = await confirmDialog({
        title: confirmed ? 'Confirm a double debit' : 'Dismiss as legitimate',
        body: confirmed
          ? 'The customer was debited twice. Follow docs/runbooks/pilot.md: refund through the PSP, tell the merchant, and roll the pilot back if Merchantflo caused it.'
          : 'Both debits were legitimate (for example two invoices on one mandate). Say what you checked.',
        confirmLabel: confirmed ? 'Confirm double debit' : 'Dismiss',
        noteLabel: 'Note (kept in the audit log)',
      });
      if (!answer) return;
      if (await busy(btn, () => api.resolveDuplicate(btn.dataset.resolve, btn.dataset.resolution, answer.note))) {
        toast(confirmed ? 'Recorded as a double debit' : 'Dismissed');
        after();
      }
    }),
  );
}

async function renderDuplicates(el, _ctx, status = 'OPEN') {
  const { data } = await api.duplicates(status);
  mount(
    el,
    html`<div class="page-head">
        <h2 class="m0">Suspected double debits</h2>
        <label class="field inline">Show<select id="dup-status">
          ${[['OPEN', 'Unreviewed'], ['CONFIRMED', 'Confirmed'], ['DISMISSED', 'Dismissed'], ['', 'All']].map(
            ([v, l]) => html`<option value="${v}" ${v === status ? html`selected` : ''}>${l}</option>`,
          )}
        </select></label>
      </div>
      <p class="muted">Two successful executions of one mandate, for the same amount, under 24 hours apart, at least one by Merchantflo
        (checked every 10 minutes over the last 7 days). Each one fails the merchant's pilot scorecard until it is dismissed, and blocks
        moving the pilot forward until it is reviewed. Daily mandates with equal amounts can raise false suspects.</p>
      ${duplicatesTable(data, { showMerchant: true })}`,
  );
  el.querySelector('#dup-status').addEventListener('change', (e) => renderDuplicates(el, _ctx, e.target.value).catch((err) => toast(err.message, { error: true })));
  bindResolve(el, () => renderDuplicates(el, _ctx, status));
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
  ['duplicateDebitsOpen', 'Suspected double debits (unreviewed)', 'must be 0'],
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

async function renderPrivacy(el) {
  mount(
    el,
    html`<div class="page-head"><h2 class="m0">Data erasure</h2></div>
      <p class="muted">For a customer's erasure request under the DPDP Act, when the merchant asks us to act for them (merchants can also call
        <span class="mono">POST /v1/privacy/erasure</span>). Removes the VPA and/or phone number from that merchant's mandates, payments,
        checkout sessions and webhook log; amounts and references stay. The audit log keeps the counts and your reason, never the identifiers.</p>
      ${canAct()
        ? html`<form class="card grid mt" id="erase-form">
            <div class="grid grid-2">
              <label class="field">Merchant<input name="merchantId" list="erase-merchants" required autocomplete="off" placeholder="Merchant id" /></label>
              <datalist id="erase-merchants"></datalist>
              <label class="field">Reason / ticket<input name="reason" required maxlength="500" placeholder="DPDP request #…" /></label>
              <label class="field">Customer VPA<input name="vpa" autocomplete="off" placeholder="name@bank" /></label>
              <label class="field">Customer phone<input name="phone" inputmode="tel" autocomplete="off" placeholder="98765 43210" /></label>
            </div>
            <div class="btn-row"><button class="btn btn-danger" type="submit">Erase</button></div>
            <p id="erase-result" role="status"></p>
          </form>`
        : html`<div class="callout info mt">Your role cannot erase data.</div>`}`,
  );
  const form = el.querySelector('#erase-form');
  if (!form) return;
  suggestMerchants(form.merchantId, el.querySelector('#erase-merchants'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vpa = form.vpa.value.trim();
    const phone = form.phone.value.trim();
    if (!vpa && !phone) return toast('Give a VPA, a phone number or both', { error: true });
    if (!confirm(`Erase this customer's identifiers from merchant ${form.merchantId.value}? This cannot be undone.`)) return;
    const body = { merchantId: form.merchantId.value.trim(), reason: form.reason.value.trim(), ...(vpa ? { vpa } : {}), ...(phone ? { phone } : {}) };
    const c = await busy(form.querySelector('button'), () => api.erase(body));
    if (c) {
      form.vpa.value = '';
      form.phone.value = '';
      el.querySelector('#erase-result').textContent =
        `Erased from ${c.mandates} mandates, ${c.payments} payments, ${c.checkoutSessions} checkout sessions and ${c.webhookDeliveries} webhook log rows.`;
    }
  });
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
