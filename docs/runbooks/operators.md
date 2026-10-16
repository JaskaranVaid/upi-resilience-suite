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

New credentials (a one-time password and the authenticator `otpauth://` URI) are **never printed
in the clear**: the CLI's output ends up in logs. They are encrypted to the new operator's own
public key, and only their private key opens them.

**1. The new operator makes a key pair on their own machine** and sends you `op.pub` (it is not
secret; `op.key` never leaves their machine):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out op.key
openssl pkey -in op.key -pubout -out op.pub
```

**2. You create the account.** Locally / against a reachable database:

```bash
npm run ops:operator -- create --email asha@merchantflo.in --name "Asha" --role OWNER --recipient-key op.pub
```

In AWS (no shell into the VPC), run the CLI as a one-off task on the migrate task definition, which
has the database URL and `CREDENTIALS_KEYS`. The public key goes inline (needs `jq`):

```bash
env=staging; name=merchantflo-$env
network=$(aws ecs describe-services --cluster $name --services $name-api --query 'services[0].networkConfiguration' --output json)
overrides=$(jq -n --arg pem "$(cat op.pub)" '{containerOverrides:[{name:"app",command:["node","dist/cli/ops-operator.js","create","--email","asha@merchantflo.in","--name","Asha","--role","OWNER","--recipient-key",$pem]}]}')
task=$(aws ecs run-task --cluster $name --task-definition $name-migrate --launch-type FARGATE \
  --network-configuration "$network" --overrides "$overrides" --started-by ops-operator \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster $name --tasks $task
aws logs get-log-events --log-group-name /merchantflo/$env/migrate --log-stream-name "migrate/app/${task##*/}" --query 'events[].message' --output text
```

The output is a `created OWNER …` line and one `mfh1.…` line. Send the `mfh1.…` line to the new
operator (any channel: it is encrypted).

**3. The new operator opens it** on their machine and signs in:

```bash
npm run ops:operator -- decrypt --key op.key 'mfh1.…'   # prints {"email","password","otpauthUri"}
```

1. Add the URI to an authenticator app (paste it, or render it as a QR code locally — never with an
   online QR generator).
2. Sign in at `/ops/` with e-mail, the one-time password and the current code.
3. **Account** → change the password (14+ characters). This ends any other session.

## Lost phone or suspected compromise

```bash
npm run ops:operator -- reset-2fa --email asha@merchantflo.in --recipient-key op.pub   # new authenticator URI (encrypted), all sessions end
npm run ops:operator -- disable --email asha@merchantflo.in                            # leaving, or compromise: sessions end now
```

For a lost phone, the operator makes a new key pair if the old private key went with the phone's
laptop. In AWS run the same commands through the one-off task above. Every change is in the audit log.

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
