# Kubernetes deployment

The application repo owns only tenant workloads. The namespace, quota, ServiceAccount, and CI RBAC live in `rhanka/k8s-ops`.

```bash
kubectl kustomize deploy/k8s/overlays/prod
kubectl apply --server-side --dry-run=server -k deploy/k8s/overlays/prod
```

Production uses one replica and `Recreate` because the first tier uses SQLite on a ReadWriteOnce PVC. The authorised Scaleway contract explicitly uses the live `sbs-default` StorageClass. A future OVH overlay must replace it only after that cluster's portable storage mapping is active.

The `not-published` image tag in Git is a fail-closed render placeholder and is never pushed. Deployment automation accepts only a 40-character commit that is an ancestor of `origin/main`, resolves its `sha-<commit>` package, verifies the OCI revision label and GitHub build-provenance attestation, then replaces the placeholder with the registry digest. Before applying, it validates the namespace-scoped context, confirms the credential cannot create cluster-scoped RBAC, checks a fresh owner capacity approval and quota headroom, and performs a server-side dry-run.

The protected GitHub `production` environment owns both `KUBE_CONFIG_DATA` and `CAPACITY_APPROVED_UNTIL`. An infrastructure owner sets the latter to an RFC 3339 timestamp only after checking live eligible-node capacity; the workflow accepts it only while it is in the future and no more than 24 hours away. The namespace quota must also retain at least the workload's 50m CPU and 128Mi memory requests. Namespace-scoped CI intentionally cannot infer physical-node headroom itself.

Do not deploy until all owner-controlled gates are green:

- the `pokemon-cards` namespace contract is applied;
- at least 50m CPU request capacity is available on an eligible node;
- the GHCR package is public or an approved pull secret exists;
- `KUBE_CONFIG_DATA` contains the namespace-scoped kubeconfig;
- `CAPACITY_APPROVED_UNTIL` records a fresh infrastructure-owner capacity check;
- the checked-in `TCGDEX_CATALOG_ENABLED`, `POKEMON_TCG_CATALOG_ENABLED`, `CARD_IMAGES_ENABLED`, and `MARKET_QUOTES_ENABLED` values remain `false` until each corresponding rights record is approved;
- the Sentropic public OIDC client is registered;
- its API audience is confirmed and represented in `OIDC_AUDIENCE`;
- a time-bound Cloud Pass entitlement is verified server-side; a valid OIDC identity alone must never allocate paid storage;
- DNS points `pokemon-cards.sent-tech.ca` to the shared Traefik load balancer;
- an encrypted off-PVC backup target, deletion/expiry policy, and isolated restore rehearsal satisfy `docs/backup-restore.md`.

All catalogue/image/quote switches and `OIDC_REQUIRED` are intentionally `false` in the checked-in ConfigMap. Do not enable paid data or cloud sync merely to test the deployment: local-only mode is the safe launch state until the corresponding rights and cloud-history gates are green.

Rollback the workload without deleting user data:

```bash
kubectl -n pokemon-cards rollout undo deployment/pokemon-cards
```

Never delete `pvc/pokemon-cards-data` as part of an application rollback.
