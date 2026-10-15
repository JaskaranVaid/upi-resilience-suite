import { SettlementAnalytics } from '../../src/analytics/settlements.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { csvCell, slug, toCsv } from '../../src/analytics/csv.js';
import { IssueAnalytics } from '../../src/analytics/issues.js';
import { resolvePeriod } from '../../src/analytics/period.js';
import { StatementService, STATEMENT_HEADER, VALUE_EVENTS_HEADER } from '../../src/analytics/statement.js';
import { ValueService } from '../../src/analytics/value.js';
import type { Db } from '../../src/db/client.js';
import { paymentAttempts, payments, paymentTracking, savingsEvents, type SavingsType } from '../../src/db/schema.js';
import { newId } from '../../src/ids.js';
import { freshDb, ist, rs, seedMerchant } from '../helpers/fixtures.js';

const OCT = resolvePeriod({ month: '2026-10' }, ist('2026-10-15T12:00:00'));

/** Minimal RFC 4180 parser for assertions. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  return rows;
}

describe('csv', () => {
  it.each([
    ['plain', 'plain'],
    ['has, comma', '"has, comma"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=HYPERLINK("http://evil")', `"'=HYPERLINK(""http://evil"")"`],
    ['+cmd', "'+cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    [-5, '-5'],
    [12.5, '12.5'],
    [null, ''],
  ])('csvCell(%j) → %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('uses CRLF and a header row', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });

  it('slugs merchant names for filenames', () => {
    expect(slug('StreamCo OTT / India')).toBe('streamco-ott-india');
  });
});

describe('StatementService', () => {
  let db: Db;
  let merchantId: string;
  let svc: StatementService;

  beforeEach(async () => {
    ({ db } = await freshDb());
    merchantId = (await seedMerchant(db)).id;
    svc = new StatementService({ db, value: new ValueService({ db }), issues: new IssueAnalytics({ db }), settlements: new SettlementAnalytics({ db }) });
  });

  const saving = (type: SavingsType, amountPaise: number, at: string, refId: string) =>
    db.insert(savingsEvents).values({ id: newId('sav'), merchantId, type, amountPaise, refId, createdAt: ist(at) });

  it('summarises value, success and issues with method notes', async () => {
    const payId = newId('pay');
    await db.insert(payments).values({ id: payId, merchantId, amountPaise: rs(2500), payerVpa: 'ab@ok', idempotencyKey: 'k', state: 'SUCCEEDED', createdAt: ist('2026-10-02T10:00:00'), updatedAt: ist('2026-10-02T10:00:00') });
    await db.insert(paymentAttempts).values([
      { id: newId('att'), merchantId, paymentId: payId, pspId: 'pspA', txnRef: 'a', op: 'collect', outcome: 'TECHNICAL_DECLINE', latencyMs: 5, seq: 0, createdAt: ist('2026-10-02T10:00:00') },
      { id: newId('att'), merchantId, paymentId: payId, pspId: 'pspB', txnRef: 'b', op: 'collect', outcome: 'SUCCESS', latencyMs: 5, seq: 1, createdAt: ist('2026-10-02T10:00:00') },
    ]);
    await saving('TD_RECOVERED', rs(2500), '2026-10-02T10:00:00', payId);

    const rows = parseCsv(await svc.summaryCsv(merchantId, OCT));
    expect(rows[0]).toEqual(STATEMENT_HEADER);
    const find = (metric: string) => rows.find((r) => r[1] === metric)!;
    expect(find('Recovered by smart routing & safe retries').slice(2, 6)).toEqual(['1', '2500.00', '250000', 'counted in total']);
    expect(find('Recovered by smart routing & safe retries')[6]).toMatch(/technical reason/);
    expect(find('Gross value (all counted sources)')[3]).toBe('2500.00');
    expect(find('Actual success rate')[5]).toBe('100.00%');
    expect(find('Success rate without recovery')[5]).toBe('0.00%');
    expect(find('Uplift (percentage points)')[5]).toBe('100.00');
    expect(find('UDIR complaints raised')[5]).toBe('0 live, 0 simulated');
    expect(rows.every((r) => r.length === STATEMENT_HEADER.length)).toBe(true);
  });

  it('lists every value event with its payment, and neutralises formula-looking order ids', async () => {
    const payId = newId('pay');
    await db.insert(payments).values({ id: payId, merchantId, amountPaise: rs(2500), payerVpa: 'ab@ok', idempotencyKey: 'k', orderId: '=HYPERLINK("http://evil","x")', quoteId: 'quo_1', state: 'SUCCEEDED', createdAt: ist('2026-10-02T10:00:00'), updatedAt: ist('2026-10-02T10:00:00') });
    await db.insert(paymentTracking).values({ id: newId('trk'), merchantId, subjectType: 'COLLECT', subjectId: payId, upiRrn: '612345678901', verificationStatus: 'NOT_REQUIRED' });
    await saving('TD_RECOVERED', rs(2500), '2026-10-02T10:00:00', payId);
    await saving('MDR_STEERING_ACCEPTED', rs(9), '2026-10-03T10:00:00', 'quo_1');
    await saving('MDR_STEERING_OFFERED', rs(9), '2026-10-03T10:00:00', 'quo_1'); // not a value event line
    await saving('TD_RECOVERED', rs(1), '2026-11-02T10:00:00', newId('pay')); // other month

    const csv = await svc.valueEventsCsv(merchantId, OCT);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(VALUE_EVENTS_HEADER);
    expect(rows.slice(1)).toEqual([
      ['2026-10-02 10:00', 'Recovered by smart routing & safe retries', 'Collect', payId, `'=HYPERLINK("http://evil","x")`, '612345678901', '2500.00', '250000', payId],
      ['2026-10-03 10:00', 'MDR saved through payment-method steering', 'Collect', payId, `'=HYPERLINK("http://evil","x")`, '612345678901', '9.00', '900', 'quo_1'],
    ]);
  });
});
