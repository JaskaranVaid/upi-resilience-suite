/** Minimal JSON-over-HTTP client for PSP adapters: explicit timeouts, typed transport errors. */

export type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface HttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
}

/** The request never produced an HTTP response (timeout, DNS, connection reset…). */
export class TransportError extends Error {
  override name = 'TransportError';
  constructor(
    readonly kind: 'TIMEOUT' | 'NETWORK',
    message: string,
  ) {
    super(message);
  }
}

export async function requestJson(
  fetchFn: FetchFn,
  req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<HttpResponse> {
  let res;
  try {
    res = await fetchFn(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new TransportError('TIMEOUT', `timed out after ${req.timeoutMs} ms`);
    throw new TransportError('NETWORK', e instanceof Error ? e.message : String(e));
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}
