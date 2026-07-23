import type {
  CardCondition,
  CardFinish,
  CollectionTotals,
  CurrencyTotal,
  Holding,
  Locale,
  PriceQuote,
  ReviewItem,
  ValuationPreference,
} from "./types";
import { normalizeCurrency } from "./money";

const VALUATION_PREFERENCE_KEY = "cardscope-valuation-preference-v1";
export const DEFAULT_VALUATION_PREFERENCE: ValuationPreference = {
  market: "tcgplayer",
  currency: "USD",
};

function preferenceStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalizePreference(value: unknown): ValuationPreference | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ValuationPreference>;
  const market =
    typeof raw.market === "string" ? raw.market.trim().toLowerCase() : "";
  const currency = normalizeCurrency(raw.currency);
  if (!market || market.length > 80 || !currency) return null;
  return { market, currency };
}

export function loadValuationPreference(
  storage = preferenceStorage(),
): ValuationPreference {
  if (!storage) return DEFAULT_VALUATION_PREFERENCE;
  try {
    return (
      normalizePreference(
        JSON.parse(storage.getItem(VALUATION_PREFERENCE_KEY) ?? "null"),
      ) ?? DEFAULT_VALUATION_PREFERENCE
    );
  } catch {
    return DEFAULT_VALUATION_PREFERENCE;
  }
}

export function saveValuationPreference(
  preference: ValuationPreference,
  storage = preferenceStorage(),
): ValuationPreference {
  const normalized = normalizePreference(preference);
  if (!normalized) throw new Error("Invalid valuation preference");
  try {
    storage?.setItem(VALUATION_PREFERENCE_KEY, JSON.stringify(normalized));
  } catch {
    // The in-memory preference remains usable when private storage is unavailable.
  }
  return normalized;
}

export function selectPriceQuote(
  quotes: PriceQuote[],
  locale: Locale,
  finish: CardFinish = "normal",
  condition?: CardCondition,
  preference = loadValuationPreference(),
): PriceQuote | undefined {
  void locale;
  const matchingFinish = quotes.filter((quote) => {
    const finishMatches =
      finish === "normal"
        ? quote.finish === "normal" || quote.finish === undefined
        : quote.finish === finish;
    if (!finishMatches) return false;
    return (
      !condition ||
      quote.condition === condition ||
      !quote.condition ||
      quote.conditionIncluded === false
    );
  });
  return matchingFinish.sort((left, right) => {
    const marketScore = (quote: PriceQuote) => {
      if (
        quote.market.toLowerCase() === preference.market &&
        quote.currency === preference.currency
      )
        return 5;
      if (quote.market.toLowerCase() === preference.market) return 3;
      if (quote.currency === preference.currency) return 2;
      return 1;
    };
    const conditionScore = (quote: PriceQuote) =>
      condition && quote.condition === condition ? 2 : 1;
    return (
      conditionScore(right) - conditionScore(left) ||
      marketScore(right) - marketScore(left) ||
      Date.parse(right.observedAt) - Date.parse(left.observedAt)
    );
  })[0];
}

export function quoteIsStale(quote: PriceQuote, now = new Date()): boolean {
  return (
    Number.isNaN(Date.parse(quote.staleAfter)) ||
    Date.parse(quote.staleAfter) <= now.getTime()
  );
}

export function quoteAgeInDays(quote: PriceQuote, now = new Date()): number {
  const observed = Date.parse(quote.observedAt);
  if (Number.isNaN(observed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - observed) / 86_400_000));
}

export function holdingMarketValue(holding: Holding): number | null {
  const unitValue = holding.quote?.marketPrice ?? holding.quote?.low;
  return unitValue === null || unitValue === undefined
    ? null
    : unitValue * holding.quantity;
}

export function holdingRange(holding: Holding): {
  low: number | null;
  market: number | null;
  high: number | null;
} {
  const quote = holding.quote;
  return {
    low:
      quote?.low === null || quote?.low === undefined
        ? null
        : quote.low * holding.quantity,
    market: holdingMarketValue(holding),
    high:
      quote?.high === null || quote?.high === undefined
        ? null
        : quote.high * holding.quantity,
  };
}

export function holdingCost(holding: Holding): number | null {
  return holding.unitCost ? holding.unitCost.amount * holding.quantity : null;
}

