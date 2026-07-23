# Architecture

## Recognition path

```text
camera/file
  -> guided crop and perspective correction
  -> optional lightweight detector/embedding (WebGPU/WASM)
  -> OCR number/name as a complementary signal
  -> catalogue candidate search
  -> colour/perceptual reranking
  -> calibrated top candidates or abstention
  -> human confirmation of printing, finish, language, and condition
  -> local holding event
```

The source photo is not sent to the API. A generic model URL is an optional runtime capability; no unlicensed model is bundled. The app remains functional through guided crop, OCR, catalogue candidates, and visual reranking while the project-trained MobileNetV3 checkpoint is being licensed and benchmarked.

## Runtime

- Svelte/Vite PWA and service worker, composed with `@sentropic/design-system-svelte`.
- IndexedDB/Dexie collection and event queue.
- One TypeScript Hono/Node process serving the SPA and JSON API.
- SQLite WAL for catalogue cache and authenticated sync at the first 1,000-user tier.
- Optional Sentropic public OIDC client using authorization code + PKCE and remote JWKS verification in the API. The production manifest keeps it disabled until the registered audience and cloud-storage contract are approved.
- One OCI image and one Kubernetes Deployment, Service, Ingress, NetworkPolicy, and Scaleway `sbs-default` PVC; a future OVH overlay must provide its own validated mapping.

There is no Python service or Python runtime in the application image. The optional `ml/` Python package is an offline, rights-gated training/export tool only; its output is a browser-consumed ONNX/INT8 artifact. Scanning, collection, API, authentication, and sync all run in TypeScript/Svelte.

SQLite is intentionally a first-tier cost choice, not a 100,000-user claim. Migrate to PostgreSQL when any of these are observed: more than one API replica is required, sustained write contention exceeds 1%, the database exceeds 5 GiB, restore rehearsal exceeds the RTO, or sync p95 exceeds 250 ms because of storage.

## Data model

- `printing`: canonical project ID plus external source mappings, set, number, language, and facts.
- `variant`: normal, holo, reverse, first edition, stamp, or promo.
- `market_sku`: source-specific sale unit.
- `price_quote`: source, SKU, currency, condition, low/market/high, volume, time, and stale time.
- `holding_event`: idempotent add, remove, correction, or metadata event.
- `sync_operation`: device UUID and operation UUID for offline-safe replay.

Holdings are reconstructed from events. Shared prices are not copied into every user's history.

## Deployment decision

Scaleway Kapsule `poc` is the only technically compatible target observed on 2026-07-22: Kubernetes 1.35.3, Traefik, cert-manager, ACME issuers, sealed secrets, `sbs-default`, and CSI snapshot classes are live. It is **not currently deployable** for CardScope: the tenant contract exists only in an unapplied sibling-repository commit, the namespace and DNS record are absent, and the general node has only 24m unrequested CPU. OVH has no active cluster/state/kubeconfig and remains a design-only path.

Production prerequisites remain owner-controlled:

1. `pokemon-cards` tenant namespace/quota/RBAC/network policy;
2. public GHCR image;
3. DNS `pokemon-cards.sent-tech.ca`;
4. public OIDC client registration;
5. scheduler capacity — the general pool was at 98% requested CPU during audit;
6. namespace-scoped CI kubeconfig;
7. approved off-PVC backup/IAM contract and a successful isolated restore rehearsal; see [backup and restore](backup-restore.md).
8. server-side verification of a time-bound Cloud Pass entitlement, plus distributed sync throttling and a global storage budget; OIDC identity alone is not an entitlement.

Until every prerequisite is green, the immutable-image workflow may publish an artefact but the protected production deployment must not run. This is a formal no-go, not an application failure.
