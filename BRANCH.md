# Feature: CardScope mobile MVP

## Objective

- [x] Deliver a deployable mobile-first Svelte PWA that identifies Pokémon card printings, estimates sourced market value, and keeps a 1,000-card local-first collection with optional five-year cloud sync.

## Scope / Guardrails

- [x] Keep scan inference local by default and never persist a photo without explicit consent.
- [x] Keep finish, language, and condition user-confirmed; never claim authentication or automated grading.
- [x] Use only catalogue, price, code, dataset, and model assets with documented compatible provenance.
- [x] Keep free-user marginal server cost near zero and cap paid price at complete cost plus 50%.
- [x] Deploy only to the live Scaleway `poc` path; keep OVH forbidden until its platform is operational.
- [x] Keep all new product and code text in English; French is a supported UI locale.

## Branch Scope Boundaries

- [x] Allowed paths: `src/**`, `server/**`, `shared/**`, `tests/**`, `e2e/**`, `public/**`, `ml/**`, `docs/**`, `spec/**`, `deploy/**`, `scripts/**`.
- [x] Allowed root files: `BRANCH.md`, `README.md`, `LICENSE`, `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `svelte.config.js`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.env.example`.
- [x] Forbidden paths: `../poc-k8s/**`, `../sentropic/**`, `Makefile`, `docker-compose*.yml`, `.cursor/rules/**`.
- [x] Conditional paths: `.github/workflows/**` only under `BR01-EX1`.
- [x] BR01-EX1: add CI and deployment workflows because repository publication and Kubernetes delivery are explicit scope; impact is repository automation; rollback is deleting the workflows without changing runtime data.

## Feedback Loop

- [x] Record infrastructure capacity, DNS, OIDC registration, GitHub authentication, or external data-license blockers as `attention` before the affected action.
- [x] Do not bypass a blocked external mutation by copying credentials, editing sibling worktrees, or shipping unlicensed weights.

## Orchestration Mode

- [x] Mono-branch with selective lot commits.
- [ ] Multi-branch.

## Plan / Todo

- [x] Lot 0 — Evidence, decisions, and baseline
  - [x] Record market, data-source, ML, legal, unit-economics, auth, and infrastructure findings.
  - [x] Reconcile at least two independent adversarial reviews.
  - [x] Write `SPEC_STUDY`, `SPEC_VOL`, and numbered `SPEC_EVOL` decisions.
  - [x] Initialize the Git repository without modifying unrelated work.
  - [x] Add project metadata, dependency lock, environment contract, and baseline README.
  - [x] Lot gate: `npm run check` and dependency audit baseline recorded.
- [x] Lot 1 — API, catalogue normalization, and event sync
  - [x] Add shared card, quote, holding, recognition, and sync types.
  - [x] Add TCGdex primary and Pokémon TCG API secondary adapters with timeouts, cache, stale metadata, and normalized quotes.
  - [x] Add SQLite WAL cache/event schema with idempotent per-user sync operations and five-year retention metadata.
  - [x] Add OIDC JWKS bearer validation with an explicit development-disabled mode.
  - [x] Add `/api/health`, `/api/config`, catalogue search/detail, and authenticated sync routes.
  - [x] Add `tests/server/catalog.test.ts`, `tests/server/store.test.ts`, and `tests/server/api.test.ts`.
  - [x] Lot gate: `npm run test -- tests/server` and `npm run check`.
- [x] Lot 2 — Mobile PWA, recognition, collection, and ROI UX
  - [x] Add installable shell, service worker, responsive navigation, camera/file capture, crop guide, and offline states.
  - [x] Add local OCR parsing, perceptual color-hash reranking, optional model adapter, score fusion, top candidates, and abstention.
  - [x] Add IndexedDB event-sourced holdings, duplicate quantities, condition/finish confirmation, activity history, import, JSON/CSV export, and sync batching.
  - [x] Add sourced low/median/high value, freshness, liquidity confidence, cost basis, net-value explanation, and cards-to-review prioritization.
  - [x] Add French and English product copy with accessible touch targets, keyboard states, reduced motion, and no dark-pattern paywall.
  - [x] Add `tests/client/ocr.test.ts`, `tests/client/scoring.test.ts`, `tests/client/collection.test.ts`, and component interaction tests.
  - [x] Lot gate: `npm run test -- tests/client`, `npm run check`, and `npm run build`.
- [x] Lot 3 — Reproducible lightweight vision pipeline
  - [x] Add a rights-manifest input contract that refuses sources without explicit provenance fields.
  - [x] Add synthetic perspective, glare, sleeve, blur, shadow, colour, JPEG, and occlusion augmentation.
  - [x] Add MobileNetV3-Small 128D metric-learning training, UID-separated evaluation, hard-negative mining, calibration, INT8 export, and reference-index generation scripts.
  - [x] Add benchmark report schema for top-1, Recall@5, false accept, calibration, model size, and per-device latency.
  - [x] Keep model weights and copyrighted source images out of Git unless independently cleared.
  - [x] Add `ml/tests/test_rights_manifest.py`, `ml/tests/test_split.py`, and `ml/tests/test_metrics.py`.
  - [x] Lot gate: `python -m pytest ml/tests` and the dry-run fixture produces a deterministic report.
- [ ] Lot 4 — Auth, container, Kubernetes, and CI/CD
  - [x] Wire OIDC authorization-code + PKCE callback/logout and cloud-sync UI when the public client is configured.
  - [x] Add a non-root multi-stage OCI image, healthcheck, immutable runtime, SQLite PVC path, and graceful shutdown.
  - [x] Add namespace-independent Deployment, Service, PVC, Ingress TLS, NetworkPolicy, PodDisruptionBudget, and resource limits under `deploy/k8s`.
  - [x] Add GitHub Actions checks, GHCR build with immutable SHA tag, and namespace-scoped manual deployment under `BR01-EX1`.
  - [ ] Obtain OIDC client registration, namespace contract, DNS record, capacity, and tenant kubeconfig through their owning repositories/agents.
  - [x] Add container and manifest validation tests.
  - [ ] Lot gate: `npm run validate`, OCI build, Kubernetes server-side dry-run, and local `/api/health` smoke.
- [ ] Lot 5 — Final validation, publication, and production smoke
  - [x] Run static, unit, integration, build, accessibility, security, container, and manifest gates.
  - [ ] Run a mobile browser smoke for capture, search, add, edit, export, offline reload, OIDC-disabled fallback, and health.
  - [x] Run consensus review with at least two independent peers and reconcile all high-confidence findings.
  - [ ] Stage only intended files, commit all lots, create `rhanka/pokemon-cards`, and push the intended branch.
  - [ ] Build/publish the immutable GHCR image and deploy only after owner-controlled infra gates are satisfied.
  - [ ] Verify public TLS, `/api/health`, no console errors, image tag, resources, and rollback command.
  - [ ] Lot gate: clean repository status, green CI, public production smoke, and documented remaining benchmark/legal gates.
