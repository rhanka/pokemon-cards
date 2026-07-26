import { describe, expect, it } from "vitest";

import {
  createModelBuildPlan,
  parseModelBuildOptions,
} from "../../scripts/visual-model-builder-lib.js";

describe("visual model builder", () => {
  it("uses the experimental operation and never creates a release command by default", () => {
    const options = parseModelBuildOptions(
      [
        "--acknowledge-experimental-model",
        "--manifest=ml/data/demo/rights-manifest.json",
        "--assets=ml/data/demo/assets",
        "--output=/tmp/cardscope-model",
        "--workers=4",
        "--resume-checkpoint=ml/artifacts/previous/model.last.pt",
        "--export",
        "--index",
      ],
      "/repo",
    );
    const plan = createModelBuildPlan(options, { reference: 100 });

    expect(options.operation).toBe("train-noncommercial-experiment");
    expect(options.workers).toBe(4);
    expect(options.resumeCheckpoint).toBe(
      "/repo/ml/artifacts/previous/model.last.pt",
    );
    expect(plan.benchmarkPreflight).toBe("not-requested");
    expect(plan.commands.map((command) => command.name)).toEqual([
      "validate-manifest",
      "train",
      "export",
      "build-index",
      "verify-artifacts",
    ]);
    expect(plan.commands.flatMap((command) => command.args)).not.toContain(
      "--release",
    );
    expect(plan.commands[1]!.args).toContain("train-noncommercial-experiment");
    expect(plan.commands[1]!.args).toContain("--resume-checkpoint");
  });

  it("rejects an index without an export and preflights a reference-only benchmark", () => {
    expect(() =>
      parseModelBuildOptions(
        [
          "--acknowledge-experimental-model",
          "--manifest=manifest.json",
          "--assets=assets",
          "--index",
        ],
        "/repo",
      ),
    ).toThrow("--index requires --export");

    expect(() =>
      parseModelBuildOptions(
        [
          "--acknowledge-experimental-model",
          "--manifest=manifest.json",
          "--assets=assets",
          "--workers=33",
        ],
        "/repo",
      ),
    ).toThrow("--workers must be an integer between 0 and 32");

    const options = parseModelBuildOptions(
      [
        "--acknowledge-experimental-model",
        "--manifest=manifest.json",
        "--assets=assets",
        "--benchmark",
      ],
      "/repo",
    );
    expect(
      createModelBuildPlan(options, { reference: 100 }).benchmarkPreflight,
    ).toBe("missing-captures-or-unknowns");
  });
});
