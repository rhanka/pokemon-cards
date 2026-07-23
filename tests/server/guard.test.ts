import { describe, expect, it } from "vitest";

import { CatalogueRequestGuard } from "../../server/catalog/guard.js";

describe("request guard leases", () => {
  it("should refund client quota without releasing the upload slot or global quota", () => {
    const guard = new CatalogueRequestGuard({
      perClientPerMinute: 1,
      globalPerMinute: 2,
      maxConcurrent: 1,
      clock: () => 1_000,
    });

    const first = guard.enter("collector");
    expect(first.allowed).toBe(true);
    if (!first.allowed)
      throw new Error("Expected the first lease to be allowed");

    first.refundClientQuota();
    first.refundClientQuota();

    expect(guard.enter("other")).toMatchObject({
      allowed: false,
      reason: "concurrency",
    });

    first.release();
    const retried = guard.enter("collector");
    expect(retried.allowed).toBe(true);
    if (!retried.allowed)
      throw new Error("Expected refunded quota to be reusable");
    retried.release();

    expect(guard.enter("other")).toMatchObject({
      allowed: false,
      reason: "rate",
    });
  });
});
