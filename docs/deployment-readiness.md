# Deployment readiness record

Read-only evidence collected on 22 July 2026. This record separates a buildable workload from an authorised production deployment.

## Verdict

- **Local-only application:** GO after repository validation.
- **Scaleway production workload:** NO-GO until the gates below are applied and re-audited.
- **Cloud history/sync claim:** NO-GO; `OIDC_REQUIRED=false` is mandatory meanwhile.
- **OVH:** NO-GO because no active cluster, ingress, storage mapping, or kubeconfig was available.

## Scaleway evidence

- Kapsule `poc`, Kubernetes 1.35.3, Traefik, cert-manager, ACME issuers, `sbs-default`, and retained CSI snapshot classes exist.
- The proposed tenant contract exists only in sibling-repository commit `409e37c48abfc4a96f3e42360381b256a49af153`; it was not applied. The `pokemon-cards` namespace returned `NotFound`.
- The general node exposed 1.8 CPU allocatable and 1.776 CPU already requested: only 24m remained. The application requests 50m and a bounded backup Job would need roughly another 50m.
- `pokemon-cards.sent-tech.ca` had no DNS record.
- No immutable public `ghcr.io/rhanka/pokemon-cards@sha256:…` image existed.
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

The intended GitHub repository `rhanka/pokemon-cards` did not exist when checked, and the local GitHub CLI credential was invalid. The source can be committed locally without that credential, but repository creation, GHCR publication, CI execution, protected-environment approval, and digest deployment require a valid owner-authenticated GitHub session.

## Re-audit order

1. Apply/review the tenant contract and provide at least 100m combined workload/backup request headroom.
2. Approve the off-PVC encrypted backup, expiry/erasure, and quarterly isolated restore contract.
3. Register and return the exact OIDC public-client contract plus a time-bound Cloud Pass entitlement contract; keep sync disabled until the first restore succeeds.
4. Create DNS and a namespace-scoped CI identity.
5. Create the GitHub repository, run CI, publish the commit-tagged image, and record its registry digest.
6. Invoke the protected deploy workflow with that commit and digest; verify TLS, health, resources, logs, and rollback.
