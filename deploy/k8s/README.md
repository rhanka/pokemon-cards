# Kubernetes deployment

The application repo owns only tenant workloads. The namespace, quota, ServiceAccount, and CI RBAC live in `rhanka/k8s-ops`.

```bash
kubectl kustomize deploy/k8s/overlays/prod
kubectl apply --server-side --dry-run=server -k deploy/k8s/overlays/prod
```

Production uses one replica and `Recreate` because the first tier uses SQLite on a ReadWriteOnce PVC. The authorised Scaleway contract explicitly uses the live `sbs-default` StorageClass. A future OVH overlay must replace it only after that cluster's portable storage mapping is active.

The `not-published` image tag in Git is a fail-closed render placeholder and is never pushed. Deployment automation accepts only a 40-character commit that is an ancestor of `origin/main`, resolves its `sha-<commit>` package, verifies the OCI revision label and GitHub build-provenance attestation, then replaces the placeholder with the registry digest. Before applying, it validates the namespace-scoped context, confirms the credential cannot create cluster-scoped RBAC, checks a fresh owner capacity approval and quota headroom, and performs a server-side dry-run.

The protected GitHub `production` environment owns both `KUBE_CONFIG_DATA` and `CAPACITY_APPROVED_UNTIL` if CI deployment is later enabled. The current POC uses an owner-operated apply path instead. Immediately before either path, the operator must confirm at least the workload's explicit 20m CPU and 256Mi memory requests; the CPU request is intentionally small while the 300m limit permits short OCR bursts.

Do not deploy until all owner-controlled gates are green:

- the `pokemon-cards` namespace contract is applied;
- at least 20m CPU and 256Mi requested memory are available on an eligible node;
- the GHCR package is public or an approved pull secret exists;
- the owner-operated path uses the verified live context, or, if CI deployment
  is later enabled, `KUBE_CONFIG_DATA` contains the namespace-scoped kubeconfig
  and `CAPACITY_APPROVED_UNTIL` records a fresh owner capacity check;
- `TCGDEX_CATALOG_ENABLED=true` is limited to the reviewed MIT catalogue metadata revision and its attribution;
- `POKEMON_TCG_CATALOG_ENABLED`, `CARD_IMAGES_ENABLED`, and `MARKET_QUOTES_ENABLED` remain `false` until each separate rights record is approved;
- the Sentropic public OIDC client is registered;
- its API audience is confirmed and represented in `OIDC_AUDIENCE`;
- a time-bound Cloud Pass entitlement is verified server-side; a valid OIDC identity alone must never allocate paid storage;
- DNS points `pokemon-cards.sent-tech.ca` to the shared Traefik load balancer;
- an encrypted off-PVC backup target, deletion/expiry policy, and isolated restore rehearsal satisfy `docs/backup-restore.md`.

The checked-in POC enables server recognition and TCGdex catalogue metadata only. Card images, marketplace quotes, the secondary catalogue, and `OIDC_REQUIRED` stay disabled. Do not enable paid data or cloud sync merely to test the deployment.

The current tenant quota allows exactly 256 MiB of aggregate requested memory.
That is compatible with one `Recreate` app pod, but not with a concurrent
backup Job or second pod. Such a workload requires a separately reviewed quota
and live-capacity change; it is not silently squeezed into the POC.

Rollback the workload without deleting user data:

```bash
kubectl -n pokemon-cards rollout undo deployment/pokemon-cards
```

Never delete `pvc/pokemon-cards-data` as part of an application rollback.
