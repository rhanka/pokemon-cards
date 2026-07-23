# CardScope

CardScope is a mobile-first Pokémon card scanner, collection tracker, and
value assistant. It is built as an installable Svelte PWA using the Sentropic
design system, with a TypeScript Hono/Node API.

An enrolled account is the durable source for a collection. IndexedDB is its
account-scoped offline cache and outbox, so browsing and collection edits can
continue through a network interruption. Recognition itself remains an online
service. There are no ads. The launch price hypothesis is a single five-year
payment capped at observed cost plus 50%.

> CardScope is an independent project. It is not affiliated with, endorsed by, or sponsored by The Pokémon Company, Nintendo, Game Freak, Creatures, TCGplayer, or Cardmarket. Names, card art, and trademarks belong to their respective owners.

## What the MVP does

- camera or photo capture with a card alignment guide;
- transient server-side OCR, catalogue candidates, and explicit abstention;
- automatic English/French card-language search, with manual confirmation of
  the identified printing, finish, and condition;
- a sourced low/market/high valuation adapter and UI with currency, freshness, and confidence; the current public POC labels values unavailable until commercial quote-feed rights are confirmed;
- an account-scoped IndexedDB cache/outbox with quantities, cost basis, events,
  import, and export;
- Sentropic OIDC enrollment plus automatic, idempotent central synchronization,
  with atomic adoption of pre-enrollment cards;
- French and English UI, offline shell, and installable PWA support;
- reproducible lightweight-model training and evaluation pipeline without bundled copyrighted images or unlicensed weights.

CardScope does **not** authenticate cards and does **not** grade their condition from one photo.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

The web app listens on `http://localhost:5173`; Vite proxies `/api` to the API on `http://localhost:8787`.

```bash
npm run check
npm test
npm run build
npm start
```

Production serves the built SPA and API from one process. Persistent SQLite data defaults to `./data`; Kubernetes mounts that path from a PVC.

## Data and privacy posture

TCGdex is the primary multilingual catalogue adapter. Its catalogue database is MIT-licensed; the reviewed revision and licence text are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Kubernetes POC therefore enables TCGdex metadata only. Pokémon TCG API, card artwork, and market quotes retain independent fail-closed switches. A disabled catalogue is neither called nor served from cache; disabling card images removes their URLs from API responses. CardScope never scrapes marketplace HTML in production without explicit permission. When quotes are authorised and enabled, every displayed quote keeps its source, market, currency, variant, observation time, and stale threshold.

The browser first decodes, bounds, and re-encodes the image as a JPEG of at most 2 MiB and 1,600 px on its longest edge, which strips EXIF/GPS metadata. The Node service validates JPEG magic and decoded pixels, normalizes the image with Sharp, and runs one English/French Tesseract.js worker. Processing is in memory only: no image, raw OCR text, or IP address is written to SQLite, logs, analytics, or a training corpus. Responses contain only bounded name/number evidence and use `Cache-Control: no-store`. To find candidates, the service sends that bounded name/number query—not the photo or raw OCR—to TCGdex over HTTPS; as an external provider, TCGdex may log the request under its own policy. No metered Vision API, OCR CDN, Python service, or browser OCR is used at runtime. See [model and dataset study](docs/ml-model-study.md), [data refresh](docs/data-refresh.md), [architecture](docs/architecture.md), [deployment readiness](docs/deployment-readiness.md), [backup/restore contract](docs/backup-restore.md), [market study](docs/market-study.md), and [unit economics](docs/economics.md).

## Configuration

The complete non-secret contract is in [.env.example](.env.example). Important production settings are:

- `PUBLIC_ORIGIN=https://pokemon.sent-tech.ca`
- `DATA_DIR=/data`
- `TCGDEX_CATALOG_ENABLED=true` in the POC (MIT catalogue metadata only)
- `POKEMON_TCG_CATALOG_ENABLED=false` (independent secondary-source gate)
- `CARD_IMAGES_ENABLED=false` (independent artwork/image reuse gate)
- `MARKET_QUOTES_ENABLED=false` (safe default; enable only after the data-rights gate passes)
- `CATALOG_MAX_RESPONSE_BYTES=2097152` (hard pre-JSON upstream-response budget; maximum accepted configuration is 16 MiB)
- `RECOGNITION_ENABLED=true` in the POC, with 2 MiB / 4 MP / 30 s hard bounds and one OCR worker
- `OIDC_ISSUER=https://auth.sent-tech.ca`
- `OIDC_CLIENT_ID=pokemon-cards`
- `OIDC_AUDIENCE=<absolute fragment-free registered API resource URI>`
- `ACCOUNT_IDENTITY_READY=false` until the exact production client, audience,
  callback, provider logout, origin, and legacy-identity disposition are proven
- `ACCOUNT_RECOVERY_READY=false` until off-PVC backup, erasure, alerting, and
  isolated restore are proven
- `OIDC_REQUIRED=false` until both readiness attestations can safely be set to
  `true`

No OAuth client secret belongs in the SPA. The registered client is public and uses authorization code + PKCE.

The deployable product is **account-central for collection data**. IndexedDB
remains a local offline cache/outbox, not the durable authority. A first
anonymous scan is allowed for onboarding; on enrollment, CardScope pulls the
account before atomically adopting local events, and asks before merging when
both histories are non-empty. Automatic sync runs after authentication,
mutation, import, reconnection, page restore, and foregrounding. Collection
generations prevent a stale second device from resurrecting a deleted
collection.

The checked-in POC enables authorised TCGdex metadata and server OCR. Its
Kubernetes workload keeps the explicit `20m` CPU request and a 4 GiB primary
PVC. Account enrollment stays disabled until the public PKCE identity,
provider logout, legacy-identity disposition, and recovery gates all pass.
Only then may both readiness flags and `OIDC_REQUIRED` become `true`. The UI
does not label queued cache data as centrally saved until the server
acknowledges it, and it does not claim recoverable backup until the encrypted
off-PVC backup and isolated restore rehearsal are real.

## Commercial hypothesis

- Free pilot: scans under a transparent fair-use guard, central enrolled
  collection with offline access, current authorised estimates, bulk import,
  and export.
- Commercial hypothesis: **4.99 USD once for five years**, including central
  history, backup, recovery, and multi-device sync.
- Price is reviewed against complete observed cost and may never exceed cost plus 50%.

This is a launch hypothesis, not an active checkout until the pilot validates conversion, cost, and data rights.

## License

Original CardScope source code is MIT licensed. No licence granted by this repository applies to third-party card artwork, logos, names, market data, datasets, or model weights.
