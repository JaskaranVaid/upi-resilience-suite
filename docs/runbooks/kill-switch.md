# Runbook — Kill switch

The kill switch stops **new money movement** within seconds, without a deploy. Use it whenever
continuing could harm customers or merchants: a suspected double-debit bug, debits in a
restricted window, a PSP behaving strangely, a merchant reporting debits they did not ask for, a
security incident.

**When in doubt, pause.** A pause cancels nothing and loses nothing. Lifting it lets everything
that waited carry on.

## What a pause does

| | Paused | Keeps running |
|---|---|---|
| AutoPay | No new debits claimed, no new pre-debit notices | Debits already executing finish and are confirmed by status checks |
| Payments | `POST /v1/payments` and checkout "pay" answer **503 `EXECUTION_PAUSED`** | Pending payments are status-checked and complete or fail normally |
| Routing | A paused PSP is skipped; others take its traffic (failover) | Status checks still go to the paused PSP (they move no money) |
| Everything else | — | Settlement reconciliation, merchant webhooks, dashboards, API reads |

Debits whose scheduled time passes during a pause stay `SCHEDULED`. After the pause lifts the
worker picks them up; if their notified date has passed, it sends a fresh pre-debit notice and runs
them on the new date (never a debit without a valid notice).

## Scopes

| Scope | Target | Use for |
|---|---|---|
| **Everything** (GLOBAL) | — | Platform-wide bug, security incident, restricted-window execution |
| **One merchant** | Merchant id (`mer_…`; the console suggests ids as you type the name) | A merchant's misconfiguration or complaint, suspected compromised API key |
| **One PSP** | A PSP connection id (`con_…`), a shared adapter id (e.g. `pspA`), or `provider:<name>` for every connection of that provider (e.g. `provider:cashfree`) | A PSP incident: wrong statuses, timeouts, duplicate executions |

Merchants of a paused PSP fail over to their other connections. A debit whose every eligible PSP
is paused waits (rechecked every few minutes) instead of burning an attempt.

## How

### Ops console (normal path)

1. Sign in at `https://<api host>/ops/` with your password and authenticator code. You need the
   OWNER or OPERATOR role ([operators runbook](operators.md)).
2. **Kill switch** → choose the scope, give the target, write a reason (everyone sees it, and it is
   audited) → **Pause** → confirm.
3. The red banner at the top shows every pause in force. The `execution-paused` alarm fires after
   30 minutes so a forgotten pause cannot linger.
4. To resume: **Lift** on the pause → confirm. Check **Metrics**: `Debit backlog` should drain.

### Without the console

If the console is unreachable but the database is (one-off task with `psql`):

```sql
-- pause everything
insert into execution_pauses (id, scope, target, reason, created_by, created_at)
values ('pse_manual_' || to_char(now(), 'YYYYMMDDHH24MISS'), 'GLOBAL', null, '<reason>', null, now());
-- lift
update execution_pauses set lifted_at = now() where id = '<id>' and lifted_at is null;
```

Then add an `operator_audit` row by hand describing what you did and why. If nothing at all is
reachable, scale the worker to zero (`aws ecs update-service … --service merchantflo-<env>-worker
--desired-count 0`) — this also stops status checks and webhooks, so restore it as soon as the
console works.

## Drill (founder action #23)

On staging, quarterly and before go-live:

1. Schedule test-mode AutoPay debits for a few minutes ahead and create a pending collect payment.
2. Pause **Everything**. Check: no new `EXECUTING` debits; `POST /v1/payments` → 503; the pending
   payment still completes; webhooks still deliver; banner and `executionPausesActive = 1`.
3. Pause one merchant and lift the global pause: only that merchant waits.
4. Pause `provider:<sandbox PSP>`: debits fail over to the other connection.
5. Lift everything. The waiting debits run (with fresh notices if their date passed).
6. Record the date, who ran it and anything surprising here:

| Date | Environment | Who | Result |
|---|---|---|---|
| | | | |
