import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where merchant webhooks may be delivered. 'public-only' (production) blocks plain http and any
 * host on a loopback, private, link-local or otherwise internal network — otherwise a merchant
 * could point "their" webhook at our own infrastructure (e.g. the cloud metadata service).
 */
export type WebhookTargetPolicy = 'public-only' | 'any';

export type ResolveHost = (hostname: string) => Promise<string[]>;

const dnsResolve: ResolveHost = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** True for any address a webhook must never be delivered to. */
export function isNonPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (kind === 6) {
    const a = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isNonPublicAddress(mapped[1]!);
    return (
      a === '::' ||
      a === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(a) || // unique local fc00::/7
      /^fe[89ab][0-9a-f]:/.test(a) || // link-local fe80::/10
      /^ff[0-9a-f]{2}:/.test(a) // multicast
    );
  }
  return true; // not an IP at all: never "public"
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Static check of a webhook URL under a policy. Returns the reason it is refused, or null. */
export function checkWebhookUrl(raw: string, policy: WebhookTargetPolicy): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http(s) URL';
  if (url.username || url.password) return 'must not contain credentials';
  if (policy === 'any') return null;
  if (url.protocol !== 'https:') return 'must use https';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return 'must be a public host';
  if (isIP(host) && isNonPublicAddress(host)) return 'must not point at a private or internal network address';
  return null;
}

/**
 * Delivery-time guard for 'public-only': re-checks the URL and that every address the hostname
 * resolves to is public (a public name can be pointed at a private IP after it was registered).
 * Returns a reason to refuse delivery permanently, or null. Throws if DNS fails (transient).
 */
export function publicTargetGuard(resolve: ResolveHost = dnsResolve) {
  return async (raw: string): Promise<string | null> => {
    const reason = checkWebhookUrl(raw, 'public-only');
    if (reason) return `webhook URL ${reason}`;
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (addresses.length === 0) throw new Error(`webhook host ${host} did not resolve`);
    const bad = addresses.find(isNonPublicAddress);
    return bad ? `webhook host resolves to a non-public address (${bad})` : null;
  };
}
