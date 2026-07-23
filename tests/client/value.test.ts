import { afterEach, describe, expect, it } from "vitest";
import type { Holding, PriceQuote } from "../../src/lib/types";
import {
  buildReviewQueue,
  collectionTotals,
  holdingMarketValue,
  loadValuationPreference,
  saveValuationPreference,
  selectPriceQuote,
} from "../../src/lib/value";

afterEach(() => localStorage.clear());

function quote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    source: "catalogue-test",
    market: "test-market",
    currency: "USD",
    finish: "normal",
    low: 8,
    marketPrice: 10,
    high: 12,
    liquidity: "high",
    observedAt: "2026-07-20T00:00:00.000Z",
    staleAfter: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function holding(
  id: string,
  price: PriceQuote | undefined,
  overrides: Partial<Holding> = {},
): Holding {
  return {
    id,
    cardId: id,
    card: {
      id,
      name: `Card ${id}`,
      quote: price,
      quotes: price ? [price] : [],
    },
    quantity: 1,
    finish: "normal",
    condition: "near-mint",
    quote: price,
    addedAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("transparent collection valuation", () => {
  it("should expose separate USD and EUR totals without ever adding unlike currencies", () => {
    const usd = holding("usd", quote(), {
      unitCost: { amount: 3, currency: "EUR" },
    });
    const eur = holding(
      "eur",
      quote({ currency: "EUR", low: 18, marketPrice: 20, high: 25 }),
      { unitCost: { amount: 4, currency: "USD" } },
    );

    expect(collectionTotals([usd, eur])).toEqual({
      cards: 2,
      unique: 2,
      currencies: [
        {
          currency: "EUR",
          low: 18,
          market: 20,
          high: 25,
          cost: 3,
          costCoverage: "partial",
          net: null,
        },
        {
          currency: "USD",
          low: 8,
          market: 10,
          high: 12,
          cost: 4,
          costCoverage: "partial",
          net: null,
        },
      ],
    });
  });

  it("should keep unavailable bounds and market values null instead of presenting zero", () => {
    const incomplete = holding(
      "incomplete",
      quote({ low: null, marketPrice: null, high: null }),
    );

    expect(holdingMarketValue(incomplete)).toBeNull();
    expect(collectionTotals([incomplete]).currencies[0]).toEqual({
      currency: "USD",
      low: null,
      market: null,
      high: null,
      cost: null,
      costCoverage: "none",
      net: null,
    });
  });

  it("should calculate net only when every valued holding has a comparable recorded cost", () => {
    const complete = holding("complete", quote(), {
      unitCost: { amount: 4, currency: "USD" },
    });
    const missingCost = holding("missing", quote({ marketPrice: 20 }));

    expect(collectionTotals([complete]).currencies[0]).toMatchObject({
      market: 10,
      cost: 4,
      costCoverage: "complete",
      net: 6,
    });
    expect(
      collectionTotals([complete, missingCost]).currencies[0],
    ).toMatchObject({
      market: 30,
      cost: 4,
      costCoverage: "partial",
      net: null,
    });
  });

  it("should distinguish unknown liquidity from a known low-liquidity quote", () => {
    const unknown = holding("unknown", quote({ liquidity: "unknown" }), {
      unitCost: { amount: 1, currency: "USD" },
    });
    const low = holding("low", quote({ liquidity: "low" }), {
      unitCost: { amount: 1, currency: "USD" },
    });
    const review = buildReviewQueue(
      [unknown, low],
      new Date("2026-07-22T00:00:00.000Z"),
    );

    expect(
      review.find((item) => item.holding.id === "unknown")?.reasons,
    ).toContain("unknown-liquidity");
    expect(
      review.find((item) => item.holding.id === "unknown")?.reasons,
    ).not.toContain("low-liquidity");
    expect(review.find((item) => item.holding.id === "low")?.reasons).toContain(
      "low-liquidity",
    );
  });

  it("should not reuse a quote for a different finish or explicitly different condition", () => {
    const nearMintNormal = quote({
      condition: "near-mint",
      conditionIncluded: true,
    });

    expect(
      selectPriceQuote([nearMintNormal], "en", "reverse", "near-mint"),
    ).toBeUndefined();
    expect(
      selectPriceQuote([nearMintNormal], "en", "normal", "played"),
    ).toBeUndefined();
    expect(
      selectPriceQuote([nearMintNormal], "en", "normal", "near-mint"),
    ).toBe(nearMintNormal);
  });

  it("should persist a market and currency preference independently from the interface locale", () => {
    const usd = quote({ market: "tcgplayer", currency: "USD" });
    const eur = quote({
      market: "cardmarket",
      currency: "EUR",
      marketPrice: 12,
    });
    saveValuationPreference({ market: "cardmarket", currency: "EUR" });

    expect(loadValuationPreference()).toEqual({
      market: "cardmarket",
      currency: "EUR",
    });
    expect(selectPriceQuote([usd, eur], "en")).toBe(eur);
    expect(selectPriceQuote([usd, eur], "fr")).toBe(eur);
  });
});
