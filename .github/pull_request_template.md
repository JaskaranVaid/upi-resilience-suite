## What and why

<!-- One or two sentences: the behaviour this changes and the reason. Link the roadmap phase / plan. -->

## How it was verified

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] New behaviour has tests (including the failure path)

## Safety checklist (payments)

- [ ] No debit can execute inside a peak/blackout window or on an un-notified date
- [ ] No path can debit a customer twice (idempotency, status check before retry/failover)
- [ ] No secret, credential or full customer identifier is logged or returned by an API
- [ ] Regulatory numbers come from `src/config/rules.ts`, not literals
- [ ] Migrations are additive or have a documented rollout
