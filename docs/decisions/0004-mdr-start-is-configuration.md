# 0004 — The MDR start date is configuration

Date: 2026-10-15 · Status: Accepted

## Context
The MDR slabs were hard-coded as effective from 15 Oct 2026. On 14–15 Oct 2026 NPCI postponed the
start to "after Diwali 2026" without a new date (see `docs/regulatory/fact-sheet.md`). Quoting a fee
that is not charged would steer customers away from UPI for no reason and overstate savings.

## Decision
`MDR_EFFECTIVE_FROM` (IST date) sets the start. Unset means **not in force**: UPI is quoted as free,
no steering offers are made and no MDR savings are recorded. `GET /v1/rules` reports
`mdrRegime.status` as `NOT_SCHEDULED`, `SCHEDULED` or `IN_FORCE`. Slab values stay in code
(`MDR_2026`) because they are confirmed by NPCI's FAQs.

## Consequences
- Ops sets the variable the day NPCI confirms the date; no deploy of new code is needed.
- Tests model the announced 15 Oct 2026 date via `test/setup.ts`; demos state their assumption.
- If slabs change, add a new rule set version rather than editing `MDR_2026`.
