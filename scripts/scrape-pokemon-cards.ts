import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  fusionAssetPath,
  fusionCardKey,
  selectFusionCardsCsv,
  type FusionCardRow,
  type RejectedFusionCardRow,
} from "./noncommercial-pilot-lib.js";

const DATASET_CSV_URL =
  "https://huggingface.co/datasets/TheFusion21/PokemonCards/resolve/main/train.csv?download=true";
const DATASET_PAGE_URL =
  "https://huggingface.co/datasets/TheFusion21/PokemonCards";
const CC_BY_NC_4_LICENSE_URL =
  "https://creativecommons.org/licenses/by-nc/4.0/";
const SOURCE_ID = "thefusion21-pokemoncards";
const COLLECTOR_VERSION = 1;
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_SOURCE_CARDS = 20_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const STATE_CHECKPOINT_INTERVAL = 25;

interface Options {
  acceptSourceTerms: boolean;
  all: boolean;
  concurrency: number;
  dryRun: boolean;
  limit: number;
  maxImageBytes: number;
  maxPixels: number;
  maxTotalBytes: number;
  offset: number;
  outputDirectory: string;
  timeoutMs: number;
}

interface ManifestItem {
  item_id: string;
  card_uid: string;
  relative_path: string;
  sha256: string;
  source_id: string;
  role: "reference";
  capture_group: string;
  language: string;
  set_id: string;
  variant: string;
}

interface RightsManifest {
  schema_version: 1;
  dataset_id: string;
  created_at: string;
  description: string;
  intended_use: string;
  sources: Array<Record<string, string | boolean>>;
  items: ManifestItem[];
}

interface IntakeState {
  schema_version: 1;
  source_csv_sha256: string;
  selection: {
    all: boolean;
    available: number;
    limit: number;
    offset: number;
  };
  completed: Record<string, ManifestItem>;
  observed_content_types?: Record<string, string | null>;
  created_at: string;
  updated_at: string;
}

interface FetchResult {
  body: Buffer;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  url: string;
}

class RetryableHttpError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly status: number,
    retryAfter: string | null,
    url: string,
  ) {
    super(`request failed (${status}) for ${url}`);
    this.retryAfterMs = parseRetryAfter(retryAfter);
  }
}

