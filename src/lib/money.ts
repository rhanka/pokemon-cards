let supportedCurrencies: ReadonlySet<string> | null | undefined;

function currencySet(): ReadonlySet<string> | null {
  if (supportedCurrencies !== undefined) return supportedCurrencies;
  try {
    supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));
  } catch {
    // Older engines can still prove support by constructing a formatter.
    supportedCurrencies = null;
  }
  return supportedCurrencies;
}

export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const supported = currencySet();
  if (supported && !supported.has(currency)) return null;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency }).format(0);
    return currency;
  } catch {
    return null;
  }
}

export function isSupportedCurrency(value: unknown): value is string {
  return normalizeCurrency(value) !== null;
}

export function formatCurrencySafely(
  locale: string,
  amount: number,
  currency: string,
): string {
  if (!Number.isFinite(amount)) return "—";
  const normalized = normalizeCurrency(currency);
  if (normalized) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: normalized,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Fall through to a neutral, non-throwing representation.
    }
  }
  const numeric = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const label =
    typeof currency === "string" && currency.trim()
      ? currency.trim().toUpperCase()
      : "?";
  return `${numeric} ${label}`;
}
