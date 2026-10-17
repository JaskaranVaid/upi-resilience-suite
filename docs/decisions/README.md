# Architecture decision records

Short records of decisions that shape the product. Each states the context, the decision and its
consequences. Supersede a record with a new one rather than editing history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-rest-api-is-the-contract.md) | The REST `/v1` API is the merchant contract; the blueprint JSON is retired | Accepted |
| [0002](0002-merchants-own-psp-accounts.md) | Merchants connect their own PSP accounts; we never hold funds | Accepted |
| [0003](0003-hosting-aws-mumbai.md) | Host on AWS Mumbai (ap-south-1) | Accepted |
| [0004](0004-mdr-start-is-configuration.md) | The MDR start date is configuration, defaulting to "not in force" | Accepted |
| [0005](0005-product-name-merchantflo.md) | Product name Merchantflo; wire identifiers unchanged | Accepted |
| [0006](0006-delivery-workflow.md) | Branch per change, CI on every PR, conventional commits | Accepted |
| [0007](0007-expand-contract-migrations.md) | Migrations run once per deploy (advisory lock) and only expand the schema | Accepted |
| [0008](0008-pilot-rollout-by-mandate.md) | Pilots roll out by mandate; intake decides who executes each debit | Accepted |
| [0009](0009-engine-a-notice-timing.md) | Engine A sends the pre-debit notice, so a debit runs at least a day after hand-over | Accepted |
