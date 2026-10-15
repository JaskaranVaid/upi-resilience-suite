import type { Env } from '../config/env.js';
import { CashfreeAdapter } from './cashfree/adapter.js';
import type { FetchFn } from './http.js';
import { MockPsp, type MockRates } from './mock.js';
import type { PspAdapter } from './types.js';

export class PspConfigError extends Error {
  override name = 'PspConfigError';
}

/**
 * True for values that are clearly not real API keys — a docs placeholder such as
 * `<your sandbox app id>` or `…` copied verbatim. Real Cashfree keys never contain angle
 * brackets, ellipses, whitespace or quotes.
 */
export function looksLikePlaceholder(value: string): boolean {
  return /[<>…\s"']|\.\.\./.test(value);
}

type PspEnv = Pick<
  Env,
  'NODE_ENV' | 'MOCK_PSPS' | 'MOCK_PSP_RATES' | 'ALLOW_MOCK_PSPS' | 'CASHFREE_CLIENT_ID' | 'CASHFREE_CLIENT_SECRET' | 'CASHFREE_ENV' | 'CASHFREE_TIMEOUT_MS'
>;

/**
 * Build the process-level *shared* PSP adapters, in routing-priority order. Shared adapters serve
 * TEST merchants only (mocks, a platform Cashfree sandbox account); live merchants use their own
 * PSP connections (ADR 0002). Refuses unsafe combinations instead of starting in a state that
 * could fake payments or route money through our account.
 */
export function buildAdapters(env: PspEnv, opts: { fetch?: FetchFn; warn?: (msg: string) => void } = {}): PspAdapter[] {
  const warn = opts.warn ?? ((m) => console.warn(m));
  const adapters: PspAdapter[] = [];

  const hasId = Boolean(env.CASHFREE_CLIENT_ID);
  const hasSecret = Boolean(env.CASHFREE_CLIENT_SECRET);
  if (hasId !== hasSecret) throw new PspConfigError('Set both CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET, or neither');
  if (hasId && hasSecret) {
    for (const name of ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'] as const) {
      if (looksLikePlaceholder(env[name]!)) {
        throw new PspConfigError(`${name} looks like a placeholder, not a real key. Replace it with the value from the Cashfree dashboard.`);
      }
    }
    if (env.CASHFREE_ENV === 'production') {
      throw new PspConfigError(
        'Live Cashfree credentials must belong to a merchant: add them with POST /v1/psp-connections. ' +
          'CASHFREE_CLIENT_ID/SECRET configure a shared sandbox account for test-mode merchants only.',
      );
    }
    if (env.NODE_ENV === 'production') {
      warn('Shared Cashfree sandbox adapter enabled: test-mode merchants can use it; live merchants never do.');
    }
    adapters.push(
      new CashfreeAdapter({
        clientId: env.CASHFREE_CLIENT_ID!,
        clientSecret: env.CASHFREE_CLIENT_SECRET!,
        env: env.CASHFREE_ENV,
        timeoutMs: env.CASHFREE_TIMEOUT_MS,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    );
  }

  const mockIds = env.MOCK_PSPS.split(',').map((s) => s.trim()).filter(Boolean);
  if (mockIds.length > 0) {
    if (env.NODE_ENV === 'production' && env.ALLOW_MOCK_PSPS !== 'true') {
      throw new PspConfigError(
        `Refusing to start in production with mock PSPs (${mockIds.join(', ')}): they report fake payment results. ` +
          'Set MOCK_PSPS= (empty) or, for a deliberate demo, ALLOW_MOCK_PSPS=true.',
      );
    }
    const rates: Record<string, MockRates> = env.MOCK_PSP_RATES ? JSON.parse(env.MOCK_PSP_RATES) : {};
    mockIds.forEach((id, i) => adapters.push(new MockPsp(id, { rates: rates[id] ?? {}, seed: i + 1, latencyMs: 50 })));
    if (env.NODE_ENV === 'production') warn(`WARNING: production with MOCK PSP adapters (${mockIds.join(', ')}). No real PSP or NPCI calls are made by them.`);
  }

  const ids = adapters.map((a) => a.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new PspConfigError(`Duplicate PSP id: ${dup}`);
  return adapters; // may be empty: merchants then route only through their own connections
}
