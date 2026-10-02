import { realSleep, systemClock, type Clock, type Sleep } from './clock.js';
import { SessionService, type AuthConfig } from './auth/sessions.js';
import { UserService } from './auth/users.js';
import { CheckoutService } from './checkout/service.js';
import { DEFAULT_POLLING, type PollingConfig } from './config/polling.js';
import type { Db } from './db/client.js';
import { DisputeService } from './disputes/service.js';
import { PaymentService } from './payments/service.js';
import { PspRegistry } from './psp/registry.js';
import type { PspAdapter } from './psp/types.js';
import { HealthTracker, type HealthOptions } from './routing/health.js';
import { Router, type RouterOptions } from './routing/router.js';
import { SchedulerService, type SchedulerOptions } from './scheduler/service.js';
import { DebitWorker, type WorkerOptions } from './scheduler/worker.js';
import { StatusPoller } from './tracking/poller.js';
import { TrackingService } from './tracking/service.js';
import { WebhookDispatcher, type FetchLike } from './webhooks/outbox.js';

export interface AppContext {
  db: Db;
  clock: Clock;
  adminToken: string;
  pspIds: string[];
  health: HealthTracker;
  router: Router;
  scheduler: SchedulerService;
  checkout: CheckoutService;
  payments: PaymentService;
  worker: DebitWorker;
  dispatcher: WebhookDispatcher;
  psps: PspRegistry;
  tracking: TrackingService;
  poller: StatusPoller;
  disputes: DisputeService;
  users: UserService;
  sessions: SessionService;
  /** Set the Secure flag on session cookies (true in production / behind HTTPS). */
  secureCookies: boolean;
}

export function buildContext(args: {
  db: Db;
  adapters: PspAdapter[];
  adminToken: string;
  clock?: Clock;
  sleep?: Sleep;
  fetchImpl?: FetchLike;
  health?: HealthOptions;
  router?: RouterOptions;
  scheduler?: Partial<SchedulerOptions>;
  worker?: Partial<WorkerOptions>;
  polling?: Partial<PollingConfig>;
  auth?: Partial<AuthConfig>;
  secureCookies?: boolean;
}): AppContext {
  const clock = args.clock ?? systemClock;
  const sleep = args.sleep ?? realSleep;
  const health = new HealthTracker(args.health ?? {}, clock);
  const router = new Router(args.adapters, health, clock, sleep, args.router);
  const pspIds = args.adapters.map((a) => a.id);
  const psps = new PspRegistry(args.adapters);
  const tracking = new TrackingService({ db: args.db, clock, psps, cfg: { ...DEFAULT_POLLING, ...args.polling } });
  const fetchImpl: FetchLike = args.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    db: args.db,
    clock,
    adminToken: args.adminToken,
    pspIds,
    health,
    router,
    scheduler: new SchedulerService({ db: args.db, clock, router, opts: args.scheduler }),
    checkout: new CheckoutService({ db: args.db, clock }),
    payments: new PaymentService({ db: args.db, clock, router, pspIds, tracking }),
    worker: new DebitWorker({ db: args.db, clock, router, tracking, opts: args.worker }),
    dispatcher: new WebhookDispatcher(args.db, clock, fetchImpl),
    psps,
    tracking,
    poller: new StatusPoller({ db: args.db, clock, tracking }),
    disputes: new DisputeService({ db: args.db, clock, psps, tracking }),
    users: new UserService({ db: args.db, clock }),
    sessions: new SessionService({ db: args.db, clock, ...(args.auth ? { cfg: args.auth } : {}) }),
    secureCookies: args.secureCookies ?? false,
  };
}