function usage(): never {
  throw new Error(
    [
      "Usage: tsx scripts/scrape-pokemon-cards.ts --accept-source-terms (--limit=<1..20000> | --all) [options]",
      "Options: --offset=<0..19999> --output=<ignored directory> --concurrency=<1..4>",
      "         --max-image-bytes=<bytes> --max-pixels=<pixels> --max-total-bytes=<bytes>",
      "         --timeout-ms=<ms> --dry-run",
      "--all requires an explicit --max-total-bytes. Re-running the same command resumes from scrape-state.json.",
      "The collector uses only the declared CSV and approved image CDN; it does not crawl pages or bypass access controls.",
    ].join("\n"),
  );
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  name: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`);
  }
  return parsed;
}

function parseOptions(arguments_: string[]): Options {
  const values = new Map<string, string>();
  let acceptSourceTerms = false;
  let all = false;
  let dryRun = false;
  for (const argument of arguments_) {
    if (argument === "--accept-source-terms") acceptSourceTerms = true;
    else if (argument === "--all") all = true;
    else if (argument === "--dry-run") dryRun = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [key, value] = argument.slice(2).split("=", 2) as [string, string];
      values.set(key, value);
    } else usage();
  }
  const known = new Set([
    "limit",
    "offset",
    "output",
    "concurrency",
    "max-image-bytes",
    "max-pixels",
    "max-total-bytes",
    "timeout-ms",
  ]);
  if (!acceptSourceTerms || all === values.has("limit")) usage();
  for (const key of values.keys()) if (!known.has(key)) usage();
  if (all && !values.has("max-total-bytes")) usage();

  const limit = all
    ? MAX_SOURCE_CARDS
    : parsePositiveInteger(values.get("limit"), "--limit", MAX_SOURCE_CARDS);
  const maxImageBytes = parsePositiveInteger(
    values.get("max-image-bytes") ?? String(4 * 1024 * 1024),
    "--max-image-bytes",
    8 * 1024 * 1024,
  );
  return {
    acceptSourceTerms,
    all,
    concurrency: parsePositiveInteger(
      values.get("concurrency") ?? "2",
      "--concurrency",
      4,
    ),
    dryRun,
    limit,
    maxImageBytes,
    maxPixels: parsePositiveInteger(
      values.get("max-pixels") ?? "10000000",
      "--max-pixels",
      20_000_000,
    ),
    maxTotalBytes: parsePositiveInteger(
      values.get("max-total-bytes") ??
        String(
          Math.min(
            MAX_TOTAL_BYTES,
            Math.max(256 * 1024 * 1024, limit * maxImageBytes),
          ),
        ),
      "--max-total-bytes",
      MAX_TOTAL_BYTES,
    ),
    offset: parseNonNegativeInteger(
      values.get("offset") ?? "0",
      "--offset",
      MAX_SOURCE_CARDS - 1,
    ),
    outputDirectory: resolve(
      values.get("output") ?? "ml/data/pokemon-cards-scrape",
    ),
    timeoutMs: parsePositiveInteger(
      values.get("timeout-ms") ?? "20000",
      "--timeout-ms",
      60_000,
    ),
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, 30_000);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp))
    return Math.min(Math.max(0, timestamp - Date.now()), 30_000);
  return undefined;
}

function assertApprovedUrl(value: string, hosts: readonly string[]): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    !hosts.includes(parsed.hostname) ||
    parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`URL is outside approved HTTPS hosts: ${value}`);
  }
  return parsed;
}

async function fetchBounded(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  finalHosts: readonly string[],
): Promise<FetchResult> {
  let current = assertApprovedUrl(url, finalHosts);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new Error(`redirect without location for ${current}`);
      if (redirects === MAX_REDIRECTS)
        throw new Error(`too many redirects for ${url}`);
      current = assertApprovedUrl(
        new URL(location, current).toString(),
        finalHosts,
      );
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableHttpError(
        response.status,
        response.headers.get("retry-after"),
        current.toString(),
      );
    }
    if (!response.ok)
      throw new Error(`request failed (${response.status}) for ${current}`);
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > maxBytes) {
      throw new Error(
        `response exceeds ${maxBytes} byte budget for ${current}`,
      );
    }
    if (!response.body) throw new Error(`response has no body for ${current}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(
            `response exceeds ${maxBytes} byte budget for ${current}`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      body: Buffer.concat(chunks, total),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      url: current.toString(),
    };
  }
  throw new Error(`redirect processing failed for ${url}`);
}

async function fetchWithRetry(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  finalHosts: readonly string[],
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchBounded(url, maxBytes, timeoutMs, finalHosts);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof RetryableHttpError || error instanceof TypeError;
      if (!retryable || attempt === 2) break;
      const retryAfter =
        error instanceof RetryableHttpError ? error.retryAfterMs : undefined;
      const backoffMs = retryAfter ?? 250 * 2 ** attempt;
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, backoffMs),
      );
    }
  }
  throw lastError;
}

function pngDimensions(
  payload: Buffer,
  card: FusionCardRow,
  maxPixels: number,
): void {
  const signature = "89504e470d0a1a0a";
  if (
    payload.length < 24 ||
    payload.subarray(0, 8).toString("hex") !== signature
  ) {
    throw new Error(`reference ${card.id} is not a PNG payload`);
  }
  if (payload.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`reference ${card.id} is missing its PNG IHDR header`);
  }
  const width = payload.readUInt32BE(16);
  const height = payload.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > maxPixels) {
    throw new Error(
      `reference ${card.id} has unsafe dimensions ${width}x${height}`,
    );
  }
}

async function writeAtomically(
  path: string,
  payload: string | Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, payload);
  await rename(temporary, path);
}

async function loadState(path: string): Promise<IntakeState | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as IntakeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(
      path,
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      {
        flag: "wx",
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`collector lock already exists: ${path}`);
    }
    throw error;
  }
  return async () => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}

