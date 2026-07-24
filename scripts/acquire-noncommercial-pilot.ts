import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  fusionAssetPath,
  fusionCardKey,
  parseFusionCardsCsv,
  type FusionCardRow,
} from "./noncommercial-pilot-lib.js";

const DATASET_CSV_URL =
  "https://huggingface.co/datasets/TheFusion21/PokemonCards/resolve/main/train.csv?download=true";
const DATASET_PAGE_URL = "https://huggingface.co/datasets/TheFusion21/PokemonCards";
const CC_BY_NC_4_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/4.0/";
const SOURCE_ID = "thefusion21-pokemoncards";
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;

interface Options {
  acceptNoncommercialExperiment: boolean;
  concurrency: number;
  dryRun: boolean;
  limit: number;
  maxImageBytes: number;
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

function usage(): never {
  throw new Error(
    [
      "Usage: tsx scripts/acquire-noncommercial-pilot.ts --accept-noncommercial-experiment --limit=<1..13088> [options]",
      "Options: --output=<ignored directory> --concurrency=<1..4> --max-image-bytes=<bytes> --timeout-ms=<ms> --dry-run",
      "This downloads a local research corpus only. It does not clear, publish, or deploy any model artefact.",
    ].join("\n"),
  );
}

function parsePositiveInteger(value: string | undefined, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function parseOptions(arguments_: string[]): Options {
  const values = new Map<string, string>();
  let acceptNoncommercialExperiment = false;
  let dryRun = false;
  for (const argument of arguments_) {
    if (argument === "--accept-noncommercial-experiment") {
      acceptNoncommercialExperiment = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument.startsWith("--") && argument.includes("=")) {
      const [key, value] = argument.slice(2).split("=", 2) as [string, string];
      values.set(key, value);
    } else {
      usage();
    }
  }
  if (!acceptNoncommercialExperiment || !values.has("limit")) usage();
  const known = new Set(["limit", "output", "concurrency", "max-image-bytes", "timeout-ms"]);
  for (const key of values.keys()) {
    if (!known.has(key)) usage();
  }
  return {
    acceptNoncommercialExperiment,
    concurrency: parsePositiveInteger(values.get("concurrency") ?? "2", "--concurrency", 4),
    dryRun,
    limit: parsePositiveInteger(values.get("limit"), "--limit", 13_088),
    maxImageBytes: parsePositiveInteger(
      values.get("max-image-bytes") ?? String(4 * 1024 * 1024),
      "--max-image-bytes",
      8 * 1024 * 1024,
    ),
    outputDirectory: resolve(values.get("output") ?? "ml/data/thefusion21-pilot"),
    timeoutMs: parsePositiveInteger(values.get("timeout-ms") ?? "20000", "--timeout-ms", 60_000),
  };
}

async function fetchBounded(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  finalHosts: readonly string[],
): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !finalHosts.includes(finalUrl.hostname)) {
    throw new Error(`redirect resolved outside approved hosts for ${url}`);
  }
  if (!response.ok) throw new Error(`request failed (${response.status}) for ${url}`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} byte budget for ${url}`);
  }
  if (!response.body) throw new Error(`response has no body for ${url}`);
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
        throw new Error(`response exceeds ${maxBytes} byte budget for ${url}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function assertPng(payload: Buffer, card: FusionCardRow): void {
  const signature = "89504e470d0a1a0a";
  if (payload.length < 8 || payload.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`reference ${card.id} is not a PNG payload`);
  }
}

async function writeAtomically(path: string, payload: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.partial`;
  await writeFile(temporary, payload);
  await rename(temporary, path);
}

function createManifest(items: ManifestItem[]): RightsManifest {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    dataset_id: "thefusion21-pokemoncards-noncommercial-pilot-v1",
    created_at: now,
    description:
      "Local, bounded non-commercial retrieval experiment. No source image, model, or index may be committed or served from this manifest.",
    intended_use:
      "Local non-commercial visual-retrieval experiment only; no public model/index distribution and no commercial use.",
    sources: [
      {
        source_id: SOURCE_ID,
        provider: "TheFusion21/PokemonCards on Hugging Face",
        origin_url: DATASET_PAGE_URL,
        acquired_at: now,
        rights_holder: "TheFusion21 dataset-card declaration; upstream image rights holder unverified",
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
          "Rows reference https://images.pokemontcg.io. This manifest is an owner-approved local experiment record, not a public-release clearance.",
      },
    ],
    items,
  };
}

async function downloadCard(card: FusionCardRow, assetsDirectory: string, options: Options): Promise<ManifestItem> {
  const relativePath = fusionAssetPath(card);
  const destination = resolve(assetsDirectory, relativePath);
  let payload: Buffer;
  try {
    payload = await readFile(destination);
  } catch {
    payload = await fetchBounded(card.imageUrl, options.maxImageBytes, options.timeoutMs, [
      "images.pokemontcg.io",
    ]);
    await writeAtomically(destination, payload);
  }
  if (payload.length > options.maxImageBytes) {
    throw new Error(`reference ${card.id} exceeds ${options.maxImageBytes} byte budget`);
  }
  assertPng(payload, card);
  return {
    item_id: `fusion:${fusionCardKey(card)}`,
    card_uid: `tcg:${fusionCardKey(card)}`,
    relative_path: relativePath,
    sha256: createHash("sha256").update(payload).digest("hex"),
    source_id: SOURCE_ID,
    role: "reference",
    capture_group: "catalogue-reference",
    language: "en",
    set_id: card.setId,
    variant: "unknown",
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.acceptNoncommercialExperiment) usage();
  const csv = await fetchBounded(DATASET_CSV_URL, MAX_MANIFEST_BYTES, options.timeoutMs, [
    "huggingface.co",
  ]);
  const selected = parseFusionCardsCsv(csv.toString("utf8"), options.limit);
  if (selected.length !== options.limit) {
    throw new Error(`source has only ${selected.length} valid cards, below requested limit ${options.limit}`);
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ cards: selected.length, dataset: DATASET_PAGE_URL, mode: "dry-run" }, null, 2)}\n`,
    );
    return;
  }

  const assetsDirectory = resolve(options.outputDirectory, "assets");
  const manifestPath = resolve(options.outputDirectory, "rights-manifest.json");
  await mkdir(assetsDirectory, { recursive: true });
  const results: Array<ManifestItem | undefined> = new Array(selected.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= selected.length) return;
      results[index] = await downloadCard(selected[index]!, assetsDirectory, options);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  const manifest = createManifest(results.map((item) => item!));
  await writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        cards: manifest.items.length,
        manifest: manifestPath,
        mode: "local-noncommercial-experiment",
        next: "validate with train-noncommercial-experiment; public model publication remains blocked",
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`acquire-noncommercial-pilot: ${message}\n`);
  process.exitCode = 2;
});
