# CardScope

CardScope is a mobile-first, local-first Pokémon card scanner, collection tracker, and value assistant. It is built as an installable Svelte PWA using the Sentropic design system, with a TypeScript Hono/Node API.

The product has one deliberately simple promise: scanning and owning your data stay free; an optional five-year Cloud Pass pays only for backup, multi-device sync, and personal history. There are no ads and card photos stay on the device by default.

> CardScope is an independent project. It is not affiliated with, endorsed by, or sponsored by The Pokémon Company, Nintendo, Game Freak, Creatures, TCGplayer, or Cardmarket. Names, card art, and trademarks belong to their respective owners.

## What the MVP does

- camera or photo capture with a card alignment guide;
- on-device OCR and visual candidate reranking with explicit abstention;
- manual confirmation of language, finish, and condition;
- sourced low/market/high values with currency, freshness, and confidence;
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

TCGdex is the primary multilingual catalogue adapter. Pokémon TCG API is an optional secondary adapter. Each catalogue, card images, and market quotes have independent fail-closed switches. All four are disabled by default until the corresponding commercial access and reuse rights are documented. A disabled catalogue is neither called nor served from cache; disabling card images removes their URLs from API responses. CardScope never scrapes marketplace HTML in production without explicit permission. When quotes are authorised and enabled, every displayed quote keeps its source, market, currency, variant, observation time, and stale threshold.

Recognition images are processed locally. The server receives confirmed identifiers and collection events, not the source photo. Tesseract's worker, WASM core, and English/French language data are copied from pinned npm dependencies into the same-origin build; no OCR CDN or vision API is called at runtime. The service worker caches those larger assets lazily after the first successful online OCR load. See [model and dataset study](docs/ml-model-study.md), [data refresh](docs/data-refresh.md), [architecture](docs/architecture.md), [deployment readiness](docs/deployment-readiness.md), [backup/restore contract](docs/backup-restore.md), [market study](docs/market-study.md), and [unit economics](docs/economics.md).

## Configuration

The complete non-secret contract is in [.env.example](.env.example). Important production settings are:

- `PUBLIC_ORIGIN=https://pokemon-cards.sent-tech.ca`
- `DATA_DIR=/data`
- `TCGDEX_CATALOG_ENABLED=false` (enable only after TCGdex catalogue rights are recorded)
- `POKEMON_TCG_CATALOG_ENABLED=false` (independent secondary-source gate)
- `CARD_IMAGES_ENABLED=false` (independent artwork/image reuse gate)
- `MARKET_QUOTES_ENABLED=false` (safe default; enable only after the data-rights gate passes)
- `CATALOG_MAX_RESPONSE_BYTES=2097152` (hard pre-JSON upstream-response budget; maximum accepted configuration is 16 MiB)
- `OIDC_ISSUER=https://auth.sent-tech.ca`
- `OIDC_CLIENT_ID=pokemon-cards`
- `OIDC_AUDIENCE=<registered API audience>`
- `OIDC_REQUIRED=false` (the safe default; enable only after the production gates below)

No OAuth client secret belongs in the SPA. The registered client is public and uses authorization code + PKCE.

The deployable product is currently **local-first/local-only**: local OCR, collection history, import, and export work without an account. Catalogue identification and estimates additionally require at least one authorised catalogue switch; the checked-in production manifest intentionally enables none. Cloud sync must stay off until the public-client registration and audience are confirmed, an off-PVC encrypted backup exists, deletion/expiry covers those backups, and an isolated restore rehearsal has passed. The UI and API never claim that unsafeguarded server data is backed up.

## Commercial hypothesis

- Free: unlimited local scans, collection, current estimates, and export.
- Cloud Pass: **4.99 USD once for five years** for backup, sync, and personal history.
- Price is reviewed against complete observed cost and may never exceed cost plus 50%.

This is a launch hypothesis, not an active checkout until the pilot validates conversion, cost, and data rights.

## License

Original CardScope source code is MIT licensed. No licence granted by this repository applies to third-party card artwork, logos, names, market data, datasets, or model weights.
