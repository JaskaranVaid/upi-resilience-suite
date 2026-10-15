import { api } from './api/client.js';
import { errorBox } from './components/panels.js';
import { toast } from './components/ui.js';
import { html, mount } from './lib/html.js';
import { renderAnalytics } from './views/analytics.js';
import { renderCaseDetail, renderCases } from './views/cases.js';
import { renderLogin } from './views/login.js';
import { renderOverview } from './views/overview.js';
import { renderPaymentDetail } from './views/payment-detail.js';
import { renderPayments, renderSearch } from './views/payments.js';
import { renderUsers } from './views/users.js';

// Hash router: #/path?query. Each route maps to a view; views fetch their own data.
const ROUTES = [
  { pattern: /^\/overview$/, view: renderOverview, nav: 'overview' },
  { pattern: /^\/payments$/, view: renderPayments, nav: 'payments' },
  { pattern: /^\/search$/, view: renderSearch, nav: 'payments' },
  { pattern: /^\/payments\/(?<type>collect|autopay)\/(?<id>[^/]+)$/, view: renderPaymentDetail, nav: 'payments' },
  { pattern: /^\/cases$/, view: renderCases, nav: 'cases' },
  { pattern: /^\/cases\/(?<id>[^/]+)$/, view: renderCaseDetail, nav: 'cases' },
  { pattern: /^\/value$/, view: renderAnalytics, nav: 'value' },
  { pattern: /^\/users$/, view: renderUsers, nav: 'users' },
];

const root = document.getElementById('app');
let session = null; // { me, meta }

function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else {
    location.hash = hash; // fires hashchange → route()
  }
}

function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/overview').split('?');
  return { path, query: new URLSearchParams(qs ?? '') };
}

function shell(active) {
  const { me } = session;
  const link = (key, href, label) => html`<a href="${href}" ${active === key ? html`aria-current="page"` : ''}>${label}</a>`;
  return html`<div class="shell">
    <aside class="sidebar">
      <div class="brand">${me.merchant.name}<small>Payment Resolution Console</small></div>
      <nav class="nav" aria-label="Main">
        ${link('overview', '#/overview', 'Overview')}
        ${link('payments', '#/payments', 'Payments')}
        ${link('cases', '#/cases', 'Dispute Desk')}
        ${link('value', '#/value', 'Value')}
        ${me.user.role === 'ADMIN' ? link('users', '#/users', 'Team') : ''}
      </nav>
      <div class="me">
        <div>${me.user.name}</div>
        <div class="muted">${me.user.role.toLowerCase()}</div>
        <button class="btn mt8" id="logout">Sign out</button>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <form id="search" role="search">
          <input name="q" type="search" required placeholder="Search by UPI ref (12 digits), payment ID or order ID" aria-label="Search payments" class="flex1" />
          <button class="btn btn-primary">Search</button>
        </form>
      </header>
      <main class="content" id="view"></main>
    </div>
  </div>`;
}

async function route() {
  if (!session) return start();
  const { path, query } = parseHash();
  const match = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
  if (!match) return navigate('#/overview', { replace: true });

  mount(root, shell(match.r.nav));
  root.querySelector('#logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    session = null;
    start();
  });
  root.querySelector('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(`#/search?q=${encodeURIComponent(e.target.q.value.trim())}`);
  });
  const view = root.querySelector('#view');
  try {
    await match.r.view(view, { ...session, params: match.m.groups ?? {}, query, navigate });
  } catch (e) {
    mount(view, errorBox(e.message));
  }
  view.focus?.();
}

async function start() {
  try {
    const [me, meta] = await Promise.all([api.me(), api.meta()]);
    session = { me, meta };
    route();
  } catch {
    session = null;
    renderLogin(root, start);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('session-expired', () => {
  if (!session) return;
  session = null;
  toast('Your session has ended — please sign in again.', { error: true });
  start();
});

start();
