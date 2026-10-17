# 0009 — Engine A sends the pre-debit notice, so a debit runs at least a day after hand-over

Date: 2026-10-17 · Status: Accepted

## Context
The founding brief ("UPI Taxation Business Gap Analysis" §5, "Merchantflo Divisions" §2) describes
Engine A catching a debit at 10:30 and firing it at 13:01 the same day. That only works if the
customer was already notified, at least 24 hours earlier, of a debit on that date.

In Merchantflo, Merchantflo sends that notice itself, through the merchant's PSP. On Cashfree's
controlled flow the execution must reference the notification Merchantflo sent, at least 25 hours
later. A debit handed over without an earlier notice therefore cannot run the same day.

## Decision
- Every debit gets its notice from Merchantflo. It runs off-peak on the notified date, never
  sooner than the provider's notice period (24 hours by regulation, 25 on Cashfree) plus a
  30-minute buffer.
- A debit with a `dueDate` at least 2 days ahead runs on its due date. One handed over on the due
  date, or without one, runs the next day: the README's 10:30 request on 15 Oct runs at about
  14:17 on 16 Oct.
- Slots are spread across the 13:00–17:00 window instead of one 13:01 spike, so Merchantflo does
  not recreate the burst NPCI's rule is meant to remove.

## Consequences
- The integration guide tells merchants to send each debit at least 2 days before its due date.
- Handing a debit over on its due date costs a day of collection. That is the price of a valid
  notice, not of the peak-hour rule.
- Not built: accepting a notice the merchant's own system already sent (its date and the PSP's
  payment reference), which would let such a debit run off-peak the same day. Revisit if a
  design partner's PSP already notifies its customers.
- Peak-hour rescue value is credited only to debits meant to run when they were requested (no
  `dueDate`, or a `dueDate` of that day), never to debits requested ahead of time.