function createManifest(items: ManifestItem[]): RightsManifest {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    dataset_id: "thefusion21-pokemoncards-noncommercial-scrape-v1",
    created_at: now,
    description:
      "Locally collected, bounded visual-retrieval experiment. Source assets, model weights, and indexes remain outside Git and are not a public release.",
    intended_use:
      "Local non-commercial visual-retrieval experiment only; public model, index, and asset distribution remain disabled.",
    sources: [
      {
        source_id: SOURCE_ID,
        provider: "TheFusion21/PokemonCards on Hugging Face",
        origin_url: DATASET_PAGE_URL,
        acquired_at: now,
        rights_holder:
          "Dataset-card declaration; upstream image rights holder not independently verified",
        rights_basis: "licensed",
        license_id: "CC-BY-NC-4.0",
        license_url: CC_BY_NC_4_LICENSE_URL,
        terms_url: DATASET_PAGE_URL,
        terms_verified_at: now,
        commercial_use_allowed: false,
        noncommercial_use_allowed: true,
        derivatives_allowed: true,
        ml_training_allowed: true,
        model_redistribution_allowed: false,
        noncommercial_model_redistribution_allowed: false,
        asset_redistribution_allowed: false,
        upstream_rights_verified: false,
        attribution:
          "TheFusion21/PokemonCards, CC-BY-NC-4.0 declaration on Hugging Face; original Pokémon artwork and image-host authority are not independently verified.",
        notes:
          "The operator acknowledged the displayed source terms before collection. This local provenance record is not a publication clearance.",
      },
    ],
    items,
  };
}

async function downloadCard(
  card: FusionCardRow,
  assetsDirectory: string,
  known: ManifestItem | undefined,
  options: Options,
): Promise<{
  item: ManifestItem;
  downloadedBytes: number;
  contentType: string | null;
  reused: boolean;
}> {
  const relativePath = fusionAssetPath(card);
  const destination = resolve(assetsDirectory, relativePath);
  if (known) {
    try {
      const existing = await readFile(destination);
      pngDimensions(existing, card, options.maxPixels);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (
        known.relative_path === relativePath &&
        known.sha256 === existingHash
      ) {
        return {
          item: known,
          downloadedBytes: 0,
          contentType: null,
          reused: true,
        };
      }
    } catch {
      // A partial or altered file is replaced from the declared source below.
    }
  }
  const response = await fetchWithRetry(
    card.imageUrl,
    options.maxImageBytes,
    options.timeoutMs,
    ["images.pokemontcg.io"],
  );
  pngDimensions(response.body, card, options.maxPixels);
  await writeAtomically(destination, response.body);
  return {
    item: {
      item_id: `fusion:${fusionCardKey(card)}`,
      card_uid: `tcg:${fusionCardKey(card)}`,
      relative_path: relativePath,
      sha256: createHash("sha256").update(response.body).digest("hex"),
      source_id: SOURCE_ID,
      role: "reference",
      capture_group: "catalogue-reference",
      language: "en",
      set_id: card.setId,
      variant: "unknown",
    },
    downloadedBytes: response.body.length,
    contentType: response.contentType,
    reused: false,
  };
}

function initialState(
  sourceHash: string,
  options: Options,
  available: number,
): IntakeState {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    source_csv_sha256: sourceHash,
    selection: {
      all: options.all,
      available,
      limit: options.limit,
      offset: options.offset,
    },
    completed: {},
    observed_content_types: {},
    created_at: now,
    updated_at: now,
  };
}

