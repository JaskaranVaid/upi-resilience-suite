# Data retention policy

> **Draft for counsel review** (founder action #21). Not legal advice. The periods marked
> *configurable* are what the code does today; counsel should confirm them against RBI, NPCI and
> DPDP requirements and merchants' own record-keeping duties.

Merchantflo processes data on behalf of merchants (who are the data fiduciaries towards their
customers under the Digital Personal Data Protection Act, 2023). We keep personal data only as long
as the service needs it, then remove it automatically. Financial records without personal data
(amounts, states, references, dates) are kept for the life of the merchant's account so statements
and reconciliation stay correct.

## What we keep, and for how long

| Data | Contains personal data? | Kept | Then |
|---|---|---|---|
| Customer VPA and payment link/QR on a **finished** payment | Yes | 180 days after the payment finished (*configurable*: `PERSONAL_DATA_RETENTION_DAYS`); longer while a dispute case on it is open | Fields cleared; the payment record stays |
| Customer phone and VPA on a **checkout session** | Yes | 180 days after the session was paid or expired (*configurable*) | Fields cleared |
| Customer VPA on an **AutoPay mandate** | Yes | While the mandate is active or paused; after revocation, until 180 days have passed with no debit activity (*configurable*) | Replaced with `[erased]` |
| Merchant **webhook log** (event payloads, which can include a payer VPA) | Yes | 30 days after delivery or final failure (*configurable*: `WEBHOOK_LOG_RETENTION_DAYS`) | Row deleted |
| Dashboard and ops-console **sessions** | Account identifiers | Until they expire (at most 12 h dashboard, 8 h ops) | Deleted at the next daily run |
| Payments, debits, attempts, settlement facts, cases, savings ledger (ids, amounts, states, references, timestamps) | No (after the fields above are cleared) | Life of the merchant account, then as agreed in the DPA | Deleted or returned at contract end |
| Pilot records: shadow debits and reported executions (incl. a backtest's history export), rollout history, double-debit suspects | No — mandate reference, amounts, times, outcomes, PSP transaction id; operators write resolution notes without customer identifiers | Life of the merchant account | Deleted or returned at contract end, with the payments above |
| Audit trail (`payment_events`, `operator_audit`) | Actor ids; never VPAs or phones | Life of the merchant account (evidence for disputes and regulators) | As agreed in the DPA |
| Dashboard users and operators (name, e-mail) | Yes (staff of merchants / Merchantflo) | While the account exists | Deleted on request when no longer needed for audit |
| Application logs (CloudWatch) | Ids and errors, not VPAs or phones | 365 days production, 30 staging, 14 dev | Expire automatically |
| Database backups (RDS) | Everything above as of the backup | 35 days production | Expire automatically |

All data stays in AWS ap-south-1 (Mumbai), including backups.

## How it is enforced

- The worker runs the retention job once a day (`PrivacyService.purgeExpired`); each run that changes
  anything writes one `DATA_RETENTION_PURGED` entry with counts to the operator audit log.
- Personal fields are encrypted in the database (AES-256-GCM, application-held keys), so a database
  copy without the keys does not reveal them.

## Erasure on request

A customer can ask the merchant to erase their data. The merchant calls
`POST /v1/privacy/erasure` with the customer's VPA and/or phone number, or asks Merchantflo, and an
operator uses the ops console (with a reason that is audited). Erasure removes those identifiers
from that merchant's mandates, payments, checkout sessions and webhook log at once; the audit keeps
counts, never the identifiers. Copies in backups age out within 35 days.

Data the merchant must keep by law (for example transaction records for tax or RBI purposes) is
kept without the personal fields; counsel to confirm that this satisfies both sets of duties.

## Questions for counsel

1. Are 180 days (identifiers) and 30 days (webhook logs) defensible, or do RBI/NPCI dispute windows
   require longer for UPI AutoPay disputes?
2. Is redacting identifiers while keeping the transaction record sufficient for an erasure request
   when the merchant must keep financial records?
3. Do backups (35 days) need to be mentioned to data principals explicitly?
