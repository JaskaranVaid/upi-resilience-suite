import { realSleep, systemClock, type Clock, type Sleep } from './clock.js';
import { CheckoutService } from './checkout/service.js';
import type { Db } from './db/client.js';
import { PaymentService } from './payments/service.js';
import type { PspAdapter } from './psp/types.js';
import { HealthTracker, type HealthOptions } from './routing/health.js';
import { Router, type RouterOptions } from './routing/router.js';
import { SchedulerService, type SchedulerOptions } from './scheduler/service.js';
import { DebitWorker, type WorkerOptions } from './scheduler/worker.js';
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
}): AppContext {
  const clock = args.clock ?? systemClock;
  const sleep = args.sleep ?? realSleep;
  const health = new HealthTracker(args.health ?? {}, clock);
  const router = new Router(args.adapters, health, clock, sleep, args.router);
  const pspIds = args.adapters.map((a) => a.id);
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
    payments: new PaymentService({ db: args.db, clock, router, pspIds }),
    worker: new DebitWorker({ db: args.db, clock, router, opts: args.worker }),
    dispatcher: new WebhookDispatcher(args.db, clock, fetchImpl),
  };
}
