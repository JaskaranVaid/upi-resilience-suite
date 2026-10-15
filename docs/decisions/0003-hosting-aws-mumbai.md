# 0003 — Host on AWS Mumbai (ap-south-1)

Date: 2026-10-15 · Status: Accepted

## Context
RBI requires payment-system data to be stored only in India. The system needs managed Postgres with
point-in-time recovery, a secrets/KMS service, containers for two process roles (api, worker),
and a load balancer with a web application firewall.

## Decision
AWS `ap-south-1`: ECS Fargate (api and worker services), RDS PostgreSQL Multi-AZ, Secrets Manager +
KMS, ALB + WAF, S3, CloudWatch, provisioned with Terraform. Docker images are the deployable unit,
so moving to another India region/provider stays possible.

## Consequences
- Infrastructure as code lives in `infra/` (Phase 5).
- Backups, logs and exports stay in India.
- Local development keeps PGlite; no AWS needed to develop or test.
