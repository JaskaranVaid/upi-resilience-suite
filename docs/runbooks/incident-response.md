# Runbook — Incident response

For anything that is harming, or could harm, customers, merchants or their data: wrong or
duplicate debits, debits in a restricted window, a security breach, leaked secrets, a PSP
misbehaving at scale. Operational alarms have their own first steps in the
[alerts runbook](alerts.md); come here when an alarm turns out to be an incident.

## Roles

One person is **incident lead** (first founder to respond, until handed over). They decide, keep a
timeline, and are the only one talking to merchants. Others investigate and fix.

## 1. Contain (first 15 minutes)

1. **Stop new money movement** if there is any doubt: ops console → Kill switch → pause the
   smallest scope that surely covers the problem (a PSP, a merchant, or everything).
   [Kill-switch runbook](kill-switch.md). This is always safe.
2. Start a timeline (shared doc): times in IST, what was seen, what was done, by whom.
3. Preserve evidence: do not delete logs, rows or tasks. Note the image running (ECS console →
   service → task definition revision → image tag, which is the commit).

## 2. Assess

- **What moved?** For debits/payments in the window:
  ```sql
  select id, merchant_id, state, psp_id, updated_at at time zone 'Asia/Kolkata' from debits
  where updated_at > now() - interval '2 hours' order by updated_at desc;
  ```
  Cross-check with the PSP dashboard before concluding anything about money.
- **Whose data?** Which merchants, how many customers, which fields. Remember customer identifiers
  are encrypted in the database; a database-only leak without `CREDENTIALS_KEYS` exposes amounts and
  references, not VPAs or phone numbers.
- **Still happening?** Check the audit log (ops console) for unexpected operator actions, and API
  key use per merchant.

Severity: **SEV1** money moved wrongly or personal data exposed; **SEV2** a merchant cannot take
payments; **SEV3** degraded, no harm yet.

## 3. Eradicate — by cause

| Cause | Action |
|---|---|
| Merchant API key leaked | Pause that merchant; the merchant revokes the key with the API (`/v1/api-keys`) and creates a new one; check that merchant's recent requests and events |
| Dashboard user compromised | Merchant admin disables the user; reset two-factor; check the merchant's audit events |
| Operator compromised | `npm run ops:operator -- disable --email …` ([operators runbook](operators.md)); review `operator_audit` for everything that account did; rotate `ADMIN_TOKEN` |
| `ADMIN_TOKEN` / `CUSTOMER_TOKEN_SECRET` leaked | New value in Secrets Manager → force a new deployment of api and worker. A new `CUSTOMER_TOKEN_SECRET` invalidates open checkout links (customers restart checkout) |
| `CREDENTIALS_KEYS` leaked | Add a new key **first** in the ring, deploy, run `npm run privacy:backfill`, re-save every PSP connection's credentials (re-seals them), then rotate the PSP credentials themselves at each provider, then remove the old key |
| PSP credentials leaked | The merchant rotates them at the PSP and updates the connection; pause that connection until done |
| Bug moving money wrongly | Keep the pause; fix forward with a test reproducing it; deploy; lift the pause for one merchant first |
| Malicious dependency / image | Roll back to the last good image ([deploy runbook](deploy.md)); rotate every secret the process could read |

## 4. Notify

- **Merchants affected:** within ⟨24⟩ hours of awareness for a personal-data breach (our DPA
  commitment), sooner for money movement. What happened, what data/payments, what we did, what
  they should do. The incident lead sends it.
- **Data Protection Board / data principals:** merchants are the data fiduciaries and notify; we
  give them what they need. Counsel confirms our own duties (founder action #21).
- **PSPs:** if their systems or credentials are involved.
- **CERT-In:** reportable cyber incidents within 6 hours of noticing (CERT-In directions, April
  2022) — counsel to confirm which incidents apply to us.

## 5. Recover and review

1. Lift pauses gradually (one merchant or PSP first), watching Metrics and alarms.
2. Reconcile with PSP reports for the affected window; open cases for any customer debited wrongly.
3. Within 5 working days: a blameless review — timeline, root cause, what made it worse, actions
   with owners. Add a test, an alarm or a runbook step for each lesson; update the
   [threat model](../security/threat-model.md) if a boundary failed.
