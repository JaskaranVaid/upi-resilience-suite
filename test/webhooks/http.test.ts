import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import type { DbHandle } from '../../src/db/client.js';
import { webhookOutbox } from '../../src/db/schema.js';
import { publicOnlyFetch } from '../../src/webhooks/http.js';
import { enqueueWebhook, WebhookDispatcher } from '../../src/webhooks/outbox.js';
import { eq } from 'drizzle-orm';
import { seedMerchant, testDb } from '../helpers/fixtures.js';

describe('webhook delivery transport', () => {
  let server: Server;
  let port: number;
  const hits: string[] = [];
  let h: DbHandle;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(307, { location: `http://127.0.0.1:${port}/internal` }).end();
      } else {
        res.writeHead(200).end('ok');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    h = await testDb();
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await h.close();
  });

  const post = (url: string) => publicOnlyFetch(url, { method: 'POST', headers: {}, body: '{}' });

  it('production transport refuses loopback by IP literal and by hostname, before connecting', async () => {
    hits.length = 0;
    await expect(post(`http://127.0.0.1:${port}/hooks`)).rejects.toThrow(/non-public address 127\.0\.0\.1/);
    await expect(post(`http://localhost:${port}/hooks`)).rejects.toThrow(/non-public address/);
    expect(hits).toEqual([]);
  });

  it('never follows a redirect: a 3xx is a failed delivery and the redirect target is not called', async () => {
    hits.length = 0;
    const clock = new FakeClock('2026-10-15T08:00:00Z');
    const m = await seedMerchant(h.db, { webhookUrl: `http://127.0.0.1:${port}/redirect` });
    const id = await enqueueWebhook(h.db, { merchantId: m.id, event: 'payment.succeeded', payload: {}, now: clock.now() });
    const d = new WebhookDispatcher(h.db, clock, (url, init) => fetch(url, init));
    expect(await d.runOnce()).toBe(0);
    expect(hits).toEqual(['/redirect']);
    const [row] = await h.db.select().from(webhookOutbox).where(eq(webhookOutbox.id, id));
    expect(row).toMatchObject({ deliveredAt: null, lastError: 'HTTP 307' });
  });
});