function assertReusableState(
  state: IntakeState,
  sourceHash: string,
  options: Options,
  available: number,
): void {
  if (
    state.schema_version !== 1 ||
    state.source_csv_sha256 !== sourceHash ||
    state.selection.all !== options.all ||
    state.selection.limit !== options.limit ||
    state.selection.offset !== options.offset ||
    state.selection.available !== available
  ) {
    throw new Error(
      "existing scrape-state.json belongs to a different source or selection; choose a separate --output directory",
    );
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const source = await fetchWithRetry(
    DATASET_CSV_URL,
    MAX_MANIFEST_BYTES,
    options.timeoutMs,
    ["huggingface.co"],
  );
  const sourceHash = createHash("sha256").update(source.body).digest("hex");
  const selection = selectFusionCardsCsv(source.body.toString("utf8"), {
    limit: options.limit,
    offset: options.offset,
  });
  if (options.all && options.offset > 0) {
    throw new Error("--all cannot be combined with a non-zero --offset");
  }
  if (selection.cards.length !== options.limit && !options.all) {
    throw new Error(
      `source has only ${selection.cards.length} valid cards for the requested selection`,
    );
  }
  if (options.all) options.limit = selection.cards.length;
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          available: selection.available,
          cards: selection.cards.length,
          rejected_rows: selection.rejected.length,
          source_csv_sha256: sourceHash,
          source_url: source.url,
          mode: "dry-run",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const assetsDirectory = resolve(options.outputDirectory, "assets");
  const statePath = resolve(options.outputDirectory, "scrape-state.json");
  const lockPath = resolve(options.outputDirectory, ".scrape.lock");
  const releaseLock = await acquireLock(lockPath);
  try {
    const state =
      (await loadState(statePath)) ??
      initialState(sourceHash, options, selection.available);
    assertReusableState(state, sourceHash, options, selection.available);
    await writeAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const failures: Array<{ cardId: string; reason: string }> = [];
    const itemByCardId = new Map(
      selection.cards.map((card) => [card.id, card]),
    );
    let downloadedBytes = 0;
    let reusedItems = 0;
    let cursor = 0;
    let stateWrite = Promise.resolve();
    let pendingStateChanges = 0;
    const persistState = (): Promise<void> => {
      if (pendingStateChanges === 0) return stateWrite;
      const payload = `${JSON.stringify(state, null, 2)}\n`;
      pendingStateChanges = 0;
      stateWrite = stateWrite.then(() => writeAtomically(statePath, payload));
      return stateWrite;
    };
    const record = (
      card: FusionCardRow,
      item: ManifestItem,
      contentType: string | null,
    ): Promise<void> => {
      state.completed[card.id] = item;
      state.observed_content_types ??= {};
      state.observed_content_types[card.id] = contentType;
      state.updated_at = new Date().toISOString();
      pendingStateChanges += 1;
      return pendingStateChanges >= STATE_CHECKPOINT_INTERVAL
        ? persistState()
        : stateWrite;
    };
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= selection.cards.length) return;
        const card = selection.cards[index]!;
        try {
          const result = await downloadCard(
            card,
            assetsDirectory,
            state.completed[card.id],
            options,
          );
          if (
            downloadedBytes + result.downloadedBytes >
            options.maxTotalBytes
          ) {
            throw new Error(
              `batch exceeds --max-total-bytes (${options.maxTotalBytes})`,
            );
          }
          downloadedBytes += result.downloadedBytes;
          if (result.reused) reusedItems += 1;
          await record(card, result.item, result.contentType);
        } catch (error) {
          failures.push({
            cardId: card.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: options.concurrency }, () => worker()),
    );
    persistState();
    await stateWrite;
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} downloads failed; state was saved for a safe retry. First failure: ${failures[0]!.cardId}: ${failures[0]!.reason}`,
      );
    }

    const items = selection.cards.map((card) => {
      const item = state.completed[card.id];
      if (!item || !itemByCardId.has(card.id))
        throw new Error(`missing completed item for ${card.id}`);
      return item;
    });
    const manifestPath = resolve(
      options.outputDirectory,
      "rights-manifest.json",
    );
    const reportPath = resolve(options.outputDirectory, "intake-report.json");
    await writeAtomically(
      manifestPath,
      `${JSON.stringify(createManifest(items), null, 2)}\n`,
    );
    await writeAtomically(
      reportPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          collector_version: COLLECTOR_VERSION,
          created_at: new Date().toISOString(),
          source: {
            csv_url: source.url,
            csv_sha256: sourceHash,
            etag: source.etag,
            last_modified: source.lastModified,
          },
          selection: state.selection,
          limits: {
            max_image_bytes: options.maxImageBytes,
            max_pixels: options.maxPixels,
            max_total_bytes: options.maxTotalBytes,
          },
          rejected_rows: selection.rejected satisfies RejectedFusionCardRow[],
          items: selection.cards.map((card) => ({
            card_id: card.id,
            image_url: card.imageUrl,
            sha256: state.completed[card.id]!.sha256,
            observed_content_type:
              state.observed_content_types?.[card.id] ?? null,
          })),
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          cards: items.length,
          downloaded_bytes: downloadedBytes,
          manifest: manifestPath,
          report: reportPath,
          resumed_items: reusedItems,
          next: "npm run build:visual-model -- --acknowledge-experimental-model --manifest=<manifest> --assets=<assets>",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await releaseLock();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`scrape-pokemon-cards: ${message}\n`);
  process.exitCode = 2;
});
