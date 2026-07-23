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

  it("should calculate paid and all-account normalized storage separately", () => {
    const report = simulateEconomics();
    const base = report.scenarios.find((scenario) => scenario.id === "base");

    expect(report.economics.paidAccounts).toBe(300);
    expect(base?.paidStorage.holdings).toBe(300_000);
    expect(base?.paidStorage.mutationsOverRetention).toBe(150_000);
    expect(base?.paidStorage.normalizedEventBytes).toBe(285_000_000);
    expect(base?.allAccountStorage.holdings).toBe(1_000_000);
    expect(base?.allAccountStorage.normalizedEventBytes).toBe(950_000_000);
    expect(base?.paidStorage.primaryGiB).toBeLessThan(1);
    expect(base?.allAccountStorage.primaryGiB).toBeGreaterThan(1);
    expect(base?.monthlyOptimizedRequests).toBe(11_000);
    expect(base?.maximumBlendedStorageUsdPerGiBMonth).toBeLessThan(1);
  });

  it("should preserve the five-year price and maximum-markup guardrail", () => {
    const { economics } = simulateEconomics();

    expect(economics.revenueUsd).toBeCloseTo(1_497, 8);
    expect(economics.processorCostUsd).toBeCloseTo(133.413, 3);
    expect(economics.completeCostAtMarkupCeilingUsd).toBeCloseTo(998, 8);
    expect(economics.marginAtMarkupCeilingUsd).toBeCloseTo(499, 8);
    expect(economics.infrastructureBudgetUsd).toBe(180);
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
    expect(baseAtHundredThousand?.paidStorage.holdings).toBe(30_000_000);
  });

  it("should reject an impossible CPU contract", () => {
    expect(() =>
      simulateEconomics({
        cpuRequestMcpu: DEFAULT_ECONOMICS_INPUTS.cpuLimitMcpu + 1,
      }),
    ).toThrow("cpuRequestMcpu must not exceed cpuLimitMcpu");
  });
});
