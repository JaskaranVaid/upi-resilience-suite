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
    const x = ipv6Hextets(ip);
    if (!x) return true;
    const v4 = (hi: number, lo: number) => isNonPublicAddress(`${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`);
    const zeros = (from: number, to: number) => x.slice(from, to).every((h) => h === 0);
    // Forms that carry an IPv4 address are judged by that address (mapped, compatible, NAT64, 6to4).
    if (zeros(0, 5) && x[5] === 0xffff) return v4(x[6]!, x[7]!); // ::ffff:a.b.c.d
    if (zeros(0, 6)) return true; // ::, ::1 and deprecated ::a.b.c.d
    if (x[0] === 0x64 && x[1] === 0xff9b) return zeros(2, 6) ? v4(x[6]!, x[7]!) : true; // NAT64 (local-use /48 blocked)
    if (x[0] === 0x2002) return v4(x[1]!, x[2]!); // 6to4
    const a = x[0]!;
    return (
      (a === 0x2001 && x[1] === 0) || // Teredo (embeds an obfuscated IPv4 address)
      (a === 0x2001 && x[1] === 0xdb8) || // documentation
      (a === 0x100 && zeros(1, 4)) || // discard-only
      (a & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (a & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (a & 0xffc0) === 0xfec0 || // site-local fec0::/10
      (a & 0xff00) === 0xff00 // multicast
    );
  }
  return true; // not an IP at all: never "public"
}

/** The eight 16-bit groups of an IPv6 address (handles `::`, zone ids and a trailing dotted quad). */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    s = `${s.slice(0, -dotted[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const parts = tail === null ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
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
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
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
