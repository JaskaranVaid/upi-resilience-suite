# Runbook — Backups and restore

## What protects the data

| | dev | staging | production |
|---|---|---|---|
| RDS automated backups + point-in-time recovery (PITR) | 7 days | 7 days | 35 days |
| Multi-AZ standby (survives losing one zone) | no | no | yes |
| Final snapshot when the instance is deleted | no | yes | yes |
| Deletion protection | no | yes | yes |
| Secrets recoverable after deletion | immediately deleted | 30 days | 30 days |

Backups are encrypted with the environment's KMS key and stay in `ap-south-1` (RBI storage rule).
The backup window is 02:00–03:00 IST, outside the AutoPay execution peaks.

**Targets.** RPO (data we can lose): ~5 minutes — PITR replays transaction logs to any second
up to RDS's *latest restorable time*, usually under 5 minutes ago. RTO (time to restore service):
under 1 hour for the pilot's database size; measured by the drill below.

## Restore drill (monthly, and before go-live)

Proves backups restore, the copy is complete and consistent, and how long it takes. It never
touches the live database.

```sh
scripts/drills/restore-drill.sh staging                          # latest restorable time
scripts/drills/restore-drill.sh production 2026-11-02T03:15:00Z  # a chosen moment (UTC)
```

It restores `merchantflo-<env>` to a new instance `merchantflo-<env>-drill-<time>` (same subnets,
security group and parameters, single-AZ), runs the read-only verifier inside the VPC as an ECS
task (`node dist/ops/verify-cli.js` with `VERIFY_DATABASE_HOST`) — schema fully migrated, row
counts, invariants (terminal debits completed, successes carry a PSP transaction id, no webhook both
delivered and dead) — prints the timings and deletes the instance. Run it with operator
credentials (it needs RDS restore and delete); the deploy role can't.

Compare the printed row counts with the live database's (`npm run db:verify` against it, or the
dashboard) for the restore time. Record each drill:

| Date | Env | Restore point | Restore (min) | Verify (min) | Result | By |
|---|---|---|---|---|---|---|
| | | | | | | |

## Real recovery

**Lost a zone (production):** nothing to do; Multi-AZ fails over in 1–2 minutes and the endpoint
name doesn't change. Tasks reconnect (pooled connections error once, then succeed).

**Bad data (a bug or an operator wrote wrong rows):**
1. Stop writers if the damage is ongoing: worker desired count 0 (and api if needed).
2. Find the last good moment (UTC) from logs or `payment_events`.
3. Restore to a new instance at that moment — the drill script's restore step, without the delete:
   `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier merchantflo-<env> --target-db-instance-identifier merchantflo-<env>-recovered --restore-time <t> --db-subnet-group-name merchantflo-<env> --vpc-security-group-ids <db sg> --db-parameter-group-name <pg>`.
4. Prefer **repairing** the live database from the restored copy (copy the affected rows back) over
   switching: payments that happened after the restore point exist only in the live database, and
   PSPs and merchants already know about them.
5. If the live database is unusable, switch: put the restored instance's host into the
   `DATABASE_URL` secret, redeploy the running commit, then reconcile the gap with the PSPs
   (settlement reports and status checks backfill payments made after the restore point) and import
   the instance into Terraform state (`terraform import`) or rename it to the original identifier.
6. Verify with `npm run db:verify` / the drill's verifier, restart the worker, and write up the incident.

**Lost the instance (deleted):** restore from the final snapshot
(`aws rds restore-db-instance-from-db-snapshot …-final`) or, within the retention window, by PITR
from the retained automated backups; then as step 5.