export function buildReviewQueue(
  holdings: Holding[],
  now = new Date(),
): ReviewItem[] {
  return holdings
    .map((holding): ReviewItem | null => {
      const reasons: ReviewItem["reasons"] = [];
      if (!holding.quote) reasons.push("missing-price");
      else {
        if (quoteIsStale(holding.quote, now)) reasons.push("stale-price");
        if (holding.quote.liquidity === "low") reasons.push("low-liquidity");
        if (!holding.quote.liquidity || holding.quote.liquidity === "unknown")
          reasons.push("unknown-liquidity");
      }
      if (!holding.unitCost) reasons.push("missing-cost");
      if (!reasons.length) return null;
      const value = holdingMarketValue(holding) ?? 0;
      const priority =
        value +
        (reasons.includes("missing-price") ? 100 : 0) +
        (reasons.includes("stale-price") ? 50 : 0) +
        (reasons.includes("low-liquidity") ? 20 : 0) +
        (reasons.includes("unknown-liquidity") ? 10 : 0);
      return { holding, reasons, priority };
    })
    .filter((item): item is ReviewItem => item !== null)
    .sort((left, right) => right.priority - left.priority);
}

type MutableCurrencyTotal = {
  low: number;
  market: number;
  high: number;
  cost: number;
  hasLow: boolean;
  hasMarket: boolean;
  hasHigh: boolean;
  hasCost: boolean;
  lowComplete: boolean;
  marketComplete: boolean;
  highComplete: boolean;
  marketHoldingIds: Set<string>;
  costHoldingIds: Set<string>;
};

function currencyBucket(
  buckets: Map<string, MutableCurrencyTotal>,
  currency: string,
): MutableCurrencyTotal {
  const normalized = currency.trim().toUpperCase();
  const existing = buckets.get(normalized);
  if (existing) return existing;
  const created: MutableCurrencyTotal = {
    low: 0,
    market: 0,
    high: 0,
    cost: 0,
    hasLow: false,
    hasMarket: false,
    hasHigh: false,
    hasCost: false,
    lowComplete: true,
    marketComplete: true,
    highComplete: true,
    marketHoldingIds: new Set(),
    costHoldingIds: new Set(),
  };
  buckets.set(normalized, created);
  return created;
}

export function collectionTotals(holdings: Holding[]): CollectionTotals {
  const buckets = new Map<string, MutableCurrencyTotal>();
  let cards = 0;

  for (const holding of holdings) {
    cards += holding.quantity;
    if (holding.quote?.currency) {
      const bucket = currencyBucket(buckets, holding.quote.currency);
      bucket.marketHoldingIds.add(holding.id);
      const range = holdingRange(holding);
      if (range.low === null) bucket.lowComplete = false;
      else {
        bucket.low += range.low;
        bucket.hasLow = true;
      }
      if (range.market === null) bucket.marketComplete = false;
      else {
        bucket.market += range.market;
        bucket.hasMarket = true;
      }
      if (range.high === null) bucket.highComplete = false;
      else {
        bucket.high += range.high;
        bucket.hasHigh = true;
      }
    }
    if (holding.unitCost?.currency) {
      const bucket = currencyBucket(buckets, holding.unitCost.currency);
      bucket.costHoldingIds.add(holding.id);
      bucket.cost += holding.unitCost.amount * holding.quantity;
      bucket.hasCost = true;
    }
  }

  const currencies: CurrencyTotal[] = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => {
      const low = value.hasLow && value.lowComplete ? value.low : null;
      const market =
        value.hasMarket && value.marketComplete ? value.market : null;
      const high = value.hasHigh && value.highComplete ? value.high : null;
      const cost = value.hasCost ? value.cost : null;
      const costCoverage = !value.hasCost
        ? "none"
        : value.marketHoldingIds.size === value.costHoldingIds.size &&
            [...value.marketHoldingIds].every((id) =>
              value.costHoldingIds.has(id),
            )
          ? "complete"
          : "partial";
      return {
        currency,
        low,
        market,
        high,
        cost,
        costCoverage,
        net:
          market !== null && cost !== null && costCoverage === "complete"
            ? market - cost
            : null,
      };
    });

  return { cards, unique: holdings.length, currencies };
}
