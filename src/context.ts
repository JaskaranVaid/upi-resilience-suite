import { realSleep, systemClock, type Clock, type Sleep } from './clock.js';
import { IssueAnalytics } from './analytics/issues.js';
import { PspAnalytics } from './analytics/psps.js';
import { SettlementAnalytics } from './analytics/settlements.js';
import { StatementService } from './analytics/statement.js';
import { ValueService } from './analytics/value.js';
import { SessionService, type AuthConfig } from './auth/sessions.js';
import { UserService } from './auth/users.js';
import { ApiKeyService } from './auth/api-keys.js';
import { MandateImporter } from './mandates/import.js';
import { CheckoutService } from './checkout/service.js';
import { CheckoutSessionService } from './checkout/sessions.js';
import { DEFAULT_POLLING, type PollingConfig } from './config/polling.js';
import type { Db } from './db/client.js';
import { DisputeService } from './disputes/service.js';
import { PaymentService } from './payments/service.js';
import { PspRegistry } from './psp/registry.js';
import { PspWebhookIngest } from './psp/webhook-ingest.js';
import type { PspAdapter } from './psp/types.js';
import { PaymentQueryService } from './query/payments.js';
import { HealthTracker, type HealthOptions } from './routing/health.js';
import { Router, type RouterOptions } from './routing/router.js';
import { SchedulerService, type SchedulerOptions } from './scheduler/service.js';
import { DebitWorker, type WorkerOptions } from './scheduler/worker.js';
import { StatusPoller } from './tracking/poller.js';
import { SettlementReconciler, type ReconOptions } from './settlements/reconciler.js';
import { TrackingService } from './tracking/service.js';
import { WebhookDeliveryService } from './webhooks/deliveries.js';
import { WebhookDispatcher, type FetchLike } from './webhooks/outbox.js';
import { publicTargetGuard, type ResolveHost, type WebhookTargetPolicy } from './webhooks/url.js';
import { publicOnlyFetch } from './webhooks/http.js';
import { DEFAULT_RATE_LIMITS, type RateLimits } from './api/rate-limit.js';
import { AuthFailureLimiter } from './api/auth-failures.js';
import { SecretBox } from './security/secrets.js';
import { connectionAdapterFactory } from './psp/connections.js';
import { Lifecycle } from './ops/lifecycle.js';
import { OperatorService } from './ops-console/operators.js';
import { ExecutionControl } from './ops-console/pauses.js';
import type { Logger } from './ops/log.js';
import type { ConnectionAdapterFactory } from './psp/registry.js';

export interface AppContext {
  db: Db;
  clock: Clock;
  adminToken: string;
  health: HealthTracker;
  router: Router;
  scheduler: SchedulerService;
  checkout: CheckoutService;
  checkoutSessions: CheckoutSessionService;
  payments: PaymentService;
  worker: DebitWorker;
  dispatcher: WebhookDispatcher;
  webhookDeliveries: WebhookDeliveryService;
  psps: PspRegistry;
  tracking: TrackingService;
  poller: StatusPoller;
  reconciler: SettlementReconciler;
  disputes: DisputeService;
  users: UserService;
  apiKeys: ApiKeyService;
  mandateImporter: MandateImporter;
  sessions: SessionService;
  queries: PaymentQueryService;
  /** Set the Secure flag on session cookies (true in production / behind HTTPS). */
  secureCookies: boolean;
  /** HMAC key for payment-scoped customer status tokens. */
  customerTokenSecret: string;
  analytics: { value: ValueService; psps: PspAnalytics; issues: IssueAnalytics; statement: StatementService; settlements: SettlementAnalytics };
  webhookIngest: PspWebhookIngest;
  /** Per-caller request limits; null disables them. */
  rateLimits: RateLimits | null;
  /** Per-IP budget for failed authentication; null when rate limits are disabled. */
  authFailures: AuthFailureLimiter | null;
  /** 'public-only' refuses merchant webhook URLs that are not https or point at private networks. */
  webhookTargets: WebhookTargetPolicy;
  /** Seals merchants' PSP credentials. */
  secrets: SecretBox;
  /** Builds the adapter for a merchant connection (also used to check credentials before saving). */
  connectionAdapters: ConnectionAdapterFactory;
  /** Public base URL of this API, for showing PSP webhook URLs (null = relative paths). */
  publicBaseUrl: string | null;
  /** Draining state: /readyz fails once shutdown begins. */
  lifecycle: Lifecycle;
  /** Merchantflo staff accounts (ops console). */
  operators: OperatorService;
  /** The kill switch. */
  pauses: ExecutionControl;
}

