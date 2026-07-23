# EVOL — Account-central collection and scan UX

Status: committed owner direction, 23 July 2026.

## Intent

CardScope provides a recognition service and an account-backed collection.
IndexedDB exists for responsiveness, offline reads, and an outbox; it is not
presented as the product's primary durability model. The scan flow infers the
catalogue language from bilingual results instead of asking before capture.

## Decisions

### D1 — Central account record

For every enrolled account, the authenticated server event log is the durable
collection record. The browser keeps an account-scoped materialized cache,
cursor, acknowledgements, and unsent operations so reads and edits continue
offline. The server accepts idempotent operations only for the OIDC `sub`.

### D2 — Enrollment and anonymous adoption

Scanning may start without an account. Enrollment is an explicit action such
as “Create my account and save my collection”. After the PKCE callback:

1. select the authenticated account domain;
2. inspect both the anonymous cache and the remote account;
3. when remote is empty, move the anonymous events into the account domain and
   upload the first batch with an atomic server-side `requireEmpty`
   precondition; an exact retry is idempotent and a conflicting remote write
   rolls the unaccepted adoption back to anonymous ownership;
4. when both contain data, require an explicit merge decision and never discard
   either collection silently;
5. show “saved” only after the server acknowledges the operations.

Account switches never expose or upload another account's outbox.

### D3 — Automatic synchronization

Synchronization is single-flight and automatically requested after enrollment,
authentication, a local mutation or import, browser `online`, `visibilitychange`,
and `pageshow`. It uses bounded pages, debounce, retry/backoff with jitter and
`Retry-After`; only transport, timeout, 408/425/429, and server failures retry
automatically. Protocol, quota, validation, and other client failures remain
visible without a retry loop. It exposes these states:

- account required;
- enrolling;
- changes pending;
- synchronizing;
- saved;
- offline, changes pending;
- authentication required;
- synchronization error.

`navigator.onLine` is only a scheduling hint; an acknowledged API response is
the durability signal.

### D4 — Destructive operations

An authenticated JSON “replace” cannot remain a local deletion because old
server events would be downloaded again. It stays unavailable until a
generation-aware atomic server replacement exists. Cloud/account deletion
rotates a server-owned generation and clears the matching local cache/outbox;
an outbox without a known generation is quarantined rather than attached to a
new epoch. Cross-tab mutation locks fence deletion. Export remains available
before deletion.

### D5 — Identity contract

The browser is a public OAuth client using authorization code + PKCE S256 and
no client secret. The redirect URI is
`https://pokemon.sent-tech.ca/auth/callback`. Access tokens are requested for
the CardScope API resource and validated by issuer, audience, expiry, and
subject. Production identity is enabled only after the Sentropic client row,
resource indicator, callback, token-renewal behavior, and logout behavior are
verified end to end. `OIDC_REQUIRED=false` remains the scan-only fail-closed
value until both that identity evidence and the recovery gate below pass.
Startup additionally requires the explicit operator attestations
`ACCOUNT_IDENTITY_READY=true` and `ACCOUNT_RECOVERY_READY=true`.

### D6 — Storage and recovery gate

Sizing for 1,000 accounts × 1,000 cards with every enrolled account central
selects a 4 GiB primary POC PVC with compact shared catalogue/quote snapshots.
Central recoverability is not advertised until an application-consistent
off-PVC backup, retention/erasure policy, missed-backup alert, and isolated
restore rehearsal pass. Account enrollment is not enabled before that gate.
The pod keeps its 20m CPU request.

### D7 — Recognition execution and language

The production recognizer remains the measured TypeScript service. A local
smartphone model is not shipped until a named device matrix proves the same
accuracy, memory, download-size, and latency contract.

One bilingual OCR pass is followed by bounded English and French catalogue
searches in parallel. Results retain their language and are scored together.
The selected candidate supplies the holding language. An EN/FR ambiguity must
abstain for confirmation; the interface locale is never used as the card
language. Manual search follows the same bilingual path.

Release performance gates on the exact 300m/384Mi runtime are:

- warm end-to-end recognition p95 at most 15 seconds on the agreed corpus;
- cold first response at most 30 seconds;
- busy/rate-limit rejection p95 at most 500 ms;
- hard end-to-end server deadline at most 35 seconds;
- no hidden in-memory OCR queue.

Metrics contain duration/status only, never photos, OCR text, or IP addresses.

### D8 — Interface simplification

- remove “Local first” / “Local by design” product messaging;
- keep a factual offline/synchronization status only when it helps the user;
- remove the printed-language picker before scan;
- show language on recognition candidates and confirmation;
- keep the interface-language selector in `AppChrome` and remove its duplicate
  from Settings;
- surface enrollment/account state in the top chrome and the account section.

## Adversarial review reconciliation

The recognition review demonstrated that OCR-language classification is not a
safe shortcut: identical Pikachu name/number pairs exist in both catalogues.
The bilingual union plus abstention is therefore selected.

The account review demonstrated that the existing domain switch intentionally
hides anonymous events instead of adopting them, and that manual-only sync,
local replace, and delete-then-reseed are incompatible with central durability.
Those paths are explicit release gates, not copy changes.
