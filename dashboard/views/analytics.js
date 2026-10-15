import { api } from '../api/client.js';
import { lineChart, columnChart } from '../components/charts.js';
import { errorBox, loading } from '../components/panels.js';
import { istDayEnd, istDayStart, money, when } from '../lib/format.js';
import { html, mount } from '../lib/html.js';

const TABS = [
  ['value', 'Value delivered'],
  ['psps', 'PSP performance'],
  ['issues', 'Payment issues'],
  ['statement', 'Monthly statement'],
];

const compactInr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 });
const pct = (r, digits = 1) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(digits)}%`);
const ms = (v) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const duration = (v) => (v === null || v === undefined ? '—' : v < 60_000 ? '< 1 min' : v < 3600_000 ? `${Math.round(v / 60_000)} min` : v < 172_800_000 ? `${(v / 3600_000).toFixed(1)} h` : `${(v / 86_400_000).toFixed(1)} days`);
const plural = (n, one, many) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** Current IST month and the 11 before it, for the billing-cycle picker. */
function recentMonths() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  let y = Number(parts.find((p) => p.type === 'year').value);
  let m = Number(parts.find((p) => p.type === 'month').value);
  const out = [];
  for (let k = 0; k < 12; k++) {
    const code = `${y}-${String(m).padStart(2, '0')}`;
    out.push([code, new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))]);
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

export async function renderAnalytics(el, { query, me }) {
  const tab = TABS.some(([t]) => t === query.get('tab')) ? query.get('tab') : 'value';
  const month = query.get('month') ?? '';
  const fromDay = query.get('fromDay') ?? '';
  const toDay = query.get('toDay') ?? '';
  const custom = Boolean(fromDay && toDay);
  const params = custom ? { from: istDayStart(fromDay), to: istDayEnd(toDay) } : month ? { month } : {};
  const keep = (extra) => {
    const q = new URLSearchParams({ tab, ...(custom ? { fromDay, toDay } : month ? { month } : {}), ...extra });
    return `#/value?${q}`;
  };
  const months = recentMonths();

  mount(
    el,
    html`<div class="page-head"><h1>Value</h1><span class="muted">What the suite delivered, from your own payment data</span></div>
      <nav class="tabs" aria-label="Analytics">${TABS.map(([t, label]) => html`<a href="${keep({ tab: t })}" ${t === tab ? html`aria-current="page"` : ''}>${label}</a>`)}</nav>
      <form class="filter-row" id="period">
        <label class="field">Billing month<select name="month">${months.map(([code, label]) => html`<option value="${code}" ${(!custom && (month || months[0][0]) === code) ? 'selected' : ''}>${label}</option>`)}</select></label>
        ${tab === 'statement'
          ? ''
          : html`<span class="muted">or</span>
            <label class="field">From<input type="date" name="fromDay" value="${fromDay}" /></label>
            <label class="field">To<input type="date" name="toDay" value="${toDay}" /></label>`}
        <button class="btn btn-primary">Apply</button>
      </form>
      <div id="tab-body">${loading()}</div>`,
  );

  el.querySelector('#period').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const from = f.get('fromDay');
    const to = f.get('toDay');
    const q = new URLSearchParams({ tab });
    if (from && to) {
      q.set('fromDay', from);
      q.set('toDay', to);
    } else q.set('month', f.get('month'));
    location.hash = `#/value?${q}`;
  });

  const body = el.querySelector('#tab-body');
  try {
    if (tab === 'value') await valueTab(body, params);
    else if (tab === 'psps') await pspTab(body, params);
    else if (tab === 'issues') await issuesTab(body, params);
    else await statementTab(body, custom ? {} : params, me);
  } catch (e) {
    mount(body, errorBox(e.message));
  }
}

