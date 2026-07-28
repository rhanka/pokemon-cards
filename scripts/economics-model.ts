const SECONDS_PER_DAY = 24 * 60 * 60;
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const BYTES_PER_MEBIBYTE = 1024 ** 2;
const BYTES_PER_GIBIBYTE = 1024 ** 3;

export type ScenarioId = "conservative" | "base" | "active";

export interface ScenarioAssumptions {
  id: ScenarioId;
  label: string;
  monthlyActiveRate: number;
  sessionsPerActiveAccount: number;
  consultationsPerSession: number;
  scansPerActiveAccount: number;
  catalogueCacheHitRate: number;
  annualHoldingMutationRate: number;
  peakFactor: number;
  uniqueHeldCards: number;
  dailyRefreshRate: number;
  weeklyRefreshRate: number;
  monthlyRefreshRate: number;
}

export interface EconomicsInputs {
  accounts: number;
  cardsPerAccount: number;
  years: number;
  cpuSecondsPerScan: number;
  cpuRequestMcpu: number;
  cpuLimitMcpu: number;
  nodeAllocatableMcpu: number;
  sharedNodeMonthlyEur: number;
  planningEurToUsd: number;
  resizedImageBytes: number;
  normalizedBytesPerHolding: number;
  normalizedBytesPerMutation: number;
  sharedCatalogueAndPriceBytes: number;
  primaryStorageHeadroomFactor: number;
  backupCopies: number;
  onboardingWindowDays: number;
}

export interface StorageProjection {
  holdings: number;
  mutationsOverRetention: number;
  normalizedEventBytes: number;
  primaryBytes: number;
  primaryGiB: number;
  totalWithBackupsBytes: number;
  totalWithBackupsGiB: number;
}

export interface ScenarioProjection {
  id: ScenarioId;
  label: string;
  activeAccounts: number;
  monthlySessions: number;
  monthlyConsultations: number;
  monthlyScans: number;
  monthlyCatalogueRequests: number;
  monthlyOptimizedRequests: number;
  monthlyNaiveRequests: number;
  averageOptimizedRps: number;
  averageNaiveRps: number;
  peakNaiveRps: number;
  catalogueCacheHitRate: number;
  monthlyQueryUpstreamCalls: number;
  dailyGlobalRefreshCalls: number;
  monthlyUpstreamCalls: number;
  monthlyImageIngressBytes: number;
  monthlyImageIngressGiB: number;
  monthlyRecognitionCpuSeconds: number;
  averageRecognitionMcpu: number;
  peakRecognitionMcpu: number;
  requestUtilizationRate: number;
  limitUtilizationRate: number;
  peakExceedsCpuLimit: boolean;
  allAccountStorage: StorageProjection;
  allocatedComputeCostUsd: number;
}

export interface SustainabilityProjection {
  serviceModel: "free-noncommercial";
  checkoutEnabled: false;
  sharedNodeFiveYearCostUsd: number;
  requestedCpuFiveYearAttributionUsd: number;
}

export interface OnboardingProjection {
  cards: number;
  recognitionCpuHours: number;
  guaranteedScansPerDay: number;
  burstScansPerDay: number;
  minimumDaysAtRequest: number;
  minimumDaysAtLimit: number;
  averageMcpuForWindow: number;
  fitsCpuRequestForWindow: boolean;
  fitsCpuLimitForWindow: boolean;
  imageIngressBytes: number;
  imageIngressGiB: number;
}

export interface EconomicsReport {
  inputs: EconomicsInputs;
  sustainability: SustainabilityProjection;
  onboarding: OnboardingProjection;
  scenarios: ScenarioProjection[];
}

