import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext } from '../../src/context.js';
import { connectionAdapterFactory } from '../../src/psp/connections.js';
import type { FetchFn } from '../../src/psp/http.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('Razorpay connections', () => {
  const setup = async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    const fetchFn: FetchFn = async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/v1/orders' ? { items: [] } : { error: { code: 'BAD_REQUEST_ERROR' } };
      return { status: path === '/v1/orders' ? 200 : 404, text: async () => JSON.stringify(body), headers: { get: () => null } };
    };
    const app = buildApp(buildContext({ db, adapters: [], adminToken: ADMIN, clock, sleep: clock.sleep, connectionAdapters: connectionAdapterFactory({ fetch: fetchFn }) }));
    const onboard = async (mode: 'TEST' | 'LIVE') =>
      (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'M', mode } })).json().apiKey as string;
    const call = (key: string, url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${key}` } });
    return { onboard, call };
  };

  it('pairs test keys with test-mode merchants and live keys with live ones', async () => {
    const { onboard, call } = await setup();
    const live = await onboard('LIVE');
    const wrong = await call(live, '/v1/psp-connections', { provider: 'razorpay', credentials: { keyId: 'rzp_test_AAA', keySecret: 'sec' } });
    expect(wrong.json().error.message).toMatch(/needs rzp_live_ keys/);
    const ok = await call(live, '/v1/psp-connections', { provider: 'razorpay', credentials: { keyId: 'rzp_live_AAAA1234', keySecret: 'sec', webhookSecret: 'whk' } });
    expect(ok.json()).toMatchObject({ provider: 'razorpay', environment: 'production', credentialHint: 'rzp_…1234' });
    const garbage = await call(live, '/v1/psp-connections', { provider: 'razorpay', credentials: { clientId: 'x', clientSecret: 'y' } });
    expect(garbage.statusCode).toBe(400);
    expect(JSON.stringify(garbage.json())).not.toContain('"y"');
  });

  it("can take one-off payments but can't be named on an AutoPay mandate", async () => {
    const { onboard, call } = await setup();
    const key = await onboard('TEST');
    const conn = (await call(key, '/v1/psp-connections', { provider: 'razorpay', credentials: { keyId: 'rzp_test_BBB', keySecret: 'sec' } })).json();
    const mandate = await call(key, '/v1/mandates', { mandateRef: 'U', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500), eligiblePsps: [conn.id] });
    expect(mandate.statusCode).toBe(400);
    expect(mandate.json().error.message).toMatch(/can't execute AutoPay mandates/);
    // With no AutoPay-capable PSP, omitting eligiblePsps finds nothing to default to.
    expect((await call(key, '/v1/mandates', { mandateRef: 'U2', customerVpa: 'ab@okaxis', maxAmountPaise: rs(500) })).json().error.message).toMatch(/Specify eligiblePsps/);
  });
});
