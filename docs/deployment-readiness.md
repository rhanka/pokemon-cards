# Deployment readiness record

Read-only evidence collected on 22–23 July 2026. This record separates a buildable workload from an authorised production deployment.

## Verdict

- **Application build:** GO after the current validation and immutable publish.
- **Scaleway POC workload:** owner-authorised at an explicit 20m CPU request;
  apply only after the new digest and immediate capacity recheck.
- **Cloud history/sync claim:** NO-GO; `OIDC_REQUIRED=false` is mandatory meanwhile.
- **OVH scale tier:** planned after application validation; no active target
  cluster, ingress, storage mapping, or kubeconfig was available in this audit.

## Scaleway evidence

- Kapsule `poc`, Kubernetes 1.35.3, Traefik, cert-manager, ACME issuers, `sbs-default`, and retained CSI snapshot classes exist.
- The proposed tenant contract exists in sibling-repository commit
  `409e37c48abfc4a96f3e42360381b256a49af153`; client dry-run passes for all
  seven resources, but it has not been applied and the namespace is absent.
- The latest operator recheck observed 1.8 CPU allocatable and 1.766 CPU
  requested: 34m nominally free. An explicit `requests.cpu: 20m` is accepted
  by the tenant LimitRange/ResourceQuota and would leave 14m at that instant.
  Pending workloads can race for it, so this is rechecked immediately before
  apply. No second node or pool change is authorised.
- OCR measured about 183 MiB RSS in the unrestricted run and returned to an
  approximately 86 MiB working set in the limited OCI smoke. The workload
  requests 256 MiB and limits memory to 384 MiB. The live node had about
  1,603 MiB nominal memory headroom; the tenant quota accepts the request but
  caps aggregate requested memory at exactly 256 MiB. `Recreate` therefore
  fits one app pod, while a backup or second app pod cannot coexist without a
  separately approved quota/capacity change.
- `pokemon-cards.sent-tech.ca` had no DNS record.
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

OIDC proves identity, not payment entitlement. The current API has no approved, time-bound Cloud Pass claim or billing ledger, so enabling OIDC alone would grant sync to every authenticated account. Production cloud sync must additionally verify an owner-approved entitlement and its end date before creating or extending server storage. Sync also needs a distributed request limit and a global storage budget before exposure.

## Publication evidence

The public repository is `https://github.com/rhanka/pokemon-cards`. The
original publish workflow and provenance-attested image passed. The next
deployment is deliberately blocked on the new commit's immutable digest; the
operator will not substitute the earlier artifact.

## Re-audit order

1. Validate, commit, push, run CI, and record the new immutable GHCR digest.
2. Recheck at least 20m CPU and the 256 MiB memory request on the live node.
3. Apply the tenant contract, server-side dry-run the application render, and
   apply the pinned digest through the owner-operated POC path.
4. Verify PVC, Deployment, Service endpoints, and Traefik route before DNS.
5. Create the Cloudflare DNS record, then verify public TLS, health, resource
   limits, logs, and rollback.
6. Separately approve off-PVC backup/restore, OIDC client, and time-bound
   entitlement before ever enabling cloud sync.
