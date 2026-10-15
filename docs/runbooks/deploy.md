# Runbook — Deploys, rollbacks and secrets

Infrastructure and first-time setup: [`infra/README.md`](../../infra/README.md). Migration rules:
[decision 0007](../decisions/0007-expand-contract-migrations.md).

## How a release reaches production

```text
merge to main ──▶ CI (typecheck, tests, migration check, docker smoke, terraform validate)
              ──▶ Deploy workflow: build merchantflo:<commit> once ──▶ staging
                                                                         │  soak, smoke, load test
run Deploy by hand: environment=production, image_tag=<same commit> ─────┘  (reviewer approves)
```

Every deploy (`scripts/deploy/ecs-deploy.sh`, run by the workflow):

1. registers new api, worker and migrate task definition revisions — copies of the latest revision
   (which Terraform owns) with only the image changed;
2. runs the **migrate** task once (`ROLE=migrate`, under a Postgres advisory lock) and **stops if it
   fails** — the running services are not touched;
3. rolls the api and worker services (new tasks must pass their health checks before old ones stop;
   ECS's circuit breaker rolls a failing deployment back by itself) and fails the job if that happened;
4. checks `/readyz` and `/health` through the load balancer.

The api and worker refuse to start against a database missing a migration their code needs
("database schema is behind this release"), so a skipped migration can't silently run new code.

## Deploying

| What | How |
|---|---|
| Staging | Automatic after CI passes on `main`. |
| Production | Actions → **Deploy** → Run workflow: `environment: production`, `image_tag: <commit running in staging>`. A reviewer approves the `production` environment. |
| Dev, or redeploy staging | Same, with that environment; leave `image_tag` blank to build the selected branch's commit. |
| Apply a changed variable or secret now | Redeploy the commit that is already running (`image_tag`); new tasks read the new values. |

Before promoting to production: staging has run the commit for at least a day with no alarms,
`scripts/compose-smoke.sh` passes against staging (`BASE_URL`, `ADMIN_TOKEN`), and any migration in
the release passed `npm run check:migrations` (CI enforces it).

## Rolling back

Redeploy the previous commit: Deploy → `environment`, `image_tag: <previous commit>`. The database
stays as it is: migrations only expand the schema, so the previous release works on it. The migrate
step finds nothing to apply (the database is *ahead*, which startup accepts).

Find the previous commit in the environment's deployment history on GitHub, or:
`aws ecs describe-task-definition --task-definition merchantflo-<env>-api:<revision - 1> --query 'taskDefinition.containerDefinitions[0].image'`.

Never "fix" a release by rolling the database back; restore only for data loss
([backup and restore](backup-restore.md)).

## When a deploy fails

| Symptom in the job log | Meaning | Do |
|---|---|---|
| `migration failed (exit code 1 …)` | A migration errored; nothing was rolled. | Read the printed migrate log. Pending migrations run in one transaction, so none of them were applied. Fix the migration (it never reached any database) or add a corrective one, and deploy again. |
| `migration failed (exit code None, CannotPullContainerError …)` | The task never started. | Image tag missing from ECR, or the deploy role / NAT is broken. |
| `… is running …, not …: the deployment was rolled back` | New tasks failed health checks. | ECS service → Events, and the api/worker log group: usually a missing secret or env var ("Cannot start: …"). |
| `/readyz` smoke check fails | Tasks run but can't reach the database, or the ALB has no healthy target. | See [alerts](alerts.md#api-no-healthy-targets). |

## Rotating secrets

Secrets live in Secrets Manager as `merchantflo-<env>/<NAME>`; Terraform set the first values and
ignores later changes. After changing one, redeploy the running commit so new tasks read it.

| Secret | Procedure | Effect |
|---|---|---|
| `CREDENTIALS_KEYS` (seals merchants' PSP credentials) | Generate a key (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), **prepend** it: `k2:<new>,k1:<old>`. Redeploy. Old credentials stay readable (k1) and are resealed with k2 on their next update. Remove `k1` only once nothing is sealed with it. | None for merchants. |
| `ADMIN_TOKEN` | Put a new random value (48+ chars); redeploy. | Operator scripts need the new token. |
| `CUSTOMER_TOKEN_SECRET` | New random value (64 chars); redeploy. | Outstanding customer status tokens and checkout client tokens stop working; customers mid-checkout must reload. Do it at a quiet hour. |
| Database password | `aws rds modify-db-instance --db-instance-identifier merchantflo-<env> --master-user-password <new> --apply-immediately`, then update the password inside `DATABASE_URL`, then redeploy at once. | Running tasks keep their open connections; new connections need the new URL. |

## Running the production image locally

```sh
docker compose up -d --build --wait     # postgres, migrate (once), api on :3000, worker
bash scripts/compose-smoke.sh           # readiness, onboarding, an AutoPay debit, ops metrics
docker compose down -v
```

On Windows, building from a OneDrive folder can fail with `invalid file request <path>`: OneDrive's
cloud-file placeholders confuse BuildKit. Build from a clone outside OneDrive (or
`git archive HEAD | tar -x -C <dir>`).
