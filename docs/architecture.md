# Architecture

## Recognition path

```text
camera/file
  -> guided crop + bounded JPEG re-encoding in the browser
  -> ONNX INT8 encoder in a browser Web Worker (WASM/SIMD)
  -> normalized 128D embedding to a TypeScript top-five lookup endpoint
  -> calibrated top candidates or abstention (no automatic add)
  -> human confirmation of the printing, finish, and condition
  -> provisional anonymous or account-scoped offline event
  -> automatic idempotent central sync
```

The browser re-encodes the source photo to strip EXIF/GPS and keeps it on the
device. The API receives only a bounded normalized embedding; it never writes a
photo, raw model signal, or IP address to disk, SQLite, logs, analytics, or a
training corpus. It returns a calibrated top-five/abstention result with
`Cache-Control: no-store`. No paid Vision API or Python runtime is involved.

The product compares the card visually; it does not infer authenticity, finish,
or condition. A visual model cannot be activated until its corpus and derived
artefacts have permitted public use, and a named benchmark passes. Until then,
manual catalogue search is the product fallback; the legacy OCR endpoint is
disabled in Kubernetes.

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

There is no Python service or Python runtime in the application image. The optional `ml/` Python package is an offline, rights-gated training/evaluation tool only and is excluded from the OCI context. Any future released artifact is consumed by the Svelte browser Worker and queried by the TypeScript API. Scanning, collection, API, authentication, and sync all run in TypeScript/Svelte.

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
9. distributed sync throttling and a global storage budget. Every enrolled
   account is included in capacity calculations; no payment state changes the
   storage authority.

The scan-only workload may run with `OIDC_REQUIRED=false`; account enrollment
and central sync may not. Enabling identity-backed storage requires every
identity and durability prerequisite above to be green.
