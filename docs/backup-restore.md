# Cloud history backup and restore contract

The five-year Cloud Pass is not backed by a Kubernetes volume snapshot alone. Read-only cluster audit on 22 July 2026 found Scaleway CSI snapshot classes (`scw-snapshot` and `scw-snapshot-retain`) but no scheduled backup controller, off-volume copy, or proven SQLite restore procedure.

## Minimum production contract

- Target RPO: 24 hours.
- Target RTO: 4 hours for the initial 1 GiB tier, including validation.
- Produce one application-consistent SQLite logical backup every day through the SQLite backup API. Copying the live database file directly is forbidden.
- Store the backup outside the PVC in a separately authorised object bucket with encryption, least-privilege IAM, versioning, and a five-year lifecycle.
- Store a manifest beside every object: UTC timestamp, application/schema version, byte size, SHA-256 digest, and source PVC/database identity.
- A retained CSI snapshot may accelerate recovery only after the writer is quiesced or WAL consistency is proven. It is never the sole backup and never the five-year archive.
- Rehearse restoration at least quarterly into an isolated namespace/PVC. Verify the digest, run `PRAGMA integrity_check`, start the application, and compare account/event counts plus a documented sample. Never rehearse by overwriting the live PVC.
- Account deletion and five-year expiry must also remove or cryptographically expire personal backups according to the approved retention/legal-hold policy.

## Current gate

No backup CronJob is enabled in this repository because the destination bucket, residency, KMS/IAM secret, lifecycle, and cost have not yet been approved by the infrastructure/data owner. The latest live check found only 34m nominal CPU headroom before scheduling the 20m POC app. The tenant also caps aggregate requested memory at 256 MiB, exactly the app request, so even a small concurrent backup Job needs an explicit quota/capacity review. No backup Job or second node is authorised in this phase.

Production Cloud Pass claims remain disabled until:

1. the object-storage and IAM contract is approved without committing credentials;
2. capacity exists for both the app and the bounded backup Job;
3. the first isolated restore rehearsal passes;
4. monitoring alerts on missed backup, digest failure, lifecycle failure, and restore age;
5. measured storage/operation cost remains inside the unit-economics envelope.

Local-only use is unaffected: the user can export a restorable JSON event log at any time.
