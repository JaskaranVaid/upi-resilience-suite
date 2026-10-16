# Runbook — Operator accounts, privacy tasks and the ops console

Merchantflo staff use the **ops console** at `https://<api host>/ops/`: kill switch, live metrics,
audit log and data erasure. Accounts are separate from merchant dashboard accounts and **always**
need a password and an authenticator code.

| Role | Can |
|---|---|
| OWNER | Everything an operator can; reserved for founders |
| OPERATOR | Pause and lift, erase data, view everything |
| VIEWER | View pauses, metrics and the audit log |

Accounts are created and repaired from a shell, not from the console, so a stolen console session
cannot create more accounts.

## Create an operator

**Locally / against a reachable database:**

```bash
npm run ops:operator -- create --email asha@merchantflo.in --name "Asha" --role OWNER
```

**In AWS** (no shell into the VPC): run the CLI as a one-off task on the migrate task definition,
which has the database URL and `CREDENTIALS_KEYS`:

```bash
env=staging; name=merchantflo-$env
network=$(aws ecs describe-services --cluster $name --services $name-api --query 'services[0].networkConfiguration' --output json)
task=$(aws ecs run-task --cluster $name --task-definition $name-migrate --launch-type FARGATE \
  --network-configuration "$network" --started-by ops-operator \
  --overrides '{"containerOverrides":[{"name":"app","command":["node","dist/cli/ops-operator.js","create","--email","asha@merchantflo.in","--name","Asha","--role","OWNER"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $name --tasks $task
stream="migrate/app/${task##*/}"
aws logs get-log-events --log-group-name /merchantflo/$env/migrate --log-stream-name "$stream" --query 'events[].message' --output text
aws logs delete-log-stream --log-group-name /merchantflo/$env/migrate --log-stream-name "$stream"   # it holds the secrets
```

The output has a **one-time password** and an `otpauth://` URI. Give both to the person over a
channel other than the one you used to tell them their e-mail (e.g. password by phone, URI in a
password manager share). They:

1. Add the URI to an authenticator app (paste it, or render it as a QR code locally — never with an
   online QR generator).
2. Sign in at `/ops/` with e-mail, password and the current code.
3. **Account** → change the password (14+ characters). This ends any other session.

Delete the log stream as above even if you think nobody else can read it.

## Lost phone or suspected compromise

```bash
npm run ops:operator -- reset-2fa --email asha@merchantflo.in   # new authenticator URI, all sessions end
npm run ops:operator -- disable --email asha@merchantflo.in     # leaving, or compromise: sessions end now
```

In AWS run the same commands through the one-off task above. Every change is in the audit log.

Merchant dashboard users who lose their phone are reset by their own merchant admin (Team →
Two-factor → Reset), not by Merchantflo.

## Erase a customer's data on a merchant's behalf

Normally merchants call `POST /v1/privacy/erasure` themselves. When a merchant asks us in writing:

1. Confirm the request came from the merchant (known contact, ticket).
2. Ops console → **Data erasure** → merchant, the reason or ticket number, the customer's VPA
   and/or phone → **Erase**.
3. Reply to the merchant with the counts shown. The audit log keeps counts and your reason, never
   the identifiers. Backup copies expire within 35 days ([retention policy](../legal/retention-policy.md)).

## Seal old data after enabling encryption or rotating keys

Customer identifiers are encrypted at rest with a key derived from `CREDENTIALS_KEYS`. After adding
a new key at the front of the ring (and deploying), or on a database with rows written before
encryption, run:

```bash
npm run privacy:backfill            # in AWS: command ["node","dist/cli/privacy-backfill.js"] via the one-off task
```

It is safe to re-run and to run while the service is live; it prints how many rows it sealed. Keep
the old key in the ring until it has run (and until PSP credentials are re-sealed).

## Retention job

The worker applies the retention policy once a day: it clears identifiers on finished payments and
sessions older than `PERSONAL_DATA_RETENTION_DAYS` (180), on long-idle revoked mandates, and
deletes webhook log rows older than `WEBHOOK_LOG_RETENTION_DAYS` (30). Each run that changed
something appears in the ops audit log as `DATA_RETENTION_PURGED` with counts.
