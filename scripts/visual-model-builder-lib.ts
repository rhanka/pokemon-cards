import { resolve } from "node:path";

export const EXPERIMENTAL_OPERATION = "train-noncommercial-experiment";

export interface ModelBuildOptions {
  acknowledgeExperimentalModel: boolean;
  assets: string;
  benchmark: boolean;
  calibrationSamples: number;
  device: string;
  epochs: number;
  exportOnnx: boolean;
  freezeBackboneEpochs: number;
  index: boolean;
  manifest: string;
  operation: "train" | typeof EXPERIMENTAL_OPERATION;
  output: string;
  pretrainedBackbone: boolean;
  python: string;
  resumeCheckpoint: string | null;
  seed: number;
  syntheticHoldout: boolean;
  syntheticVariants: number;
  workers: number;
}

export interface ModelBuildPlan {
  commands: Array<{ name: string; args: string[] }>;
  benchmarkPreflight:
    "not-requested" | "ready" | "missing-captures-or-unknowns";
}

function usage(): never {
  throw new Error(
    [
      "Usage: npm run build:visual-model -- --acknowledge-experimental-model --manifest=<rights-manifest.json> --assets=<assets> [options]",
      "Options: --output=<ignored directory> --epochs=<1..200> --seed=<integer> --device=<auto|cpu|cuda>",
      "         --operation=<train|train-noncommercial-experiment> --python=<executable> --workers=<0..32>",
      "         --pretrained-backbone --freeze-backbone-epochs=<0..200> --resume-checkpoint=<model.last.pt>",
      "         --export --index --benchmark --synthetic-holdout --synthetic-variants=<1..8> --calibration-samples=<1..4096>",
      "This runner never accepts --release and never deploys or publishes an artifact.",
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

function parseSeed(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2 ** 31 - 1) {
    throw new Error("--seed must be a non-negative 32-bit integer");
  }
  return parsed;
}

function parseWorkers(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 32) {
    throw new Error("--workers must be an integer between 0 and 32");
  }
  return parsed;
}

export function parseModelBuildOptions(
  arguments_: string[],
  cwd = process.cwd(),
): ModelBuildOptions {
  const values = new Map<string, string>();
  let acknowledgeExperimentalModel = false;
  let benchmark = false;
  let exportOnnx = false;
  let index = false;
  let pretrainedBackbone = false;
  let syntheticHoldout = false;
  for (const argument of arguments_) {
    if (argument === "--acknowledge-experimental-model")
      acknowledgeExperimentalModel = true;
    else if (argument === "--benchmark") benchmark = true;
    else if (argument === "--export") exportOnnx = true;
    else if (argument === "--index") index = true;
    else if (argument === "--synthetic-holdout") syntheticHoldout = true;
    else if (argument === "--pretrained-backbone") pretrainedBackbone = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [key, value] = argument.slice(2).split("=", 2) as [string, string];
      values.set(key, value);
    } else usage();
  }
  const known = new Set([
    "assets",
    "calibration-samples",
    "device",
    "epochs",
    "freeze-backbone-epochs",
    "manifest",
    "operation",
    "output",
    "python",
    "resume-checkpoint",
    "seed",
    "synthetic-variants",
    "workers",
  ]);
  if (
    !acknowledgeExperimentalModel ||
    !values.has("manifest") ||
    !values.has("assets")
  )
    usage();
  for (const key of values.keys()) if (!known.has(key)) usage();
  if (index && !exportOnnx) throw new Error("--index requires --export");
  if (syntheticHoldout && !index)
    throw new Error("--synthetic-holdout requires --index");
  if (values.has("synthetic-variants") && !syntheticHoldout)
    throw new Error("--synthetic-variants requires --synthetic-holdout");

  const operation = values.get("operation") ?? EXPERIMENTAL_OPERATION;
  if (operation !== "train" && operation !== EXPERIMENTAL_OPERATION) {
    throw new Error(
      "--operation must be train or train-noncommercial-experiment",
    );
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const epochs = parsePositiveInteger(
    values.get("epochs") ?? "20",
    "--epochs",
    200,
  );
  const freezeBackboneEpochs = Number(
    values.get("freeze-backbone-epochs") ?? "0",
  );
  if (
    !Number.isSafeInteger(freezeBackboneEpochs) ||
    freezeBackboneEpochs < 0 ||
    freezeBackboneEpochs > epochs
  ) {
    throw new Error(
      "--freeze-backbone-epochs must be an integer between 0 and --epochs",
    );
  }
  if (freezeBackboneEpochs > 0 && !pretrainedBackbone) {
    throw new Error("--freeze-backbone-epochs requires --pretrained-backbone");
  }
  return {
    acknowledgeExperimentalModel,
    assets: resolve(cwd, values.get("assets")!),
    benchmark,
    calibrationSamples: parsePositiveInteger(
      values.get("calibration-samples") ?? "128",
      "--calibration-samples",
      4096,
    ),
    device: values.get("device") ?? "auto",
    epochs,
    exportOnnx,
    freezeBackboneEpochs,
    index,
    manifest: resolve(cwd, values.get("manifest")!),
    operation,
    output: resolve(
      cwd,
      values.get("output") ?? `ml/artifacts/visual-model-${timestamp}`,
    ),
    pretrainedBackbone,
    python: values.get("python") ?? "python3",
    resumeCheckpoint: values.has("resume-checkpoint")
      ? resolve(cwd, values.get("resume-checkpoint")!)
      : null,
    seed: parseSeed(values.get("seed") ?? "20260722"),
    syntheticHoldout,
    syntheticVariants: parsePositiveInteger(
      values.get("synthetic-variants") ?? "1",
      "--synthetic-variants",
      8,
    ),
    workers: parseWorkers(values.get("workers")),
  };
}

export function createModelBuildPlan(
  options: ModelBuildOptions,
  roleCounts: Readonly<Record<string, number>>,
): ModelBuildPlan {
  const commands: Array<{ name: string; args: string[] }> = [
    {
      name: "validate-manifest",
      args: [
        "-m",
        "cardscope_ml",
        "validate-manifest",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--operation",
        options.operation,
      ],
    },
    {
      name: "train",
      args: [
        "-m",
        "cardscope_ml",
        "train",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--output-dir",
        options.output,
        "--seed",
        String(options.seed),
        "--epochs",
        String(options.epochs),
        "--device",
        options.device,
        "--workers",
        String(options.workers),
        "--freeze-backbone-epochs",
        String(options.freezeBackboneEpochs),
        "--operation",
        options.operation,
      ],
    },
  ];
  if (options.pretrainedBackbone) {
    commands[1]!.args.push("--pretrained-backbone");
  }
  if (options.resumeCheckpoint) {
    commands[1]!.args.push("--resume-checkpoint", options.resumeCheckpoint);
  }
  const canBenchmark =
    (roleCounts.capture ?? 0) > 0 && (roleCounts.unknown ?? 0) > 0;
  if (options.benchmark && !canBenchmark) {
    return { commands, benchmarkPreflight: "missing-captures-or-unknowns" };
  }
  if (options.benchmark) {
    commands.push({
      name: "benchmark",
      args: [
        "-m",
        "cardscope_ml",
        "benchmark",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--checkpoint",
        resolve(options.output, "model.pt"),
        "--output",
        resolve(options.output, "benchmark.json"),
        "--device",
        options.device === "auto" ? "cpu" : options.device,
        "--operation",
        options.operation,
      ],
    });
  }
  if (options.exportOnnx) {
    commands.push({
      name: "export",
      args: [
        "-m",
        "cardscope_ml",
        "export",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--checkpoint",
        resolve(options.output, "model.pt"),
        "--output-dir",
        resolve(options.output, "export"),
        "--calibration-samples",
        String(options.calibrationSamples),
        "--operation",
        options.operation,
      ],
    });
  }
  if (options.index) {
    commands.push({
      name: "build-index",
      args: [
        "-m",
        "cardscope_ml",
        "build-index",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--model",
        resolve(options.output, "export", "model.float.onnx"),
        "--output-dir",
        resolve(options.output, "index"),
        "--operation",
        options.operation,
      ],
    });
    commands.push({
      name: "verify-artifacts",
      args: [
        "-m",
        "cardscope_ml",
        "verify-artifacts",
        "--manifest",
        options.manifest,
        "--asset-root",
        options.assets,
        "--checkpoint",
        resolve(options.output, "model.pt"),
        "--model",
        resolve(options.output, "export", "model.float.onnx"),
        "--index",
        resolve(options.output, "index", "reference-index.json"),
        "--output",
        resolve(options.output, "reference-smoke.json"),
        "--seed",
        String(options.seed),
        "--operation",
        options.operation,
      ],
    });
    if (options.syntheticHoldout) {
      commands.push({
        name: "synthetic-holdout",
        args: [
          "-m",
          "cardscope_ml",
          "synthetic-holdout",
          "--manifest",
          options.manifest,
          "--asset-root",
          options.assets,
          "--checkpoint",
          resolve(options.output, "model.pt"),
          "--model",
          resolve(options.output, "export", "model.float.onnx"),
          "--index",
          resolve(options.output, "index", "reference-index.json"),
          "--output",
          resolve(options.output, "synthetic-holdout.json"),
          "--seed",
          String(options.seed),
          "--variants-per-reference",
          String(options.syntheticVariants),
          "--operation",
          options.operation,
        ],
      });
    }
  }
  return {
    commands,
    benchmarkPreflight: options.benchmark ? "ready" : "not-requested",
  };
}
