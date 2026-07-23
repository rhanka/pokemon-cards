# Architecture

## Recognition path

```text
camera/file
  -> guided crop + bounded JPEG re-encoding in the browser
  -> TLS upload to POST /api/recognition/cards
  -> JPEG/pixel validation + normalization with Sharp
  -> one Tesseract.js worker for number/name evidence
  -> bounded TCGdex metadata search
  -> calibrated top candidates or abstention
  -> human confirmation of printing, finish, language, and condition
  -> local holding event
```

The source photo is sent to the API only for this transient recognition call. The browser re-encodes it to strip EXIF/GPS; the API never writes it to disk, SQLite, logs, analytics, or a training corpus. It clears application buffers after processing, returns no raw OCR text, and marks every response `no-store`. The server derives a bounded name/collector-number query and sends only that query—not the photo or raw OCR—to TCGdex over HTTPS to obtain candidates. TCGdex is an external processor that may retain request logs under its own policy. One worker and a no-queue busy response bound CPU and memory. No paid Vision API or Python runtime is involved.

The MVP identifies printed name and collector number; it does not compare artwork or infer authenticity, finish, or condition. An ONNX retrieval model remains a future server engine and cannot be activated until both a commercially valid corpus/weight and a named benchmark pass.

## Runtime

- Svelte/Vite PWA and service worker, composed with `@sentropic/design-system-svelte`.
- IndexedDB/Dexie collection and event queue.
- One TypeScript Hono/Node process serving the SPA and JSON API.
- SQLite WAL for catalogue cache and compact authenticated sync at the first 1,000-user tier.
- Optional Sentropic public OIDC client using authorization code + PKCE and remote JWKS verification in the API. The production manifest keeps it disabled until the registered audience and cloud-storage contract are approved.
- One OCI image and one Kubernetes Deployment, Service, Ingress, NetworkPolicy, and Scaleway `sbs-default` PVC; a future OVH overlay must provide its own validated mapping.

There is no Python service or Python runtime in the application image. The optional `ml/` Python package is an offline, rights-gated training/evaluation tool only and is excluded from the OCI context. Any future released artifact is consumed by the Node recognizer. Scanning, collection, API, authentication, and sync all run in TypeScript/Svelte.

SQLite is intentionally a first-tier cost choice, not a 100,000-user claim. Migrate to PostgreSQL when any of these are observed: more than one API replica is required, sustained write contention exceeds 1%, the database exceeds 5 GiB, restore rehearsal exceeds the RTO, or sync p95 exceeds 250 ms because of storage.

## Data model

- `printing`: canonical project ID plus external source mappings, set, number, language, and facts.
- `variant`: normal, holo, reverse, first edition, stamp, or promo.
- `market_sku`: source-specific sale unit.
- `price_quote`: source, SKU, currency, condition, low/market/high, volume, time, and stale time.
- `holding_event`: compact idempotent add, remove, correction, or metadata event; catalogue metadata and quotes are not copied into every account event.
- `sync_operation`: device UUID and operation UUID for offline-safe replay.

Holdings are reconstructed from events. Shared prices are not copied into every user's history.

## Deployment decision

Scaleway Kapsule `poc` is the selected current target: Kubernetes 1.35.3, Traefik, cert-manager, ACME issuers, sealed secrets, `sbs-default`, and CSI snapshot classes are live. The POC workload explicitly requests `20m` CPU and `256Mi` memory, with limits of `300m` and `384Mi`, and uses `Recreate`. The operator confirmed the 20m request fits the tenant contract and observed 34m nominal node CPU headroom before the release; it must recheck immediately before applying because other Pending workloads can consume that margin. OVH is the planned scale target after product validation, not the current deployment path.

Production prerequisites remain owner-controlled:

1. `pokemon-cards` tenant namespace/quota/RBAC/network policy;
2. public GHCR image;
3. DNS `pokemon-cards.sent-tech.ca`;
4. public OIDC client registration;
5. immediate scheduler recheck for the explicit 20m request; no node expansion is authorised;
6. namespace-scoped CI kubeconfig;
7. approved off-PVC backup/IAM contract and a successful isolated restore rehearsal; see [backup and restore](backup-restore.md).
8. server-side verification of a time-bound Cloud Pass entitlement, plus distributed sync throttling and a global storage budget; OIDC identity alone is not an entitlement.

Until every prerequisite is green, the immutable-image workflow may publish an artefact but the protected production deployment must not run. This is a formal no-go, not an application failure.