export const DEFAULT_ECONOMICS_INPUTS: Readonly<EconomicsInputs> = {
  accounts: 1_000,
  cardsPerAccount: 1_000,
  years: 5,
  cpuSecondsPerScan: 3.3,
  cpuRequestMcpu: 20,
  cpuLimitMcpu: 300,
  nodeAllocatableMcpu: 1_800,
  sharedNodeMonthlyEur: 43.23,
  planningEurToUsd: 1.1,
  resizedImageBytes: 150 * 1024,
  normalizedBytesPerHolding: 700,
  normalizedBytesPerMutation: 500,
  // Shared catalogue/cache and compact global quote history planning reserve.
  sharedCatalogueAndPriceBytes: 256 * BYTES_PER_MEBIBYTE,
  primaryStorageHeadroomFactor: 1.25,
  backupCopies: 2,
  onboardingWindowDays: 90,
};

export const ECONOMICS_SCENARIOS: readonly ScenarioAssumptions[] = [
  {
    id: "conservative",
    label: "Conservateur",
    monthlyActiveRate: 0.2,
    sessionsPerActiveAccount: 2,
    consultationsPerSession: 5,
    scansPerActiveAccount: 2,
    catalogueCacheHitRate: 0.6,
    annualHoldingMutationRate: 0.02,
    peakFactor: 20,
    uniqueHeldCards: 10_000,
    dailyRefreshRate: 0.05,
    weeklyRefreshRate: 0.45,
    monthlyRefreshRate: 0.5,
  },
  {
    id: "base",
    label: "Base",
    monthlyActiveRate: 0.5,
    sessionsPerActiveAccount: 4,
    consultationsPerSession: 20,
    scansPerActiveAccount: 10,
    catalogueCacheHitRate: 0.8,
    annualHoldingMutationRate: 0.1,
    peakFactor: 20,
    uniqueHeldCards: 20_000,
    dailyRefreshRate: 0.1,
    weeklyRefreshRate: 0.6,
    monthlyRefreshRate: 0.3,
  },
  {
    id: "active",
    label: "Actif",
    monthlyActiveRate: 0.8,
    sessionsPerActiveAccount: 10,
    consultationsPerSession: 50,
    scansPerActiveAccount: 30,
    catalogueCacheHitRate: 0.9,
    annualHoldingMutationRate: 0.3,
    peakFactor: 20,
    uniqueHeldCards: 30_000,
    dailyRefreshRate: 0.2,
    weeklyRefreshRate: 0.7,
    monthlyRefreshRate: 0.1,
  },
] as const;

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function validateInputs(inputs: EconomicsInputs): void {
  for (const [name, value] of [
    ["accounts", inputs.accounts],
    ["cardsPerAccount", inputs.cardsPerAccount],
    ["years", inputs.years],
    ["cpuSecondsPerScan", inputs.cpuSecondsPerScan],
    ["cpuRequestMcpu", inputs.cpuRequestMcpu],
    ["cpuLimitMcpu", inputs.cpuLimitMcpu],
    ["nodeAllocatableMcpu", inputs.nodeAllocatableMcpu],
    ["sharedNodeMonthlyEur", inputs.sharedNodeMonthlyEur],
    ["planningEurToUsd", inputs.planningEurToUsd],
    ["resizedImageBytes", inputs.resizedImageBytes],
    ["normalizedBytesPerHolding", inputs.normalizedBytesPerHolding],
    ["normalizedBytesPerMutation", inputs.normalizedBytesPerMutation],
    ["primaryStorageHeadroomFactor", inputs.primaryStorageHeadroomFactor],
    ["onboardingWindowDays", inputs.onboardingWindowDays],
  ] as const) {
    requirePositive(name, value);
  }
  if (!Number.isSafeInteger(inputs.accounts)) {
    throw new Error("accounts must be a positive safe integer");
  }
  if (!Number.isSafeInteger(inputs.cardsPerAccount)) {
    throw new Error("cardsPerAccount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(inputs.backupCopies) || inputs.backupCopies < 0) {
    throw new Error("backupCopies must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(inputs.sharedCatalogueAndPriceBytes) ||
    inputs.sharedCatalogueAndPriceBytes < 0
  ) {
    throw new Error(
      "sharedCatalogueAndPriceBytes must be a non-negative safe integer",
    );
  }
  if (inputs.cpuRequestMcpu > inputs.cpuLimitMcpu) {
    throw new Error("cpuRequestMcpu must not exceed cpuLimitMcpu");
  }
  if (inputs.cpuLimitMcpu > inputs.nodeAllocatableMcpu) {
    throw new Error("cpuLimitMcpu must not exceed nodeAllocatableMcpu");
  }
}

function storageProjection(
  inputs: EconomicsInputs,
  holdings: number,
  annualMutationRate: number,
): StorageProjection {
  const mutationsOverRetention = Math.round(
    holdings * annualMutationRate * inputs.years,
  );
  const normalizedEventBytes =
    holdings * inputs.normalizedBytesPerHolding +
    mutationsOverRetention * inputs.normalizedBytesPerMutation;
  const primaryBytes = Math.ceil(
    (normalizedEventBytes + inputs.sharedCatalogueAndPriceBytes) *
      inputs.primaryStorageHeadroomFactor,
  );
  const totalWithBackupsBytes = primaryBytes * (1 + inputs.backupCopies);

  return {
    holdings,
    mutationsOverRetention,
    normalizedEventBytes,
    primaryBytes,
    primaryGiB: primaryBytes / BYTES_PER_GIBIBYTE,
    totalWithBackupsBytes,
    totalWithBackupsGiB: totalWithBackupsBytes / BYTES_PER_GIBIBYTE,
  };
}

function sustainabilityProjection(
  inputs: EconomicsInputs,
): SustainabilityProjection {
  const sharedNodeFiveYearCostUsd =
    inputs.sharedNodeMonthlyEur *
    inputs.planningEurToUsd *
    inputs.years *
    MONTHS_PER_YEAR;
  return {
    serviceModel: "free-noncommercial",
    checkoutEnabled: false,
    sharedNodeFiveYearCostUsd,
    requestedCpuFiveYearAttributionUsd:
      sharedNodeFiveYearCostUsd *
      (inputs.cpuRequestMcpu / inputs.nodeAllocatableMcpu),
  };
}

function globalRefreshesPerDay(scenario: ScenarioAssumptions): number {
  return (
    scenario.uniqueHeldCards * scenario.dailyRefreshRate +
    (scenario.uniqueHeldCards * scenario.weeklyRefreshRate) / 7 +
    (scenario.uniqueHeldCards * scenario.monthlyRefreshRate) / 30
  );
}

function scenarioProjection(
  inputs: EconomicsInputs,
  scenario: ScenarioAssumptions,
): ScenarioProjection {
  const secondsPerMonth = DAYS_PER_MONTH * SECONDS_PER_DAY;
  const activeAccounts = inputs.accounts * scenario.monthlyActiveRate;
  const monthlySessions = activeAccounts * scenario.sessionsPerActiveAccount;
  const monthlyConsultations =
    monthlySessions * scenario.consultationsPerSession;
  const monthlyScans = activeAccounts * scenario.scansPerActiveAccount;
  const monthlyCatalogueRequests = monthlyScans * 2;
  const monthlySyncRequests = monthlySessions;
  // One bootstrap/config request and one compact price delta per session.
  const monthlyOptimizedRequests =
    monthlyScans + monthlySessions * 2 + monthlySyncRequests;
  const monthlyNaiveRequests = monthlyOptimizedRequests + monthlyConsultations;
  const averageOptimizedRps = monthlyOptimizedRequests / secondsPerMonth;
  const averageNaiveRps = monthlyNaiveRequests / secondsPerMonth;
  const monthlyQueryUpstreamCalls =
    monthlyCatalogueRequests * (1 - scenario.catalogueCacheHitRate);
  const dailyGlobalRefreshCalls = globalRefreshesPerDay(scenario);
  const monthlyUpstreamCalls =
    monthlyQueryUpstreamCalls + dailyGlobalRefreshCalls * DAYS_PER_MONTH;
  const monthlyRecognitionCpuSeconds = monthlyScans * inputs.cpuSecondsPerScan;
  const averageRecognitionMcpu =
    (monthlyRecognitionCpuSeconds / secondsPerMonth) * 1_000;
  const peakRecognitionMcpu = averageRecognitionMcpu * scenario.peakFactor;
  const allAccountStorage = storageProjection(
    inputs,
    inputs.accounts * inputs.cardsPerAccount,
    scenario.annualHoldingMutationRate,
  );
  const allocatedMcpu = Math.max(inputs.cpuRequestMcpu, averageRecognitionMcpu);
  const allocatedComputeCostUsd =
    inputs.sharedNodeMonthlyEur *
    inputs.planningEurToUsd *
    (allocatedMcpu / inputs.nodeAllocatableMcpu) *
    inputs.years *
    MONTHS_PER_YEAR;
  return {
    id: scenario.id,
    label: scenario.label,
    activeAccounts,
    monthlySessions,
    monthlyConsultations,
    monthlyScans,
    monthlyCatalogueRequests,
    monthlyOptimizedRequests,
    monthlyNaiveRequests,
    averageOptimizedRps,
    averageNaiveRps,
    peakNaiveRps: averageNaiveRps * scenario.peakFactor,
    catalogueCacheHitRate: scenario.catalogueCacheHitRate,
    monthlyQueryUpstreamCalls,
    dailyGlobalRefreshCalls,
    monthlyUpstreamCalls,
    monthlyImageIngressBytes: monthlyScans * inputs.resizedImageBytes,
    monthlyImageIngressGiB:
      (monthlyScans * inputs.resizedImageBytes) / BYTES_PER_GIBIBYTE,
    monthlyRecognitionCpuSeconds,
    averageRecognitionMcpu,
    peakRecognitionMcpu,
    requestUtilizationRate: averageRecognitionMcpu / inputs.cpuRequestMcpu,
    limitUtilizationRate: averageRecognitionMcpu / inputs.cpuLimitMcpu,
    peakExceedsCpuLimit: peakRecognitionMcpu > inputs.cpuLimitMcpu,
    allAccountStorage,
    allocatedComputeCostUsd,
  };
}

function onboardingProjection(inputs: EconomicsInputs): OnboardingProjection {
  const cards = inputs.accounts * inputs.cardsPerAccount;
  const recognitionCpuSeconds = cards * inputs.cpuSecondsPerScan;
  const requestCores = inputs.cpuRequestMcpu / 1_000;
  const limitCores = inputs.cpuLimitMcpu / 1_000;
  const guaranteedScansPerDay =
    (requestCores * SECONDS_PER_DAY) / inputs.cpuSecondsPerScan;
  const burstScansPerDay =
    (limitCores * SECONDS_PER_DAY) / inputs.cpuSecondsPerScan;
  const averageMcpuForWindow =
    (recognitionCpuSeconds / (inputs.onboardingWindowDays * SECONDS_PER_DAY)) *
    1_000;

  return {
    cards,
    recognitionCpuHours: recognitionCpuSeconds / (60 * 60),
    guaranteedScansPerDay,
    burstScansPerDay,
    minimumDaysAtRequest: cards / guaranteedScansPerDay,
    minimumDaysAtLimit: cards / burstScansPerDay,
    averageMcpuForWindow,
    fitsCpuRequestForWindow: averageMcpuForWindow <= inputs.cpuRequestMcpu,
    fitsCpuLimitForWindow: averageMcpuForWindow <= inputs.cpuLimitMcpu,
    imageIngressBytes: cards * inputs.resizedImageBytes,
    imageIngressGiB: (cards * inputs.resizedImageBytes) / BYTES_PER_GIBIBYTE,
  };
}

export function simulateEconomics(
  overrides: Partial<EconomicsInputs> = {},
): EconomicsReport {
  const inputs = { ...DEFAULT_ECONOMICS_INPUTS, ...overrides };
  validateInputs(inputs);

  return {
    inputs,
    sustainability: sustainabilityProjection(inputs),
    onboarding: onboardingProjection(inputs),
    scenarios: ECONOMICS_SCENARIOS.map((scenario) =>
      scenarioProjection(inputs, scenario),
    ),
  };
}
