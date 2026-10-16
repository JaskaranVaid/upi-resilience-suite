# Sub-processors

> **Draft for counsel review** (founder action #21). Keep this list current: merchants get
> ⟨30⟩ days' notice of changes under the DPA.

Merchantflo uses these sub-processors to provide the service. All personal data stays in India.

| Sub-processor | Purpose | Personal data | Location |
|---|---|---|---|
| Amazon Web Services India Pvt. Ltd. | Hosting: compute (ECS), database (RDS), secrets (Secrets Manager, KMS), logs and alarms (CloudWatch, SNS) | All data the service processes, encrypted at rest | ap-south-1 (Mumbai), India |

## Not sub-processors

- **Payment providers** (Cashfree, Razorpay and others): each merchant contracts with its own
  provider and connects its own account. Merchantflo sends payment instructions to them on the
  merchant's behalf; they are the merchant's processors under the merchant's agreement with them.
- **GitHub**: hosts source code and runs CI. No customer data is stored there.
- **Alarm e-mail** (Amazon SNS e-mail subscriptions): alarm messages contain metric names and
  counts, never personal data.

## Change log

| Date | Change |
|---|---|
| ⟨date⟩ | Initial list |
