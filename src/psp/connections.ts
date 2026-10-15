import { systemClock, type Clock } from '../clock.js';
import { hashToInt } from '../rules/slots.js';
import { CashfreeAdapter } from './cashfree/adapter.js';
import type { FetchFn } from './http.js';
import { MockPsp } from './mock.js';
import { RazorpayAdapter } from './razorpay/adapter.js';
import type { ConnectionAdapterFactory } from './registry.js';

/**
 * The adapter for a merchant's own PSP account. The connection id becomes the adapter id, so
 * every record (mandates, payments, attempts, tracking, health) refers to that account.
 */
export function connectionAdapterFactory(opts: { fetch?: FetchFn; cashfreeTimeoutMs?: number; clock?: Clock } = {}): ConnectionAdapterFactory {
  return (row, credentials) => {
    switch (row.provider) {
      case 'cashfree': {
        if (!credentials?.clientId || !credentials.clientSecret) throw new Error(`Connection ${row.id} has no Cashfree credentials`);
        return new CashfreeAdapter({
          id: row.id,
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          env: row.environment,
          ...(opts.cashfreeTimeoutMs ? { timeoutMs: opts.cashfreeTimeoutMs } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      }
      case 'razorpay': {
        if (!credentials?.keyId || !credentials.keySecret) throw new Error(`Connection ${row.id} has no Razorpay credentials`);
        return new RazorpayAdapter({
          id: row.id,
          keyId: credentials.keyId,
          keySecret: credentials.keySecret,
          ...(credentials.webhookSecret ? { webhookSecret: credentials.webhookSecret } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      }
      case 'mock':
        // Test-mode connection: simulated results only (never a real PSP), settled T+1 so
        // reconciliation can be tried end to end.
        return new MockPsp(row.id, { seed: hashToInt(row.id) % 1000, latencyMs: 50, autoSettle: { clock: opts.clock ?? systemClock } });
    }
  };
}
