# Unit economics and pricing guardrail

CardScope uses a free local core because recognition and collection do not need a server. This makes a large free audience compatible with a very low price.

## Launch offer

- Free forever: local scan, local collection, current cached estimates, corrections, JSON/CSV export.
- Cloud Pass: backup, account recovery, multi-device sync, and five-year personal history.
- Launch hypothesis: **USD 4.99 once for five years** through the web PWA.
- No advertising, sale of personal data, or hidden affiliate ranking.

Five USD paid as five annual one-dollar charges loses too much to fixed payment fees. One five-year payment is the economically honest equivalent.

## Target cohort

| Five-year assumption             | 1,000 accounts | 100,000 accounts |
| -------------------------------- | -------------: | ---------------: |
| Cloud conversion                 |            30% |              30% |
| Paid passes                      |            300 |           30,000 |
| Revenue at USD 4.99              |      USD 1,497 |      USD 149,700 |
| Complete cost ceiling            |        USD 999 |       USD 99,900 |
| Margin at the 50% markup ceiling |        USD 498 |       USD 49,800 |

The maximum complete cost is USD 3.33 per paid five-year pass. “Complete” includes payment processing, authorised data, infrastructure, backups, support, maintenance, security, and amortised product/model work.

The first cohort is operationally profitable only while incremental shared-infrastructure cost stays below roughly USD 900 over five years. Fully loading all initial development salary into only 1,000 accounts is incompatible with the desired one-dollar-per-year price and is treated as a product investment.

## Bottom-up cost envelope

This is a go/no-go budget, not a claim that every line has already been spent. At 30,000 paid passes the product may spend at most USD 99,900 over five years if the USD 4.99 price and 50% markup ceiling are both retained:

| Five-year budget                                              |          Total | Per paid pass |
| ------------------------------------------------------------- | -------------: | ------------: |
| Web payment processing (planning assumption: USD 0.30 + 2.9%) |     USD 13,350 |      USD 0.45 |
| Compute, storage, backups, CDN and observability              |     USD 18,000 |      USD 0.60 |
| Authorised market data, corpus rights and legal review        |     USD 20,000 |      USD 0.67 |
| Support, maintenance, incident response and security          |     USD 35,000 |      USD 1.17 |
| Amortised initial product/model work                          |     USD 10,000 |      USD 0.33 |
| Quality/price-reduction reserve                               |      USD 3,550 |      USD 0.12 |
| **Complete cost ceiling**                                     | **USD 99,900** |  **USD 3.33** |

Actual processor, tax, currency and refund costs replace the payment assumption before checkout ships. If a required data licence alone breaks its envelope, the feature is disabled or the pass price is recomputed; HTML scraping is not used to hide that cost.

The 1,000-account gate assumes 300 paid passes and applies the same USD 999 complete-cost allowance. It is cash-operationally profitable only if CardScope uses spare shared-cluster capacity. The public Scaleway grid observed during the study lists a small `DEV1-M` at EUR 0.020196/hour (about EUR 14.74 for a 730-hour month): a dedicated node for five years would consume roughly EUR 885 before payments, backups, or support and therefore fails the first-cohort gate. This is why the current full cluster is a deployment blocker rather than a reason to silently buy more capacity.

Initial founder time beyond the USD 10,000 portfolio allocation is not recoverable from the first cohort at this price. Claiming otherwise would make the one-dollar-per-year objective false. The launch can be operating-profitable at 1,000 accounts; full investment recovery depends on reaching later cohorts.

## Why recognition stays cheap

- guided crop, OCR, perceptual fingerprint and the optional embedding model run on the user's phone: **USD 0 per scan** in inference fees;
- a quantised model is downloaded and cached once, not invoked through a vision API;
- free collections and photos remain in IndexedDB, so an average 1,000-card free user creates no account-storage bill;
- paid sync stores compact holding events. At 30,000 paid users, the base collection is 30 million holdings; capacity planning assumes tens of gigabytes plus encrypted backups, not 30,000 copies of the global price history;
- catalogue and quote refreshes are global rather than per account. The MVP deduplicates them through one bounded TTL cache; the documented adaptive scheduler is a later cost optimisation and is not represented as already running.

Before each cohort gate, observed bytes per holding/event, backup multiplier, CDN egress, API calls, support minutes, refunds, and processor fees replace these estimates. A dedicated per-user vision call is never part of the model.

## Sensitivity and policy

- At 20% conversion, USD 7.50/five years reaches roughly the same 100,000-account margin target.
- At 10% conversion, either cost/packaging must change or USD 4.99 cannot reach the target.
- If actual complete cost falls below price / 1.5, reduce the renewal price or invest the difference in user-visible data quality, support, security, or resilience. Do not exceed a 50% markup.
- Keep the free product useful when the Cloud Pass lapses: local data and export remain available.
- Review cost and conversion at 1,000, 10,000, and 100,000 accounts. Pricing is a measured constraint, not a permanent marketing claim.
