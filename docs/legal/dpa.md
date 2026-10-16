# Data Processing Agreement (outline)

> **Draft outline for counsel** (founder action #21). Not legal advice and not ready to sign. It
> records what Merchantflo actually does, so counsel can turn it into contract language.

**Parties.** ⟨Merchant⟩ (data fiduciary) and Merchantflo ⟨legal entity⟩ (data processor).

## 1. Subject matter and purpose

Merchantflo processes the merchant's customers' personal data only to: schedule and execute UPI
AutoPay debits and their pre-debit notices; start, route and track payments through the merchant's
own payment providers; reconcile settlements; send the merchant webhooks; and show the merchant
its records in the dashboard.

## 2. Data and data principals

- **Data principals:** the merchant's customers (payers).
- **Personal data:** UPI IDs (VPAs), phone numbers when a payment provider requires them, and the
  payment links or QR data handed to the customer. No card numbers, bank account numbers,
  passwords or UPI PINs ever reach Merchantflo.
- **Merchant staff:** names and e-mail addresses of dashboard users.

## 3. Merchantflo's obligations

1. Process only on the merchant's documented instructions (the API calls and settings the merchant
   makes are those instructions).
2. Keep data in India (AWS ap-south-1), including backups.
3. Security: TLS in transit; database encryption at rest; customer identifiers and payment
   provider credentials additionally encrypted by the application (AES-256-GCM) with keys held in
   AWS Secrets Manager; two-factor sign-in for Merchantflo staff; least-privilege access; audit
   trail of staff actions. Details in the [threat model](../security/threat-model.md).
4. Confidentiality: staff with access are bound by confidentiality; access is limited to
   operating the service.
5. Retention and deletion as in the [retention policy](retention-policy.md); erasure of a
   customer's identifiers on the merchant's request, through the API or by Merchantflo within
   ⟨7⟩ days of a written request.
6. Personal data breach: notify the merchant without undue delay and within ⟨24⟩ hours of becoming
   aware, with what is known, and keep updating ([incident response](../runbooks/incident-response.md)).
7. Assist the merchant with data principals' requests (access, correction, erasure) and with any
   inquiry by the Data Protection Board.
8. Sub-processors: only those listed in [subprocessors.md](subprocessors.md); ⟨30⟩ days' notice of
   changes, with a right to object.
9. Audits: provide the latest penetration test summary and answer reasonable security
   questionnaires once a year.
10. End of contract: delete or return the merchant's data within ⟨30⟩ days, except what law
    requires us to keep; backups age out within 35 days.

## 4. The merchant's obligations

- Have a lawful basis and give notice to its customers (template in the
  [privacy notice](privacy-notice.md), part B).
- Contract directly with its payment providers; those providers are the merchant's processors,
  not Merchantflo's sub-processors.
- Keep its API keys and dashboard accounts secure; turn on two-factor sign-in for admins.

## Questions for counsel

1. Liability caps and indemnities appropriate for a processor that never holds funds.
2. Whether RBI's payment data storage directions require additional clauses even though
   Merchantflo is not a payment system operator.
3. Governing law and dispute resolution.