async function valueTab(el, params) {
  const v = await api.analyticsValue(params);
  const line = (key) => v.lines.find((l) => l.key === key);
  const h = v.headline;
  const u = v.uplift;
  const tile = (l, unitOne, unitMany, tag) => html`<div class="card stat">
      <div class="label">${l.label}${tag ? html`<span class="tag">${tag}</span>` : ''}</div>
      <div class="value">${money(l.amountPaise)}</div>
      <div class="sub">${plural(l.count, unitOne, unitMany)}</div>
      <p class="method">${l.methodNote}</p>
    </div>`;

  mount(
    el,
    html`<section class="card mb">
        <div class="label muted">${h.label} · ${v.period.label}</div>
        <div class="hero-value">${money(h.amountPaise)}</div>
        <div class="muted">${plural(h.count, 'payment', 'payments')} rescued</div>
        <p class="method">${h.methodNote}</p>
      </section>
      <div class="grid grid-3 mb">
        ${tile(line('peakProtected'), 'debit', 'debits')}
        ${tile(line('mdrSaved'), 'cart', 'carts')}
        ${tile(line('mdrOffered'), 'cart', 'carts', 'not counted')}
      </div>
      <section class="card mb">
        <div class="label muted">Gross value from all counted sources</div>
        <div class="stat"><div class="value">${money(v.grossTotalPaise)}</div></div>
        <p class="method">Routing recovery + peak-hour protection + MDR saved. Each payment is attributed to at most one source.</p>
      </section>
      <section class="card mb">
        <h2>Payment success</h2>
        <div class="grid grid-3">
          <div class="stat"><div class="label">Actual success rate</div><div class="value">${pct(u.actualSuccessRate)}</div><div class="sub">${plural(u.submitted, 'payment', 'payments')} sent to a provider</div></div>
          <div class="stat"><div class="label">Without recovery</div><div class="value">${pct(u.withoutRecoverySuccessRate)}</div><div class="sub">Same traffic, single PSP, no retries</div></div>
          <div class="stat"><div class="label">Uplift</div><div class="value">${u.upliftPp === null ? '—' : `+${u.upliftPp.toFixed(1)} pts`}</div><div class="sub">${plural(u.recovered, 'payment', 'payments')} recovered after a technical failure</div></div>
        </div>
        <p class="method">${u.methodNote}</p>
      </section>
      <section class="card">
        <h2>Revenue recovered and protected, by day</h2>
        <div id="value-chart"></div>
        <p class="method">MDR savings are fees rather than revenue, so they are shown above and not mixed into this chart.</p>
      </section>`,
  );

  columnChart(el.querySelector('#value-chart'), {
    categories: v.daily.map((d) => d.date),
    series: [
      { key: 'routing', label: 'Recovered by routing', slot: 1, values: v.daily.map((d) => d.routingRecoveredPaise) },
      { key: 'peak', label: 'Protected from peak embargo', slot: 2, values: v.daily.map((d) => d.peakProtectedPaise) },
    ],
    formatValue: money,
    formatTick: (p) => compactInr.format(p / 100),
    ariaLabel: `Revenue recovered and protected per day, ${v.period.label}`,
    emptyMessage: 'No revenue was recovered or protected in this period.',
  });
}

