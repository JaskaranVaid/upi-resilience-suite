import { hashToInt } from '../rules/slots.js';
import { CashfreeAdapter } from './cashfree/adapter.js';
import type { FetchFn } from './http.js';
import { MockPsp } from './mock.js';
import type { ConnectionAdapterFactory } from './registry.js';

/**
 * The adapter for a merchant's own PSP account. The connection id becomes the adapter id, so
 * every record (mandates, payments, attempts, tracking, health) refers to that account.
 */
export function connectionAdapterFactory(opts: { fetch?: FetchFn; cashfreeTimeoutMs?: number } = {}): ConnectionAdapterFactory {
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
      case 'mock':
        // Test-mode connection: simulated results only (never a real PSP).
        return new MockPsp(row.id, { seed: hashToInt(row.id) % 1000, latencyMs: 50 });
    }
  };
}
