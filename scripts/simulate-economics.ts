import { simulateEconomics, type EconomicsReport } from "./economics-model.js";

function parsePositiveIntegerArgument(
  arguments_: string[],
  name: string,
): number | undefined {
  const prefix = `--${name}=`;
  const raw = arguments_.find((argument) => argument.startsWith(prefix));
  if (!raw) return undefined;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function renderReport(report: EconomicsReport): string {
  const { inputs, economics, onboarding } = report;
  const lines = [
    "CardScope — simulation économique déterministe",
    "",
    `Cohorte: ${inputs.accounts} comptes × ${inputs.cardsPerAccount} cartes = ${onboarding.cards} cartes`,
    `Cloud Pass: ${economics.paidAccounts} × $${fixed(inputs.passPriceUsd)} sur ${inputs.years} ans`,
    `CPU OCR mesuré: ${fixed(inputs.cpuSecondsPerScan)} CPU-s/scan; request ${inputs.cpuRequestMcpu}m; limit ${inputs.cpuLimitMcpu}m`,
    "",
    "Économie sur cinq ans",
    `  Revenu: $${fixed(economics.revenueUsd)}`,
    `  Paiements: $${fixed(economics.processorCostUsd)}`,
    `  Coût complet à +${inputs.maximumMarkupRate * 100}% maximum: $${fixed(economics.completeCostAtMarkupCeilingUsd)}`,
    `  Marge correspondante: $${fixed(economics.marginAtMarkupCeilingUsd)}`,
    `  Enveloppe infrastructure: $${fixed(economics.infrastructureBudgetUsd)}`,
    "",
    `Onboarding de ${onboarding.cards} scans`,
    `  CPU total: ${fixed(onboarding.recognitionCpuHours)} heures`,
    `  Débit garanti à ${inputs.cpuRequestMcpu}m: ${fixed(onboarding.guaranteedScansPerDay)} scans/jour (${fixed(onboarding.minimumDaysAtRequest)} jours)`,
    `  Débit au limit ${inputs.cpuLimitMcpu}m: ${fixed(onboarding.burstScansPerDay)} scans/jour (${fixed(onboarding.minimumDaysAtLimit)} jours)`,
    `  Sur ${inputs.onboardingWindowDays} jours: ${fixed(onboarding.averageMcpuForWindow)}m moyen; request=${onboarding.fitsCpuRequestForWindow ? "OK" : "DÉPASSÉE"}; limit=${onboarding.fitsCpuLimitForWindow ? "OK" : "DÉPASSÉE"}`,
    `  Ingress images à ${fixed(inputs.resizedImageBytes / 1024, 0)} KiB: ${fixed(onboarding.imageIngressGiB)} GiB`,
    "",
    "Scénarios mensuels",
  ];

  for (const scenario of report.scenarios) {
    lines.push(
      `  ${scenario.label}:`,
      `    MAU ${fixed(scenario.activeAccounts, 0)}; consultations ${fixed(scenario.monthlyConsultations, 0)}; scans ${fixed(scenario.monthlyScans, 0)}`,
      `    API optimisée ${fixed(scenario.monthlyOptimizedRequests, 0)} req (${fixed(scenario.averageOptimizedRps, 4)} RPS moyen)`,
      `    OCR ${fixed(scenario.averageRecognitionMcpu)}m moyen / ${fixed(scenario.peakRecognitionMcpu)}m pointe ×20; limit=${scenario.peakExceedsCpuLimit ? "DÉPASSÉE" : "OK"}`,
      `    Upstream ${fixed(scenario.monthlyUpstreamCalls, 0)}/mois, cache ${fixed(scenario.catalogueCacheHitRate * 100, 0)}%`,
      `    Stockage Cloud Pass ${fixed(scenario.paidStorage.primaryGiB)} GiB primaire / ${fixed(scenario.paidStorage.totalWithBackupsGiB)} GiB avec sauvegardes`,
      `    Stockage si 100% cloud ${fixed(scenario.allAccountStorage.primaryGiB)} GiB primaire`,
      `    Coût CPU partagé alloué $${fixed(scenario.allocatedComputeCostUsd)} / ${inputs.years} ans`,
      `    Plafond théorique stockage $${fixed(scenario.maximumBlendedStorageUsdPerGiBMonth, 3)}/GiB-mois avant egress/observabilité`,
    );
  }

  lines.push(
    "",
    "Le taux de stockage maximal est un plafond budgétaire, pas un tarif fournisseur.",
    "Les consultations utilisent un delta global; une requête par carte est le scénario naïf à éviter.",
  );
  return `${lines.join("\n")}\n`;
}

const arguments_ = process.argv.slice(2);
const accounts = parsePositiveIntegerArgument(arguments_, "accounts");
const cardsPerAccount = parsePositiveIntegerArgument(arguments_, "cards");
const report = simulateEconomics({
  ...(accounts ? { accounts } : {}),
  ...(cardsPerAccount ? { cardsPerAccount } : {}),
});

if (arguments_.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderReport(report));
}
