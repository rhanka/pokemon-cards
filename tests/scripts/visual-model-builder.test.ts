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
        "--export",
        "--index",
      ],
      "/repo",
    );
    const plan = createModelBuildPlan(options, { reference: 100 });

    expect(options.operation).toBe("train-noncommercial-experiment");
    expect(plan.benchmarkPreflight).toBe("not-requested");
    expect(plan.commands.map((command) => command.name)).toEqual([
      "validate-manifest",
      "train",
      "export",
      "build-index",
    ]);
    expect(plan.commands.flatMap((command) => command.args)).not.toContain("--release");
    expect(plan.commands[1]!.args).toContain("train-noncommercial-experiment");
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

    const options = parseModelBuildOptions(
      [
        "--acknowledge-experimental-model",
        "--manifest=manifest.json",
        "--assets=assets",
        "--benchmark",
      ],
      "/repo",
    );
    expect(createModelBuildPlan(options, { reference: 100 }).benchmarkPreflight).toBe(
      "missing-captures-or-unknowns",
    );
  });
});