async function pspTab(el, params) {
  const r = await api.analyticsPsps(params);
  const charted = r.providers.slice(0, 3);
  const routingTone = { CLOSED: 'good', OPEN: 'bad', HALF_OPEN: 'warn', UNKNOWN: 'neutral' };
  mount(
    el,
    html`<section class="card mb">
        <h2>Technical success rate by day</h2>
        <div id="psp-chart"></div>
        ${r.providers.length > 3 ? html`<p class="method">The chart shows the first three providers; all providers are in the table below.</p>` : ''}
        <p class="method">${r.methodNote}</p>
      </section>
      <div class="table-wrap"><table>
        <thead><tr><th>Provider</th><th>Routing now</th><th class="right">Attempts</th><th class="right">Technical success</th>
          ${r.providers[0]?.technicalDeclinesByCategory.map((c) => html`<th class="right">${c.label}</th>`) ?? ''}
          <th class="right">Customer declines</th><th class="right">Typical response</th><th class="right">Slow responses (p95)</th></tr></thead>
        <tbody>${r.providers.map(
          (p) => html`<tr>
            <td>${p.pspId}</td>
            <td><span class="badge tone-${routingTone[p.routing.state] ?? 'neutral'}">${p.routing.label}</span></td>
            <td class="right num">${p.attempts.toLocaleString('en-IN')}</td>
            <td class="right num">${pct(p.technicalSuccessRate)}</td>
            ${p.technicalDeclinesByCategory.map((c) => html`<td class="right num">${c.count.toLocaleString('en-IN')}</td>`)}
            <td class="right num">${p.customerDeclines.toLocaleString('en-IN')}</td>
            <td class="right num">${ms(p.latencyP50Ms)}</td>
            <td class="right num">${ms(p.latencyP95Ms)}</td>
          </tr>`,
        )}</tbody>
      </table></div>`,
  );
  lineChart(el.querySelector('#psp-chart'), {
    categories: charted[0]?.daily.map((d) => d.date) ?? [],
    series: charted.map((p, i) => ({ key: p.pspId, label: p.pspId, slot: i + 1, values: p.daily.map((d) => d.technicalSuccessRate) })),
    formatValue: (v) => pct(v),
    formatTick: (v) => pct(v, 0),
    ariaLabel: `Technical success rate per provider per day, ${r.period.label}`,
    emptyMessage: 'No payment attempts in this period.',
  });
}

async function issuesTab(el, params) {
  const s = await api.analyticsIssues(params);
  const list = (rows, key) =>
    rows.length === 0
      ? html`<p class="muted m0">None.</p>`
      : html`<table><tbody>${rows.map((r) => html`<tr><td>${r.label}</td><td class="right num">${r.count.toLocaleString('en-IN')}</td></tr>`)}</tbody></table>`;
  mount(
    el,
    html`<div class="grid grid-3 mb">
        <div class="card stat"><div class="label">Issues opened</div><div class="value">${s.opened.total}</div></div>
        <div class="card stat"><div class="label">Issues resolved</div><div class="value">${s.resolved.total}</div><div class="sub">Median time to resolve: ${duration(s.resolved.medianTimeToResolutionMs)}</div></div>
        <a class="card stat kpi${s.now.needsAction ? ' attention' : ''}" href="#/cases?status=NEEDS_ACTION"><div class="label">Needing action now</div><div class="value">${s.now.needsAction}</div><div class="sub">Open the Dispute Desk →</div></a>
        <div class="card stat"><div class="label">Bank auto-reversals completed</div><div class="value">${money(s.reversalsCompleted.amountPaise)}</div><div class="sub">${plural(s.reversalsCompleted.count, 'payment', 'payments')} returned to customers</div></div>
        <div class="card stat"><div class="label">UDIR complaints raised</div><div class="value">${s.complaints.raised}</div>
          <div class="sub">${s.complaints.live} submitted to a PSP${s.complaints.simulated ? html` · ${s.complaints.simulated} simulated (mock PSP, not sent to NPCI)` : ''}</div></div>
      </div>
      <div class="grid grid-3">
        <section class="card"><h3>Opened, by issue</h3>${list(s.opened.byReason)}</section>
        <section class="card"><h3>Resolved, by outcome</h3>${list(s.resolved.byResolution)}</section>
        <section class="card"><h3>UDIR complaints, by status</h3>${list(s.complaints.byStatus)}</section>
      </div>`,
  );
}

