import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { FetchLike } from './outbox.js';
import { isNonPublicAddress } from './url.js';

/**
 * DNS lookup for outbound connections that refuses non-public addresses. Because the check runs
 * at connect time, the address checked is the address used: a hostname re-pointed at a private
 * IP after validation (DNS rebinding) cannot slip through.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address: string | LookupAddress[], family?: number) => {
    if (err) return callback(err, '', 0);
    const all = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
    const bad = all.find((a) => isNonPublicAddress(a.address));
    if (bad) return callback(Object.assign(new Error(`refusing non-public address ${bad.address} for ${hostname}`), { code: 'ENONPUBLIC' }), '', 0);
    (callback as (e: null, a: string | LookupAddress[], f?: number) => void)(null, address, family);
  });
};

/**
 * Webhook POSTs for the 'public-only' policy: connections only to public addresses, redirects
 * never followed (a 3xx is a failed delivery), response body discarded.
 */
export const publicOnlyFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isNonPublicAddress(host)) return reject(new Error(`refusing non-public address ${host}`));
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      u,
      {
        method: init.method,
        headers: { ...init.headers, 'content-length': Buffer.byteLength(init.body) },
        lookup: publicOnlyLookup,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
