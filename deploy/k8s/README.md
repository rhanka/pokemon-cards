# Kubernetes deployment

The application repo owns only tenant workloads. The namespace, quota, ServiceAccount, and CI RBAC live in `rhanka/k8s-ops`.

```bash
kubectl kustomize deploy/k8s/overlays/prod
kubectl apply --server-side --dry-run=server -k deploy/k8s/overlays/prod
```

Production uses one replica and `Recreate` because the first tier uses SQLite
on a 4 GiB ReadWriteOnce PVC. The authorised Scaleway contract explicitly uses
the live `sbs-default` StorageClass. A future OVH overlay must replace it only
after that cluster's portable storage mapping is active.

The `not-published` image tag in Git is a fail-closed render placeholder and is never pushed. Deployment automation accepts only a 40-character commit that is an ancestor of `origin/main`, resolves its `sha-<commit>` package, verifies the OCI revision label and GitHub build-provenance attestation, then replaces the placeholder with the registry digest. Before applying, it validates the namespace-scoped context, confirms the credential cannot create cluster-scoped RBAC, checks a fresh owner capacity approval and quota headroom, and performs a server-side dry-run.

The protected GitHub `production` environment owns both `KUBE_CONFIG_DATA` and `CAPACITY_APPROVED_UNTIL` if CI deployment is later enabled. The current POC uses an owner-operated apply path instead. Immediately before either path, the operator must confirm at least the workload's explicit 20m CPU and 256Mi memory requests; the CPU request is intentionally small while the 300m limit permits short OCR bursts.

The workload release requires these owner-controlled gates:

- the `pokemon-cards` namespace contract is applied;
- at least 20m CPU and 256Mi requested memory are available on an eligible node;
- the GHCR package is public or an approved pull secret exists;
- the owner-operated path uses the verified live context, or, if CI deployment
  is later enabled, `KUBE_CONFIG_DATA` contains the namespace-scoped kubeconfig
  and `CAPACITY_APPROVED_UNTIL` records a fresh owner capacity check;
- `TCGDEX_CATALOG_ENABLED=true` is limited to the reviewed MIT catalogue metadata revision and its attribution;
- `POKEMON_TCG_CATALOG_ENABLED`, `CARD_IMAGES_ENABLED`, and `MARKET_QUOTES_ENABLED` remain `false` until each separate rights record is approved;
- DNS points `pokemon.sent-tech.ca` to the shared Traefik load balancer;

The following additional gates apply before enabling account sync:

- the Sentropic public OIDC client is registered;
- its exact RFC 8707 API resource is represented in `OIDC_AUDIENCE`;
- callback, provider logout, and the disposition of any legacy raw-sub
  identity data are verified, then `ACCOUNT_IDENTITY_READY=true`;
- the global sync/storage budget covers every enrolled account; payment status
  is not a different storage architecture.
- an off-PVC/application-consistent backup exists and an isolated restore has
  passed its integrity and account/event-count checks.
- retention, erasure, and missed-backup alerting are operational, then
  `ACCOUNT_RECOVERY_READY=true`;
- only after both readiness flags are true is `OIDC_REQUIRED` switched from
  its transitional `false` value to `true`.

An encrypted off-PVC backup target, deletion/expiry policy, and isolated
restore rehearsal are required before making a recoverable-backup or
commercial five-year-retention claim; they do not block publishing the
fail-closed scan service while `OIDC_REQUIRED=false`.

The checked-in POC enables server recognition and TCGdex catalogue metadata.
Card images, marketplace quotes, and the secondary catalogue stay disabled
until their separate rights gates pass. `OIDC_REQUIRED=false` is the
fail-closed scan-only state while either identity or durability evidence is
missing. Once both gates pass and sync is enabled, the server is the authority
for every enrolled account and IndexedDB remains its offline cache/outbox.

The current tenant quota allows exactly 256 MiB of aggregate requested memory.
That is compatible with one `Recreate` app pod, but not with a concurrent
backup Job or second pod. Such a workload requires a separately reviewed quota
and live-capacity change; it is not silently squeezed into the POC.

Rollback the workload without deleting user data:

```bash
kubectl -n pokemon-cards rollout undo deployment/pokemon-cards
```

Never delete `pvc/pokemon-cards-data` as part of an application rollback.