export function buildContext(args: {
  db: Db;
  /** Shared PSP adapters (mocks, a platform sandbox account): usable by TEST merchants only. */
  adapters: PspAdapter[];
  /** Seals merchants' PSP credentials (development key by default). */
  secrets?: SecretBox;
  /** Builds adapters for merchant connections (real Cashfree/mock by default; faked in tests). */
  connectionAdapters?: ConnectionAdapterFactory;
  publicBaseUrl?: string;
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
  customerTokenSecret?: string;
  rateLimits?: Partial<RateLimits> | null;
  webhookTargets?: WebhookTargetPolicy;
  /** Resolves a webhook hostname to IP addresses (DNS by default; stubbed in tests). */
  resolveHost?: ResolveHost;
  recon?: Partial<ReconOptions>;
  /** Structured logger for background failures (console.error when omitted). */
  log?: Logger;
}): AppContext {
  const clock = args.clock ?? systemClock;
  const sleep = args.sleep ?? realSleep;
  const health = new HealthTracker(args.health ?? {}, clock);
  const secrets = args.secrets ?? SecretBox.development();
  const connectionAdapters = args.connectionAdapters ?? connectionAdapterFactory({ clock });
  const psps = new PspRegistry(args.adapters, { db: args.db, secrets, clock, build: connectionAdapters });
  const operators = new OperatorService({ db: args.db, clock, secrets });
  const pauses = new ExecutionControl({ db: args.db, clock, operators });
  const router = new Router(psps, health, clock, sleep, { ...args.router, pausedPsps: () => pauses.pausedPsps() });
  const polling = { ...DEFAULT_POLLING, ...args.polling };
  const tracking = new TrackingService({ db: args.db, clock, psps, cfg: polling });
  const value = new ValueService({ db: args.db });
  const issues = new IssueAnalytics({ db: args.db });
  const settlements = new SettlementAnalytics({ db: args.db });
  const webhookTargets = args.webhookTargets ?? 'any';
  const rateLimits = args.rateLimits === null ? null : { ...DEFAULT_RATE_LIMITS, ...args.rateLimits };
  // Production policy: connect only to public addresses, checked at connect time (no DNS rebinding).
  const fetchImpl: FetchLike = args.fetchImpl ?? (webhookTargets === 'public-only' ? publicOnlyFetch : (url, init) => fetch(url, init));
  const checkout = new CheckoutService({ db: args.db, clock });
  const payments = new PaymentService({ db: args.db, clock, router, tracking, pauses });
  const queries = new PaymentQueryService({ db: args.db, clock, cfg: polling, psps });
  const customerTokenSecret = args.customerTokenSecret ?? 'dev-customer-token-secret-not-for-production';
  const logError = args.log ? (msg: string, err?: unknown) => args.log!.error(msg, err) : undefined;
  return {
    db: args.db,
    clock,
    adminToken: args.adminToken,
    health,
    router,
    scheduler: new SchedulerService({ db: args.db, clock, router, opts: args.scheduler }),
    checkout,
    webhookDeliveries: new WebhookDeliveryService({ db: args.db, clock }),
    checkoutSessions: new CheckoutSessionService({ db: args.db, clock, checkout, payments, psps, queries, tokenSecret: customerTokenSecret }),
    payments,
    worker: new DebitWorker({ db: args.db, clock, router, tracking, pauses, opts: args.worker, ...(logError ? { log: logError } : {}) }),
    dispatcher: new WebhookDispatcher(args.db, clock, fetchImpl, {
      ...(webhookTargets === 'public-only' ? { targetGuard: publicTargetGuard(args.resolveHost) } : {}),
    }),
    psps,
    tracking,
    poller: new StatusPoller({ db: args.db, clock, tracking, ...(logError ? { log: logError } : {}) }),
    reconciler: new SettlementReconciler({ db: args.db, clock, psps, tracking, ...(args.recon ? { opts: args.recon } : {}), ...(logError ? { log: logError } : {}) }),
    disputes: new DisputeService({ db: args.db, clock, psps, tracking }),
    users: new UserService({ db: args.db, clock }),
    apiKeys: new ApiKeyService({ db: args.db, clock }),
    mandateImporter: new MandateImporter({ db: args.db, clock, psps }),
    sessions: new SessionService({ db: args.db, clock, ...(args.auth ? { cfg: args.auth } : {}) }),
    queries,
    secureCookies: args.secureCookies ?? false,
    customerTokenSecret,
    analytics: {
      value,
      psps: new PspAnalytics({ db: args.db }),
      issues,
      statement: new StatementService({ db: args.db, value, issues, settlements }),
      settlements,
    },
    webhookIngest: new PspWebhookIngest({ db: args.db, clock, tracking }),
    rateLimits,
    authFailures: rateLimits ? new AuthFailureLimiter(rateLimits.authFailuresPerMinute) : null,
    webhookTargets,
    secrets,
    connectionAdapters,
    publicBaseUrl: args.publicBaseUrl ?? null,
    lifecycle: new Lifecycle(),
    operators,
    pauses,
  };
}
