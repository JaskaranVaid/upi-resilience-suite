// All dashboard traffic goes to our backend. The browser never talks to a PSP.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const res = await fetch(`/dashboard/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'x-dashboard-request': '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    const e = new ApiError(res.status, err.code ?? 'ERROR', err.message ?? `Request failed (${res.status})`);
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new CustomEvent('session-expired'));
    throw e;
  }
  return data;
}

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  return s.toString() ? `?${s}` : '';
};

export const api = {
  login: (email, password, code) => request('POST', '/login', { email, password, ...(code ? { code } : {}) }),
  twoFactorSetup: (password) => request('POST', '/me/2fa/setup', { password }),
  twoFactorConfirm: (code) => request('POST', '/me/2fa/confirm', { code }),
  twoFactorDisable: (password, code) => request('POST', '/me/2fa/disable', { password, code }),
  logout: () => request('POST', '/logout'),
  me: () => request('GET', '/me'),
  meta: () => request('GET', '/meta'),
  overview: () => request('GET', '/overview'),
  payments: (filters) => request('GET', `/payments${qs(filters)}`),
  search: (q) => request('GET', `/payments/search${qs({ q })}`),
  payment: (type, id) => request('GET', `/payments/${type}/${encodeURIComponent(id)}`),
  timeline: (type, id) => request('GET', `/payments/${type}/${encodeURIComponent(id)}/timeline`),
  recheckPayment: (type, id) => request('POST', `/payments/${type}/${encodeURIComponent(id)}/recheck`),
  raiseComplaint: (type, id, reason) => request('POST', `/payments/${type}/${encodeURIComponent(id)}/complaints`, { reason }),
  cases: (params) => request('GET', `/cases${qs(params)}`),
  case: (id) => request('GET', `/cases/${encodeURIComponent(id)}`),
  addNote: (id, body) => request('POST', `/cases/${encodeURIComponent(id)}/notes`, { body }),
  recheckCase: (id) => request('POST', `/cases/${encodeURIComponent(id)}/recheck`),
  closeCase: (id, note) => request('POST', `/cases/${encodeURIComponent(id)}/close`, { note }),
  analyticsValue: (period) => request('GET', `/analytics/value${qs(period)}`),
  analyticsPsps: (period) => request('GET', `/analytics/psps${qs(period)}`),
  analyticsIssues: (period) => request('GET', `/analytics/issues${qs(period)}`),
  analyticsSettlements: (period) => request('GET', `/analytics/settlements${qs(period)}`),
  pilot: (period) => request('GET', `/pilot${qs(period)}`),
  users: () => request('GET', '/users'),
  createUser: (u) => request('POST', '/users', u),
  updateUser: (id, patch) => request('PATCH', `/users/${encodeURIComponent(id)}`, patch),
  developers: () => request('GET', '/developers'),
  apiKeys: () => request('GET', '/developers/api-keys'),
  pspConnections: () => request('GET', '/developers/psp-connections'),
  webhookDeliveries: (params) => request('GET', `/developers/webhook-deliveries${qs(params)}`),
  redeliverWebhook: (id) => request('POST', `/developers/webhook-deliveries/${encodeURIComponent(id)}/redeliver`),
};
