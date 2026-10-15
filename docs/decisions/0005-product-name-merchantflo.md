# 0005 — Product name: Merchantflo

Date: 2026-10-15 · Status: Accepted

## Context
The founding documents call the product Merchantflo; the code, README and dashboard said
"UPI Payment Resilience Suite". Webhook headers (`x-resilience-*`) and the repository name use the
old name and are part of the integration surface.

## Decision
User-facing names (README, dashboard, docs, package name) say **Merchantflo**. Wire identifiers stay
as they are: webhook headers `x-resilience-event|delivery|timestamp|signature`, the session cookie
and id prefixes. Renaming them would break integrations for no benefit.

## Consequences
- The GitHub repository can be renamed by an owner at any time (GitHub redirects the old URL).
