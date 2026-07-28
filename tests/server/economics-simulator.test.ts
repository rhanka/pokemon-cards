import { describe, expect, it } from "vitest";

import {
  DEFAULT_ECONOMICS_INPUTS,
  simulateEconomics,
} from "../../scripts/economics-model.js";

describe("economics simulator", () => {
  it("should model one million cards with the measured scan CPU deterministically", () => {
    const first = simulateEconomics();
    const second = simulateEconomics();

    expect(second).toEqual(first);
    expect(first.onboarding.cards).toBe(1_000_000);
    expect(first.onboarding.recognitionCpuHours).toBeCloseTo(916.6667, 4);
    expect(first.onboarding.minimumDaysAtRequest).toBeCloseTo(1909.7222, 4);
    expect(first.onboarding.minimumDaysAtLimit).toBeCloseTo(127.3148, 4);
    expect(first.onboarding.averageMcpuForWindow).toBeCloseTo(424.3827, 4);
    expect(first.onboarding.fitsCpuRequestForWindow).toBe(false);
    expect(first.onboarding.fitsCpuLimitForWindow).toBe(false);
  });

  it("should keep steady base load below 20m and expose the active burst", () => {
    const report = simulateEconomics();
    const base = report.scenarios.find((scenario) => scenario.id === "base");
    const active = report.scenarios.find(
      (scenario) => scenario.id === "active",
    );

    expect(base).toBeDefined();
    expect(active).toBeDefined();
    expect(base?.monthlyScans).toBe(5_000);
    expect(base?.averageRecognitionMcpu).toBeCloseTo(6.3657, 4);
    expect(base?.peakExceedsCpuLimit).toBe(false);
    expect(active?.monthlyScans).toBe(24_000);
    expect(active?.averageRecognitionMcpu).toBeCloseTo(30.5556, 4);
    expect(active?.requestUtilizationRate).toBeCloseTo(1.5278, 4);
    expect(active?.peakRecognitionMcpu).toBeCloseTo(611.1111, 4);
    expect(active?.peakExceedsCpuLimit).toBe(true);
  });

  it("should calculate central normalized storage for every enrolled account", () => {
    const report = simulateEconomics();
    const base = report.scenarios.find((scenario) => scenario.id === "base");

    expect(base?.allAccountStorage.holdings).toBe(1_000_000);
    expect(base?.allAccountStorage.normalizedEventBytes).toBe(950_000_000);
    expect(base?.allAccountStorage.primaryGiB).toBeGreaterThan(1);
    expect(base?.monthlyOptimizedRequests).toBe(11_000);
    expect(base?.allocatedComputeCostUsd).toBeGreaterThan(0);
  });

  it("should model the pilot as free and non-commercial", () => {
    const { sustainability } = simulateEconomics();

    expect(sustainability.serviceModel).toBe("free-noncommercial");
    expect(sustainability.checkoutEnabled).toBe(false);
    expect(sustainability.sharedNodeFiveYearCostUsd).toBeCloseTo(2853.18, 8);
    expect(sustainability.requestedCpuFiveYearAttributionUsd).toBeCloseTo(
      31.702,
      3,
    );
  });

  it("should scale account-dependent load without duplicating the global refresh universe", () => {
    const thousand = simulateEconomics();
    const hundredThousand = simulateEconomics({ accounts: 100_000 });
    const baseAtThousand = thousand.scenarios.find(
      (scenario) => scenario.id === "base",
    );
    const baseAtHundredThousand = hundredThousand.scenarios.find(
      (scenario) => scenario.id === "base",
    );

    expect(baseAtHundredThousand?.monthlyScans).toBe(
      (baseAtThousand?.monthlyScans ?? 0) * 100,
    );
    expect(baseAtHundredThousand?.dailyGlobalRefreshCalls).toBe(
      baseAtThousand?.dailyGlobalRefreshCalls,
    );
    expect(baseAtHundredThousand?.allAccountStorage.holdings).toBe(100_000_000);
  });

  it("should reject an impossible CPU contract", () => {
    expect(() =>
      simulateEconomics({
        cpuRequestMcpu: DEFAULT_ECONOMICS_INPUTS.cpuLimitMcpu + 1,
      }),
    ).toThrow("cpuRequestMcpu must not exceed cpuLimitMcpu");
  });
});
