import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";

import {
  createModelBuildPlan,
  parseModelBuildOptions,
} from "./visual-model-builder-lib.js";

interface ManifestItem {
  role: string;
}

interface RightsManifest {
  fingerprint?: string;
  items: ManifestItem[];
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function roleCounts(manifest: RightsManifest): Record<string, number> {
  return manifest.items.reduce<Record<string, number>>((counts, item) => {
    counts[item.role] = (counts[item.role] ?? 0) + 1;
    return counts;
  }, {});
}

async function run(python: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(python, args, {
      env: {
        ...process.env,
        PYTHONPATH: [resolve("ml"), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter),
      },
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `Python command failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
          ),
        );
    });
  });
}

async function writeBuildManifest(
  path: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<void> {
  const options = parseModelBuildOptions(process.argv.slice(2));
  await access(options.manifest);
  await access(options.assets);
  const rawManifest = await readFile(options.manifest, "utf8");
  const manifest = JSON.parse(rawManifest) as RightsManifest;
  if (!Array.isArray(manifest.items))
    throw new Error("rights manifest does not contain an items array");
  const counts = roleCounts(manifest);
  const plan = createModelBuildPlan(options, counts);
  if (plan.benchmarkPreflight === "missing-captures-or-unknowns") {
    throw new Error(
      "--benchmark needs independent capture and unknown items in the manifest; reference images alone can train but cannot demonstrate camera recognition",
    );
  }

  await mkdir(options.output, { recursive: true });
  const manifestPath = resolve(options.output, "build-manifest.json");
  const startedAt = new Date().toISOString();
  const buildManifest = {
    schema_version: 1,
    started_at: startedAt,
    completed_at: null as string | null,
    status: "running",
    local_only: options.operation === "train-noncommercial-experiment",
    source_manifest: options.manifest,
    source_manifest_sha256: createHash("sha256")
      .update(rawManifest)
      .digest("hex"),
    assets: options.assets,
    role_counts: counts,
    benchmark_preflight: plan.benchmarkPreflight,
    assessment: {
      deployment_eligible: false,
      reasons:
        (counts.capture ?? 0) > 0 && (counts.unknown ?? 0) > 0
          ? ["A benchmark remains required before any deployment decision."]
          : [
              "Reference images alone can build a technical baseline but cannot demonstrate camera recognition.",
              "Independent capture and unknown-card probes are required before deployment.",
            ],
    },
    commands: plan.commands.map((command) => [options.python, ...command.args]),
    outputs: {} as Record<string, string>,
  };
  try {
    await writeBuildManifest(manifestPath, buildManifest);
    for (const command of plan.commands) {
      process.stdout.write(`\n[visual-model-builder] ${command.name}\n`);
      await run(options.python, command.args);
    }

    const outputs: Record<string, string> = {};
    for (const [name, path] of Object.entries({
      checkpoint: resolve(options.output, "model.pt"),
      training_metadata: resolve(options.output, "training-metadata.json"),
      export_metadata: resolve(
        options.output,
        "export",
        "export-metadata.json",
      ),
      index_metadata: resolve(options.output, "index", "reference-index.json"),
      benchmark: resolve(options.output, "benchmark.json"),
      reference_smoke: resolve(options.output, "reference-smoke.json"),
    })) {
      try {
        outputs[name] = await sha256(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await writeBuildManifest(manifestPath, {
      ...buildManifest,
      completed_at: new Date().toISOString(),
      status: "completed",
      outputs,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          output: options.output,
          build_manifest: manifestPath,
          benchmark: plan.benchmarkPreflight,
          local_only: buildManifest.local_only,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    await writeBuildManifest(manifestPath, {
      ...buildManifest,
      completed_at: new Date().toISOString(),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`build-visual-model: ${message}\n`);
  process.exitCode = 2;
});
