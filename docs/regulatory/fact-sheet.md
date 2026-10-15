# Regulatory fact sheet

Last verified: **15 Oct 2026**. Re-verify before go-live and whenever NPCI/RBI publish changes.
Every regulatory number the code uses lives in [`src/config/rules.ts`](../../src/config/rules.ts);
this page records where each comes from and how sure we are.

Confidence: **Confirmed** = official FAQ/circular or multiple consistent reports quoting it ·
**Reported** = press/industry reports, circular text not seen · **Unverified** = single source or conflicting.

## 1. UPI MDR on P2M payments

| Rule | Value in code | Confidence | Source |
|---|---|---|---|
| P2P transfers | Free | Confirmed | NPCI UPI MDR FAQs, 15 Sep 2026 ([SCC Times summary][scc]) |
| P2M ≤ ₹2,000 | Free (₹2,000 exactly is free; "above ₹2,000" pays) | Confirmed | NPCI FAQs table: ₹2,000 → nil |
| P2M > ₹2,000, general | 0.4%, cap ₹300 (reached at ₹75,000) | Confirmed | NPCI FAQs: ₹3,000 → ₹12, ₹50,000 → ₹200, ₹75,000+ → ₹300 |
| Railways, telecom, insurance, fuel, other notified | Flat ₹5 above ₹2,000 | Confirmed | NPCI FAQs |
| Capital markets (MF, brokers, investment platforms) | 0.02%, cap ₹300 | Confirmed | NPCI FAQs |
| Education (schools, colleges, exam bodies) | "Concessional or capped" — **no rate published** | Unverified | NPCI FAQs; not modelled (no invented rate) |
| Small merchants (≤ ₹1 lakh/month via UPI QR) | Zero MDR | Confirmed | NPCI FAQs (eligibility by categorisation, not GST) |
| Who pays | Merchant; no surcharge to customer; UPI apps may not add platform fees | Confirmed | NPCI FAQs |
| RuPay credit on UPI, credit lines on UPI | Outside this MDR framework | Confirmed | NPCI FAQs |
| Revenue split among participants | Not published (the brief's 16/12/12 bps split is unconfirmed) | Unverified | — |
| **Start date** | **Not in force.** Was 15 Oct 2026; NPCI postponed it to "after Diwali 2026" with no new date | Reported (14–15 Oct 2026) | [CA Club India][cac], [The Better India][tbi] |
| Legal challenge | Supreme Court declined to stay the framework (29 Sep 2026); Centre/RBI/NPCI to respond in 4 weeks | Reported | [CA Club India][cac] |

**Code consequence:** the MDR start is `MDR_EFFECTIVE_FROM` (unset = not in force). Set it the day
NPCI confirms the date. Steering offers and MDR-saved value only appear once it is in force.

**Open questions for counsel:** whether discount-based steering to non-UPI methods is acceptable
under the "no surcharge" rule (we believe yes: the customer never pays more than list price);
how "small merchant" categorisation is communicated to a merchant (we take it as a merchant flag).

## 2. UPI AutoPay execution

| Rule | Value in code | Confidence | Source |
|---|---|---|---|
| AutoPay executes only in non-peak hours | Peak 10:00–13:00 and 17:00–21:30 IST blocked | Reported (in force since 1 Aug 2025) | [Business Standard][bs], [Tribune][trib], [Paisabazaar][pb] |
| Evening peak start | Reports say 17:00 *or* 17:30. Code uses **17:00** (stricter; costs nothing since our preferred window ends at 17:00) | Unverified | [Business Standard][bs] says 17:30 |
| Retries | Max 4 attempts per execution (1 + 3 retries). Code: 3 attempts per debit — within the limit | Reported | [Paisabazaar][pb] |
| Pre-debit notification | ≥ 24 h before the debit, sent by the issuer/PSP, with full details; customer can opt out | Confirmed (RBI e-mandate framework) | [NPCI RuPay AutoPay circular][npci-afa], RBI e-mandate circulars |
| No-AFA limit (debits without customer authentication) | **₹15,000** per debit; above it the customer must authenticate (PIN) | Confirmed (RBI, June 2022) | [Khaitan & Co][khaitan], [NPCI circular][npci-afa] |
| Higher no-AFA limit for some categories (MF, insurance, credit card bills) | Up to ₹1 lakh | Unverified (sources disagree whether in force) | [Outlook Business][ob] |
| Cashfree controlled AutoPay | ≥ 25 h between notification and execution; notice for T+1…T+7 | Confirmed (Cashfree API docs, 2026-10-03) | `docs/superpowers/specs/2026-10-03-real-psp-cashfree-design.md` |

**Code consequence (Phase 1):** debits above the no-AFA limit cannot run silently: they need a
separate customer-authenticated flow. Engine A must flag/refuse them rather than fail at the PSP.

## 3. UPI collect requests

| Rule | Confidence | Source |
|---|---|---|
| P2P collect discontinued from 1 Oct 2025 (NPCI circular 29 Jul 2025) | Confirmed | [Business Today][bt], [Outlook Money][om] |
| **Merchant (P2M) collect continues** | Reported | same |
| Intent (app deeplink) and QR are the mainstream checkout flows | Industry practice | — |

**Code consequence (Phase 3):** add UPI intent and QR; keep collect as one option.

## 4. Mandate portability ("MIC")

| Rule | Confidence | Source |
|---|---|---|
| NPCI OC-163 / OC-163A: mandates decoupled from apps/processors; new purpose code; merchant identifier derived from corporate PAN | Reported | [Razorpay docs][rzp-interop] |
| Customer-driven porting across UPI apps, once per rolling 90 days, PIN required | Reported | [Ventura][ventura], [Inc42][inc42] |
| Merchant moving mandates to a new PSP without customer re-registration | Reported, rollout staged from July 2026 | [Razorpay docs][rzp-interop] |
| Executing one mandate through a *different* PSP on a technical decline (the brief's failover idea) | **Unverified — assume not possible** | — |

**Code consequence:** keep `portableMandates: false` for real PSPs. Router failover for mandates
only happens across PSPs that explicitly support it; within one PSP we retry safely.

## 5. Our regulatory position (to confirm with counsel)

- We never hold or move funds: each merchant uses **its own** PSP account (ADR 0002). That keeps us a
  technology service provider, not a payment aggregator needing RBI PA authorisation.
- Payment data (VPAs, phone numbers, transaction records) is stored in India (ADR 0003; RBI data
  localisation for payment system data).
- Personal data processing follows the DPDP Act 2023 (privacy notice, purpose limitation,
  retention and deletion) — Phase 6.

[scc]: https://www.scconline.com/blog/post/2026/09/16/npci-released-upi-mdr-faqs-explained/
[cac]: https://www.caclubindia.com/articles/upi-transaction-charges-from-15-october-2026-latest-update-56420.asp
[tbi]: https://x.com/thebetterindia/status/2110272048413229534
[bs]: https://www.business-standard.com/finance/news/npci-tightens-upi-api-supervision-to-curb-network-stress-125052201406_1.html
[trib]: https://www.tribuneindia.com/news/business/upi-new-rules-from-august-1-here-are-the-key-changes/amp
[pb]: https://www.paisabazaar.com/banking/new-upi-rules/
[npci-afa]: https://www.npci.org.in/PDF/npci/rupay/2022/Circular-RuPay-AutoPay-AFA-Limit-enhancement-and-compliance.pdf
[khaitan]: https://www.khaitanco.com/thought-leaderships/RBI-enhances-transaction-limits-for-processing-of-e-mandates-for-recurring-transactions:-from-INR-5000-to-INR-15000
[ob]: https://www.outlookbusiness.com/ampstories/news/rbi-e-mandate-framework-2026-new-rules-for-auto-pay-upi-cards-wallets
[bt]: https://www.businesstoday.in/amp/personal-finance/banking/story/npci-to-tighten-upi-rules-peer-to-peer-collect-feature-to-end-in-october-489244-2025-08-13
[om]: https://www.outlookmoney.com/banking/npci-to-end-upi-p2p-collect-requests-from-october-1-to-reduce-fraud
[rzp-interop]: https://razorpay.com/docs/payments/recurring-payments/interoperability
[ventura]: https://www.venturasecurities.com/news/indian-markets/why-is-npci-making-upi-autopay-interoperable-explained-what-changes-for-users-and-merchants/
[inc42]: https://inc42.com/?p=570565
