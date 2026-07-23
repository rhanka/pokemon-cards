# Unit economics and load model

Verified on 22 July 2026. This model starts from the requested cohort:
**1,000 accounts × 1,000 cards = 1,000,000 holdings**. It distinguishes
Kubernetes reservation, actual CPU work, and marginal cash cost.

## Launch offer

- Free: recognition under a transparent fair-use guard, local collection,
  bulk import/export, corrections, and authorised current estimates.
- Cloud Pass: backup, account recovery, multi-device sync, and five-year
  personal history.
- Launch hypothesis: **USD 4.99 once for five years**.
- No advertising, sale of personal data, or paid ranking.
- Price is rechecked against complete cost and may never exceed cost +50%.

Five annual one-dollar payments lose too much to fixed payment fees. One
five-year payment is the closest economically honest version of USD 1/year.

## Workload assumptions

Let:

```text
accounts = 1,000
cards/account = 1,000
monthly scans = accounts × MAU × scans/MAU
monthly views = accounts × MAU × sessions/MAU × cards viewed/session
average OCR mCPU = monthly scans × 3.3 CPU-s / seconds in 30 days × 1,000
```

The `3.3 CPU-s` value is a conservative measured bound, not a Vision API
estimate. In the exact Alpine image limited to 300m CPU and 384 MiB,
English+French Tesseract.js identified the real 600×825 Pikachu image in
10.26 s cold and 5.23 s warm. Cgroup counters measured 3.22 CPU-s for the
cold request and 1.66 CPU-s warm; the model nevertheless charges the cold
value, rounded up, to every scan. The earlier unrestricted run peaked around
183 MiB RSS; the final limited cgroup peaked at 134 MiB and returned to an
86 MiB working set after the scan, with no OOM event. A browser-reencoded
upload is budgeted at 150 KiB on average and hard-capped at 2 MiB.

| Monthly scenario         | Conservative |    Base |  Active |
| ------------------------ | -----------: | ------: | ------: |
| MAU                      |          20% |     50% |     80% |
| Sessions per MAU         |            2 |       4 |      10 |
| Cards viewed per session |            5 |      20 |      50 |
| Scans per MAU            |            2 |      10 |      30 |
| Card views               |        2,000 |  40,000 | 400,000 |
| Scans                    |          400 |   5,000 |  24,000 |
| Image ingress at 150 KiB |        60 MB |  750 MB |  3.6 GB |
| Average OCR CPU          |        0.51m |   6.37m |  30.56m |
| Peak OCR CPU ×20         |       10.19m | 127.31m | 611.11m |
| Optimised API requests   |        1,720 |  14,600 |  66,400 |
| Average optimised RPS    |       0.0007 |  0.0056 |   0.026 |

Collection browsing is served from IndexedDB. Fifty cards viewed in a session
must not create fifty server calls. Today, values change only after a bounded
catalogue query. The next refresh implementation uses one global quote per SKU
and one compact watermark/delta per session.

The Kubernetes `requests.cpu: 20m` is a scheduling reservation, not a hard
usage cap. The pod may burst to its `limits.cpu: 300m`. On the current
1.8-vCPU allocatable node, 20m is 1.11% of scheduled CPU—not 20% of a server.
At the observed EUR 43.23/month full-node price, simple proportional
attribution is about EUR 0.48/month by CPU. A conservative 256 MiB share of an
8 GiB node is 3.125%, or EUR 1.35/month. The immediate marginal cash cost is
EUR 0 while the already-paid node has room; CardScope is never charged the
whole node in this cohort model.

## One-million-card onboarding

One million individual photo scans would consume approximately:

- 150 GB of image ingress at the planning average;
- 917 vCPU-hours of OCR;
- at least 127 days if a single pod stayed continuously saturated at 300m.

That is not a launch burst promise. Organic scanning is rate-limited and
spread over time; CSV/JSON import is the mass-onboarding path for an existing
1,000-card collection. If observed recognition demand sustains the active
scenario, whose modelled burst exceeds the 300m limit, or forms a long queue,
the recognizer is split into a stateless service and later moved with the API
to the OVH/PostgreSQL scale tier.

