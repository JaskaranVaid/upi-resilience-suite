# Security policy

Merchantflo handles payment instructions and customer identifiers for merchants in India. We take
reports seriously and answer quickly.

## Reporting a vulnerability

E-mail **security@merchantflo.in** (or use GitHub's *Report a vulnerability* on this repository)
with what you found, how to reproduce it and its impact. Please don't open a public issue, test
against production merchants' data, or degrade the service.

We acknowledge within 2 business days, give an assessment within 5, and tell you when it's fixed.
We don't take legal action against good-faith research that follows this policy.

## In scope

The API (`/v1`), checkout endpoints and `checkout.js`, the merchant dashboard, the ops console,
PSP webhook endpoints, the Node SDK, and this repository's infrastructure code.

## How we work

- Dependencies: `npm audit` (high/critical) and Dependabot; container images scanned by Trivy.
- Code: CodeQL on every change; secret scanning (gitleaks) over the full history.
- Design: [threat model](docs/security/threat-model.md); external penetration test before go-live.
