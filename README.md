# CardScope

CardScope is a mobile-first, local-first Pokémon card scanner, collection tracker, and value assistant. It is built as an installable Svelte PWA using the Sentropic design system, with a TypeScript Hono/Node API.

The product has one deliberately simple promise: scanning and owning your data stay free; an optional five-year Cloud Pass pays only for backup, multi-device sync, and personal history. There are no ads. A scan photo is re-encoded on the phone, sent over TLS to the TypeScript recognition service, processed transiently in memory, and never retained or used for training.

> CardScope is an independent project. It is not affiliated with, endorsed by, or sponsored by The Pokémon Company, Nintendo, Game Freak, Creatures, TCGplayer, or Cardmarket. Names, card art, and trademarks belong to their respective owners.

## What the MVP does

- camera or photo capture with a card alignment guide;
- transient server-side OCR, catalogue candidates, and explicit abstention;
- manual confirmation of language, finish, and condition;
- a sourced low/market/high valuation adapter and UI with currency, freshness, and confidence; the current public POC labels values unavailable until commercial quote-feed rights are confirmed;
- a local IndexedDB collection with quantities, cost basis, events, import, and export;
- an optional Sentropic OIDC + idempotent event-sync path, disabled in the production manifest until its identity, backup, capacity, and restore gates pass;
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

- `PUBLIC_ORIGIN=https://pokemon-cards.sent-tech.ca`
- `DATA_DIR=/data`
- `TCGDEX_CATALOG_ENABLED=true` in the POC (MIT catalogue metadata only)
- `POKEMON_TCG_CATALOG_ENABLED=false` (independent secondary-source gate)
- `CARD_IMAGES_ENABLED=false` (independent artwork/image reuse gate)
- `MARKET_QUOTES_ENABLED=false` (safe default; enable only after the data-rights gate passes)
- `CATALOG_MAX_RESPONSE_BYTES=2097152` (hard pre-JSON upstream-response budget; maximum accepted configuration is 16 MiB)
- `RECOGNITION_ENABLED=true` in the POC, with 2 MiB / 4 MP / 30 s hard bounds and one OCR worker
- `OIDC_ISSUER=https://auth.sent-tech.ca`
- `OIDC_CLIENT_ID=pokemon-cards`
- `OIDC_AUDIENCE=<registered API audience>`
- `OIDC_REQUIRED=false` (the safe default; enable only after the production gates below)

No OAuth client secret belongs in the SPA. The registered client is public and uses authorization code + PKCE.

The deployable product is **local-first for collection data**, while recognition is an online service. Local history, import, and export work without an account; manual catalogue search remains the fallback when a scan is unavailable. The checked-in POC enables only authorised TCGdex metadata and server OCR. Cloud sync stays off until the public-client registration and audience are confirmed, an off-PVC encrypted backup exists, deletion/expiry covers those backups, and an isolated restore rehearsal has passed. The UI and API never claim that unsafeguarded server data is backed up.

## Commercial hypothesis

- Free: scans under a transparent fair-use guard, local collection, current authorised estimates, bulk import, and export.
- Cloud Pass: **4.99 USD once for five years** for backup, sync, and personal history.
- Price is reviewed against complete observed cost and may never exceed cost plus 50%.

This is a launch hypothesis, not an active checkout until the pilot validates conversion, cost, and data rights.

## License

Original CardScope source code is MIT licensed. No licence granted by this repository applies to third-party card artwork, logos, names, market data, datasets, or model weights.