async function statementTab(el, params, me) {
  const [v, s, st] = await Promise.all([api.analyticsValue(params), api.analyticsIssues(params), api.analyticsSettlements(params)]);
  const u = v.uplift;
  const month = v.period.month;
  const csv = (kind) => `/dashboard/api/analytics/${kind}.csv?month=${encodeURIComponent(month)}`;
  mount(
    el,
    html`<article class="card statement">
      <div class="doc-head">
        <div>
          <h1>Value statement · ${v.period.label}</h1>
          <div class="muted">${me.merchant.name} · generated ${when(new Date().toISOString())}</div>
        </div>
        <div class="btn-row no-print">
          <a class="btn" href="${csv('statement')}" download>Download statement (CSV)</a>
          <a class="btn" href="${csv('value-events')}" download>Download line items (CSV)</a>
          <button class="btn btn-primary" type="button" id="print">Print</button>
        </div>
      </div>
      <h3>Value delivered</h3>
      <div class="table-wrap mb"><table>
        <thead><tr><th>Source</th><th class="right">Count</th><th class="right">Amount</th><th>What is counted</th></tr></thead>
        <tbody>
          ${v.lines.map((l) => html`<tr><td>${l.label}${l.inTotal ? '' : html`<span class="tag">not counted</span>`}</td><td class="right num">${l.count}</td><td class="right num">${money(l.amountPaise)}</td><td class="note">${l.methodNote}</td></tr>`)}
          <tr><td><strong>Gross value (all counted sources)</strong></td><td></td><td class="right num"><strong>${money(v.grossTotalPaise)}</strong></td><td class="note">Each payment is attributed to at most one source.</td></tr>
        </tbody>
      </table></div>
      <h3>Payment success</h3>
      <div class="table-wrap mb"><table><tbody>
        <tr><td>Payments sent to a provider</td><td class="right num">${u.submitted}</td></tr>
        <tr><td>Actual success rate</td><td class="right num">${pct(u.actualSuccessRate, 2)}</td></tr>
        <tr><td>Success rate without recovery</td><td class="right num">${pct(u.withoutRecoverySuccessRate, 2)}</td></tr>
        <tr><td>Uplift</td><td class="right num">${u.upliftPp === null ? '—' : `+${u.upliftPp.toFixed(2)} pts`}</td></tr>
      </tbody></table></div>
      <h3>Payment issues</h3>
      <div class="table-wrap mb"><table><tbody>
        <tr><td>Issues opened / resolved</td><td class="right num">${s.opened.total} / ${s.resolved.total}</td></tr>
        <tr><td>Median time to resolve</td><td class="right num">${duration(s.resolved.medianTimeToResolutionMs)}</td></tr>
        <tr><td>Bank auto-reversals completed</td><td class="right num">${s.reversalsCompleted.count} · ${money(s.reversalsCompleted.amountPaise)}</td></tr>
        <tr><td>UDIR complaints raised</td><td class="right num">${s.complaints.live} live · ${s.complaints.simulated} simulated</td></tr>
      </tbody></table></div>
      <h3>Settlement</h3>
      <div class="table-wrap mb"><table><tbody>
        <tr><td>Captured payments</td><td class="right num">${st.captured.count} · ${money(st.captured.amountPaise)}</td></tr>
        <tr><td>Settled to your account (net of PSP fees)</td><td class="right num">${st.settled.count} · ${money(st.settled.netPaise)} (${pct(st.settledShare)})</td></tr>
        <tr><td>PSP fees and taxes</td><td class="right num">${money(st.settled.feesPaise)}</td></tr>
        <tr><td>Settled amount differs from captured</td><td class="right num">${st.mismatched}</td></tr>
        <tr><td>Not yet settled</td><td class="right num">${st.unsettled}</td></tr>
      </tbody></table></div>
      <p class="method">${st.methodNote}</p>
      <p class="method">${u.methodNote}</p>
      <p class="method">All figures come from your own payments processed through the suite in this billing month (IST). Simulated UDIR complaints were made against a mock PSP and never sent to NPCI.</p>
    </article>`,
  );
  el.querySelector('#print').addEventListener('click', () => window.print());
}