## Storage for 1,000 accounts

Only paid accounts consume cloud history. At 30% conversion, the first cohort
has 300,000 cloud holdings. Sync events must store compact ownership facts:
`cardId`, quantity, finish, condition, cost, note, and event metadata.
Catalogue records and quotes are global and must not be copied into every
event.

Acceptance budgets are:

| Record                 | SQLite budget |
| ---------------------- | ------------: |
| Initial compact add    |    ≤700 bytes |
| Later holding mutation |    ≤500 bytes |

With one add per holding and one mutation per two holdings, 300 paid accounts
use about 285 MB of event data. Adding the enforced 256 MiB catalogue-cache
budget and 25% storage headroom gives about 0.64 GiB primary in the base
scenario, or 1.93 GiB across primary plus two off-volume backup copies. A
1 GiB POC PVC is therefore a bounded first-cohort tier, not a forever
capacity claim.

At 100,000 accounts and 30% Cloud Pass conversion, 30 million holdings imply
about 21 GB of compact adds plus 7.5 GB of mutations. With backups, the
planning range is roughly 57–85 GB. That tier requires PostgreSQL, multiple
stateless replicas, distributed rate limits, and the planned OVH migration.

## Pricing guardrail

| Five-year assumption             | 1,000 accounts | 100,000 accounts |
| -------------------------------- | -------------: | ---------------: |
| Cloud conversion                 |            30% |              30% |
| Paid passes                      |            300 |           30,000 |
| Revenue at USD 4.99              |      USD 1,497 |      USD 149,700 |
| Complete cost ceiling            |        USD 998 |       USD 99,800 |
| Margin at the 50% markup ceiling |        USD 499 |       USD 49,900 |

The complete cost ceiling is USD 3.33 per paid pass. It includes payment
processing, authorised data, infrastructure, backups, support, maintenance,
security, and amortised model/product work.

At 1,000 accounts, the five-year infrastructure envelope is USD 180
(USD 3/month). Proportional shared-node attribution is about EUR 29 over five
years by CPU or EUR 81 by the more conservative memory share. This leaves the
remainder for PVC, off-volume backups, observability, and egress. A new
EUR 40+/month node would break this tier, so none is provisioned now.

At 100,000 accounts, the planning allocation remains:

| Five-year budget                                |          Total | Per paid pass |
| ----------------------------------------------- | -------------: | ------------: |
| Payment processing (USD 0.30 + 2.9% assumption) |     USD 13,350 |      USD 0.45 |
| Compute, storage, backups, CDN, observability   |     USD 18,000 |      USD 0.60 |
| Authorised data, corpus rights, legal review    |     USD 20,000 |      USD 0.67 |
| Support, maintenance, incidents, security       |     USD 35,000 |      USD 1.17 |
| Amortised initial product/model work            |     USD 10,000 |      USD 0.33 |
| Quality/price-reduction reserve                 |      USD 3,450 |      USD 0.12 |
| **Complete cost ceiling**                       | **USD 99,800** |  **USD 3.33** |

Actual tax, processor, refund, support, storage, and backup costs replace these
assumptions before checkout. Founder time beyond the portfolio allocation is
product investment; pretending it is recovered by the first 1,000 accounts
would make the USD 1/year objective false.

## Measurements required at each cohort gate

- MAU, sessions, scans, and cards viewed—aggregated without photo, OCR text,
  IP, or public profile;
- scan CPU-ms, p50/p95, peak RSS, timeouts, `429`, and pod throttling;
- upload bytes and catalogue cache hit/miss/stale rates;
- upstream calls per source and one global quote-refresh count;
- SQLite bytes per add/mutation, WAL size, contention, and backup multiplier;
- payment fees, refunds, support minutes, and restore cost.

Review at 1,000, 10,000, and 100,000 accounts. If complete cost falls below
price / 1.5, reduce the renewal price or invest the difference in
user-visible quality, support, security, or resilience.
