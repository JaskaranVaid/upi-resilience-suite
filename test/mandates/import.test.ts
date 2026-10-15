import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/api/app.js';
import { FakeClock } from '../../src/clock.js';
import { buildContext, type AppContext } from '../../src/context.js';
import { mandates } from '../../src/db/schema.js';
import { parseCsv } from '../../src/mandates/csv.js';
import { MockPsp } from '../../src/psp/mock.js';
import { freshDb, ist, rs } from '../helpers/fixtures.js';

const ADMIN = 'test-admin-token';

describe('CSV reader', () => {
  it('handles quotes, escaped quotes, CRLF, a BOM and blank lines', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",3\r\n\r\n4,5,\n');
    expect(rows).toEqual([
      { a: 'x, y', b: 'say "hi"', c: '3' },
      { a: '4', b: '5', c: '' },
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(/quoted field/);
  });
});

describe('bulk mandate import', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let psp: MockPsp;
  let key: string;
  let merchantId: string;

  beforeEach(async () => {
    const { db } = await freshDb();
    const clock = new FakeClock(ist('2026-10-15T14:00:00'));
    psp = new MockPsp('pspA');
    ctx = buildContext({ db, adapters: [psp], adminToken: ADMIN, clock, sleep: clock.sleep });
    app = buildApp(ctx);
    const r = (await app.inject({ method: 'POST', url: '/v1/merchants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'Subs Co' } })).json();
    key = r.apiKey;
    merchantId = r.merchant.id;
  });

  const importJson = (payload: object) => app.inject({ method: 'POST', url: '/v1/mandates/import', headers: { authorization: `Bearer ${key}` }, payload });
  const importCsv = (csv: string, verify = false) =>
    app.inject({ method: 'POST', url: `/v1/mandates/import${verify ? '?verify=true' : ''}`, headers: { authorization: `Bearer ${key}`, 'content-type': 'text/csv' }, payload: csv });
  const stored = async () => (await ctx.db.select().from(mandates).where(eq(mandates.merchantId, merchantId))).map((m) => m.mandateRef).sort();

  it('imports good rows from CSV and reports each bad row by number', async () => {
    const csv = [
      'mandateRef,customerVpa,maxAmountPaise,eligiblePsps,noAfaLimitPaise',
      `UMN-1,asha@okhdfc,${rs(999)},pspA,`,
      'UMN-2,not-a-vpa,50000,pspA,',
      `UMN-3,ravi@okaxis,${rs(499)},,`,
      `UMN-4,meera@oksbi,${rs(499)},pspZ,`,
      `UMN-1,asha@okhdfc,${rs(999)},pspA,`,
    ].join('\n');
    const res = await importCsv(csv);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 2, existing: 0 });
    expect(body.rejected.map((r: { row: number }) => r.row)).toEqual([2, 4, 5]);
    expect(body.rejected[0].reason).toMatch(/customerVpa/);
    expect(body.rejected[1].reason).toMatch(/Unknown PSPs: pspZ/);
    expect(body.rejected[2].reason).toMatch(/Duplicate of row 1/);
    expect(await stored()).toEqual(['UMN-1', 'UMN-3']);
  });

  it('is idempotent: re-importing the same file creates nothing new', async () => {
    const rows = [
      { mandateRef: 'UMN-A', customerVpa: 'asha@okhdfc', maxAmountPaise: rs(999) },
      { mandateRef: 'UMN-B', customerVpa: 'ravi@okaxis', maxAmountPaise: rs(499), noAfaLimitPaise: rs(50000) },
    ];
    expect((await importJson({ mandates: rows })).json()).toMatchObject({ created: 2, existing: 0, rejected: [] });
    expect((await importJson({ mandates: rows })).json()).toMatchObject({ created: 0, existing: 2, rejected: [] });
    const [b] = await ctx.db.select().from(mandates).where(eq(mandates.mandateRef, 'UMN-B'));
    expect(b).toMatchObject({ noAfaLimitPaise: rs(50000), eligiblePsps: ['pspA'] });
  });

  it('with verify, accepts only mandates the PSP reports active', async () => {
    psp.setMandateStatus('UMN-PAUSED', 'INACTIVE');
    psp.setMandateStatus('UMN-GONE', 'NOT_FOUND');
    const csv = ['mandateRef,customerVpa,maxAmountPaise', 'UMN-OK,asha@okhdfc,49900', 'UMN-PAUSED,ravi@okaxis,49900', 'UMN-GONE,meera@oksbi,49900'].join('\n');
    const body = (await importCsv(csv, true)).json();
    expect(body.created).toBe(1);
    expect(body.rejected).toEqual([
      { row: 2, mandateRef: 'UMN-PAUSED', reason: 'Not active at pspA' },
      { row: 3, mandateRef: 'UMN-GONE', reason: 'Not found at pspA' },
    ]);
    expect(await stored()).toEqual(['UMN-OK']);
  });

  it('reports a failed verification lookup as retryable, without importing that row', async () => {
    psp.mandateStatus = async () => {
      throw new Error('subscriptions API timed out');
    };
    const body = (await importJson({ mandates: [{ mandateRef: 'UMN-X', customerVpa: 'asha@okhdfc', maxAmountPaise: 100 }], verify: true })).json();
    expect(body.created).toBe(0);
    expect(body.rejected[0].reason).toMatch(/Couldn't verify with pspA \(try again\)/);
  });

  it('refuses empty and oversized imports', async () => {
    expect((await importJson({ mandates: [] })).statusCode).toBe(400);
    expect((await importCsv('mandateRef,customerVpa,maxAmountPaise\n')).statusCode).toBe(400);
    const many = Array.from({ length: 5001 }, (_, i) => ({ mandateRef: `U${i}`, customerVpa: 'asha@okhdfc', maxAmountPaise: 100 }));
    expect((await importJson({ mandates: many })).json().error.message).toMatch(/At most 5000/);
  });
});
