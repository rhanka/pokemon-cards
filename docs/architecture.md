# Architecture

## Recognition path

```text
camera/file
  -> guided crop + bounded JPEG re-encoding in the browser
  -> TLS upload to POST /api/recognition/cards
  -> JPEG/pixel validation + normalization with Sharp
  -> one Tesseract.js worker for number/name evidence
  -> parallel fail-closed English/French TCGdex metadata search
  -> calibrated top candidates or abstention
  -> human confirmation of the printing, finish, and condition
  -> provisional anonymous or account-scoped offline event
  -> automatic idempotent central sync
```

The source photo is sent to the API only for this transient recognition call. The browser re-encodes it to strip EXIF/GPS; the API never writes it to disk, SQLite, logs, analytics, or a training corpus. It clears application buffers after processing, returns no raw OCR text, and marks every response `no-store`. The server derives a bounded name/collector-number query and sends only that query—not the photo or raw OCR—to TCGdex over HTTPS to obtain candidates. TCGdex is an external processor that may retain request logs under its own policy. One worker and a no-queue busy response bound CPU and memory. No paid Vision API or Python runtime is involved.

The MVP identifies printed name and collector number; it does not compare artwork or infer authenticity, finish, or condition. An ONNX retrieval model remains a future server engine and cannot be activated until both a commercially valid corpus/weight and a named benchmark pass.

## Runtime

- Svelte/Vite PWA and service worker, composed with `@sentropic/design-system-svelte`.
- IndexedDB/Dexie account-scoped cache and outbox; it is not the durable
  authority for an enrolled account.
- One TypeScript Hono/Node process serving the SPA and JSON API.
- SQLite WAL for catalogue cache and compact authenticated sync at the first 1,000-user tier.
- Sentropic public OIDC client using authorization code + PKCE and remote JWKS
  verification in the API. `OIDC_REQUIRED` stays `false` only until the exact
  production client/resource registration and the durable-backup restore gate
  are both proven. Startup also requires explicit
  `ACCOUNT_IDENTITY_READY=true` and `ACCOUNT_RECOVERY_READY=true` attestations
  before identity-backed sync can be enabled.
- One OCI image and one Kubernetes Deployment, Service, Ingress, NetworkPolicy,
  and 4 GiB Scaleway `sbs-default` PVC; a future OVH overlay must provide its
  own validated mapping.

There is no Python service or Python runtime in the application image. The optional `ml/` Python package is an offline, rights-gated training/evaluation tool only and is excluded from the OCI context. Any future released artifact is consumed by the Node recognizer. Scanning, collection, API, authentication, and sync all run in TypeScript/Svelte.

SQLite is intentionally a first-tier cost choice, not a 100,000-user claim.
Migrate to PostgreSQL when any of these are observed: more than one API replica
is required, sustained write contention exceeds 1%, the database reaches 75%
of the 4 GiB PVC, restore rehearsal exceeds the RTO, or sync p95 exceeds 250 ms
because of storage.

## Data model

- `printing`: canonical project ID plus external source mappings, set, number, language, and facts.
- `variant`: normal, holo, reverse, first edition, stamp, or promo.
- `market_sku`: source-specific sale unit.
- `price_quote`: source, SKU, currency, condition, low/market/high, volume, time, and stale time.
- `holding_event`: compact idempotent add, remove, correction, or metadata event; catalogue metadata and quotes are not copied into every account event.
- `sync_operation`: device UUID and operation UUID for offline-safe replay.
- `collection_generation`: monotonic server generation carried by every sync;
  deletion increments it so an old device cannot replay a stale outbox.

Holdings are reconstructed from central events and materialized into each
device cache. Pre-enrollment anonymous events are moved atomically into a
remote-empty account; two non-empty histories require explicit confirmation.
Shared prices are not copied into every user's history.

## Deployment decision

Scaleway Kapsule `poc` is the selected current target: Kubernetes 1.35.3,
Traefik, cert-manager, ACME issuers, sealed secrets, `sbs-default`, and CSI
snapshot classes are live. The POC workload explicitly requests `20m` CPU and
`256Mi` memory, with limits of `300m` and `384Mi`, mounts a 4 GiB PVC, and uses
`Recreate`. The operator confirmed the 20m request fits the tenant contract and
observed 34m nominal node CPU headroom before the release; it must recheck
immediately before applying because other Pending workloads can consume that
margin. OVH is the planned scale target after product validation, not the
current deployment path.

Production prerequisites remain owner-controlled:

1. `pokemon-cards` tenant namespace/quota/RBAC/network policy;
2. public GHCR image;
3. DNS `pokemon.sent-tech.ca`;
4. public OIDC client registration and exact API audience;
5. verified provider logout plus migration or explicit non-survival of legacy
   raw-sub account data;
6. immediate scheduler recheck for the explicit 20m request; no node expansion is authorised;
7. namespace-scoped CI kubeconfig;
8. approved off-PVC backup/IAM contract and a successful isolated restore rehearsal; see [backup and restore](backup-restore.md).
9. distributed sync throttling and a global storage budget. Billing is a
   commercial gate, not a different data architecture: every enrolled account
   is included in capacity calculations.

The scan-only workload may run with `OIDC_REQUIRED=false`; account enrollment
and central sync may not. Enabling identity-backed storage requires every
identity and durability prerequisite above to be green.
