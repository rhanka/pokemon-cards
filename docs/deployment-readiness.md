# Deployment readiness record

Read-only evidence collected on 22–23 July 2026. This record separates a buildable workload from an authorised production deployment.

## Verdict

- **Application build:** GO after the current validation and immutable publish.
- **Scaleway POC workload:** owner-authorised at an explicit 20m CPU request;
  4 GiB PVC; apply only after the new digest and immediate capacity recheck.
- **Account authority:** central for every enrolled account; IndexedDB is only
  its offline cache/outbox.
- **Identity-backed sync activation:** NO-GO until both the exact Sentropic
  registration evidence and a tested durable-backup path exist.
  `OIDC_REQUIRED=false`, `ACCOUNT_IDENTITY_READY=false`, and
  `ACCOUNT_RECOVERY_READY=false` are mandatory until their gates pass.
- **Backup/recovery claim:** NO-GO until an off-PVC/application-consistent
  backup and isolated restore pass. A CSI snapshot alone is only a
  crash-consistent recovery point.
- **OVH scale tier:** planned after application validation; no active target
  cluster, ingress, storage mapping, or kubeconfig was available in this audit.

## Scaleway evidence

- Kapsule `poc`, Kubernetes 1.35.3, Traefik, cert-manager, ACME issuers, `sbs-default`, and retained CSI snapshot classes exist.
- The `pokemon-cards` namespace and tenant contract are live. The application
  Deployment is one ready replica using `Recreate`, with a 20m/256Mi request
  and 300m/384Mi limit.
- The latest operator recheck observed 1.8 CPU allocatable and 1.766 CPU
  requested: 34m nominally free with the existing 20m CardScope Deployment
  already included. The `Recreate` replacement keeps that same request, so
  its quota delta is zero. Pending workloads can still race for node capacity,
  so schedulability is rechecked immediately before apply. No second node or
  pool change is authorised.
- OCR measured about 183 MiB RSS in the unrestricted run and returned to an
  approximately 86 MiB working set in the limited OCI smoke. The workload
  requests 256 MiB and limits memory to 384 MiB. The live node had about
  1,603 MiB nominal memory headroom; the tenant quota accepts the request but
  caps aggregate requested memory at exactly 256 MiB. `Recreate` therefore
  fits one app pod, while a backup or second app pod cannot coexist without a
  separately approved quota/capacity change.
- The canonical `pokemon.sent-tech.ca` A record resolves to the shared
  Traefik address `51.159.11.157`. Ingress `pokemon-cards` routes that host,
  and Certificate/Secret `pokemon-cards-tls` is Ready for the same DNS name
  (current certificate expiry: 21 October 2026).
- Repository `rhanka/pokemon-cards`, green CI, and an earlier immutable GHCR
  digest exist. That older digest does not attest the 20m/server-recognition
  release and must not be deployed; a new commit digest is required.
- CSI snapshots are not a five-year off-volume backup. No approved object bucket, KMS/IAM contract, lifecycle, erasure path, monitoring, or isolated restore rehearsal existed.

No cluster or sibling-repository mutation was made during this audit.

## Identity evidence

`https://auth.sent-tech.ca` publishes a valid OIDC discovery document, authorization/token endpoints, JWKS, and PKCE `S256` support. Those platform capabilities do not prove that CardScope's public client is registered. Production enablement still requires the exact registered:

- client ID;
- API audience;
- redirect URI and post-logout URI;
- allowed scopes and CORS/origin policy.

The API now refuses to start with OIDC enabled and no explicit audience. No client secret is accepted by the SPA.

OIDC proves identity, and the canonical product architecture grants central
collection storage to every enrolled account. Payment state does not select a
different storage authority. Production exposure still needs a distributed
request limit and a global storage budget sized for all enrolled accounts;
billing remains a commercial lifecycle decision rather than an account-storage
entitlement check.

## Publication evidence

The public repository is `https://github.com/rhanka/pokemon-cards`. The
original publish workflow and provenance-attested image passed. The next
deployment is deliberately blocked on the new commit's immutable digest; the
operator will not substitute the earlier artifact.

## Re-audit order

1. Validate, commit, push, run CI, and record the new immutable GHCR digest.
2. Recheck at least 20m CPU, the 256 MiB memory request, and provisionability of
   the 4 GiB PVC on the live cluster.
3. Server-side dry-run the application render, expand the existing PVC in
   place to 4 GiB, wait for `.status.capacity.storage=4Gi`, then apply the
   pinned digest through the owner-operated POC path.
4. Verify the 4 GiB PVC, Deployment, Service endpoints, canonical Traefik
   route, public TLS, health, resource limits, logs, and rollback.
5. Record the exact OIDC client/resource/callback/origin evidence.
6. Approve and rehearse off-PVC/application-consistent backup and restore.
7. Prove provider logout and migrate legacy raw-sub identity data, or attest
   that no such production data exists; then set `ACCOUNT_IDENTITY_READY=true`.
8. Set `ACCOUNT_RECOVERY_READY=true` only after the recovery gate passes.
9. Set an absolute fragment-free `OIDC_AUDIENCE` and `OIDC_REQUIRED=true` only
   after both readiness flags are true.
