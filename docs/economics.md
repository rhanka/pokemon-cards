# Capacity and sustainability model

Verified on 22 July 2026. This model starts from the requested cohort:
**1,000 accounts × 1,000 cards = 1,000,000 holdings**. It distinguishes
Kubernetes reservation, actual CPU work, and shared operating cost.

## Service model

- Free, non-commercial pilot: no checkout, advertising, affiliate revenue,
  sale of personal data, or paid ranking.
- Every enrolled account receives the same central history, offline cache,
  bulk import/export, correction, and authorised current estimates.
- This document models capacity and owner cost only. It does not calculate
  revenue, conversion, payment processing, price, or margin.

## Workload assumptions

Let:

```text
accounts = 1,000
cards/account = 1,000
monthly scans = accounts × MAU × scans/MAU
monthly views = accounts × MAU × sessions/MAU × cards viewed/session
server retrieval CPU ≈ bounded vector lookup; visual encoding runs in the browser Worker
```

The historical `3.3 CPU-s` OCR bound remains in the simulator only as a
conservative legacy comparison. It is not the target recognizer. The target
browser model sends a normalized embedding rather than an image, so there is
no per-scan image ingress or server inference bill. Its phone benchmarks gate
activation separately.

| Monthly scenario         | Conservative |    Base |  Active |
| ------------------------ | -----------: | ------: | ------: |
| MAU                      |          20% |     50% |     80% |
| Sessions per MAU         |            2 |       4 |      10 |
| Cards viewed per session |            5 |      20 |      50 |
| Scans per MAU            |            2 |      10 |      30 |
| Card views               |        2,000 |  40,000 | 400,000 |
| Scans                    |          400 |   5,000 |  24,000 |
| Legacy image ingress at 150 KiB |    60 MB |  750 MB |  3.6 GB |
| Legacy OCR CPU baseline         |    0.51m |   6.37m |  30.56m |
| Legacy OCR peak ×20             |   10.19m | 127.31m | 611.11m |
| Optimised API requests   |        1,600 |  11,000 |  48,000 |
| Average optimised RPS    |       0.0006 |  0.0042 |  0.0185 |

Collection browsing is served from the account-scoped IndexedDB cache. Fifty
cards viewed in a session do not create fifty server calls. Each active session
budgets one compact account sync plus bootstrap/global-delta calls. The target
recognizer uses one small embedding lookup; manual catalogue search remains
available until it passes its gates.

The Kubernetes `requests.cpu: 20m` is a scheduling reservation, not a hard
usage cap. The pod may burst to its `limits.cpu: 300m`. On the current
1.8-vCPU allocatable node, 20m is 1.11% of scheduled CPU—not 20% of a server.
At the observed EUR 43.23/month full-node price, simple proportional
attribution is about EUR 0.48/month by CPU. A conservative 256 MiB share of an
8 GiB node is 3.125%, or EUR 1.35/month. The immediate marginal cash cost is
EUR 0 while the already-paid node has room; CardScope is never charged the
whole node in this cohort model.

## One-million-card onboarding

One million legacy server-OCR scans would consume approximately:

- 150 GB of image ingress at the planning average;
- 917 vCPU-hours of OCR;
- at least 127 days if a single pod stayed continuously saturated at 300m.

That is not a launch-burst promise and is not the visual target path. The
browser encoder removes this server queue; CSV/JSON import remains the
mass-onboarding path for an existing 1,000-card collection.

## Storage for 1,000 accounts

All enrolled accounts consume central history: the first cohort has
**1,000,000 central holdings**. Sync events must store compact ownership facts:
`cardId`, quantity, finish, condition, cost, note, and event metadata.
Catalogue records and quotes are global and must not be copied into every
event.

Acceptance budgets are:

| Record                 | SQLite budget |
| ---------------------- | ------------: |
| Initial compact add    |    ≤700 bytes |
| Later holding mutation |    ≤500 bytes |

Across the measured consultation/mutation scenarios, one million holdings
require **1.19–2.00 GiB primary**, including the enforced 256 MiB catalogue
cache and 25% headroom, or **3.56–6.00 GiB** across primary plus two off-volume
backup copies. The base case is 1.42 GiB primary / 4.26 GiB with backups. A
4 GiB PVC is therefore a bounded first-cohort primary tier with WAL headroom;
the backups live outside it.

At 100,000 accounts, 100 million central holdings require roughly
88–169 GiB primary and 263–507 GiB with two backup copies across the same
scenarios. That tier requires PostgreSQL, multiple stateless replicas,
distributed rate limits, and the planned OVH migration.

## Cost posture

At 1,000 accounts, a 20m CPU request is 1.11% of the current 1.8-vCPU node,
not 20% of a server. The simulator reports both the full shared-node five-year
cost and its small CPU-reservation attribution; neither is charged to users.
No additional node is provisioned for this pilot. At 100,000 accounts, the
88–169 GiB primary-storage projection requires the planned PostgreSQL,
multi-replica, and OVH scale tier before expanding the service.

## Measurements required at each cohort gate

- MAU, sessions, scans, and cards viewed—aggregated without photo, raw model
  signals,
  IP, or public profile;
- browser encoding p50/p95, Worker memory, embedding lookup latency,
  abstentions, corrections, `429`, and pod throttling;
- embedding request bytes and catalogue cache hit/miss/stale rates;
- upstream calls per source and one global quote-refresh count;
- SQLite bytes per add/mutation, WAL size, contention, and backup multiplier;
- support minutes, restore cost, and off-PVC backup cost.

Review at 1,000, 10,000, and 100,000 accounts. If capacity becomes
unsustainable, constrain the free pilot transparently or seek a separately
reviewed funding model; do not turn CC-BY-NC experimental artefacts into a
commercial service.
