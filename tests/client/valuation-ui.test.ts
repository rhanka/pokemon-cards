import { cleanup, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CollectionPage from "../../src/lib/components/CollectionPage.svelte";
import InsightsPage from "../../src/lib/components/InsightsPage.svelte";
import PriceQuote from "../../src/lib/components/PriceQuote.svelte";
import ScannerPage from "../../src/lib/components/ScannerPage.svelte";
import { formatMoney } from "../../src/lib/i18n";
import type {
  CollectionSnapshot,
  Holding,
  PriceQuote as Quote,
  RuntimeConfig,
} from "../../src/lib/types";

const normalQuote: Quote = {
  source: "TCGdex",
  market: "tcgplayer",
  currency: "USD",
  finish: "normal",
  condition: "near-mint",
  conditionIncluded: true,
  low: 8,
  marketPrice: 10,
  high: 12,
  liquidity: "unknown",
  observedAt: "2026-07-20T00:00:00.000Z",
  staleAfter: "2026-07-30T00:00:00.000Z",
};

function makeHolding(
  id: string,
  quote: Quote,
  cost: { amount: number; currency: string },
): Holding {
  return {
    id,
    cardId: id,
    card: { id, name: `Card ${id}`, language: "en", quote, quotes: [quote] },
    quantity: 1,
    finish: "normal",
    condition: "near-mint",
    unitCost: cost,
    quote,
    addedAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

const mixedSnapshot: CollectionSnapshot = {
  holdings: [
    makeHolding("usd", normalQuote, { amount: 4, currency: "USD" }),
    makeHolding(
      "eur",
      {
        ...normalQuote,
        currency: "EUR",
        market: "cardmarket",
        low: 18,
        marketPrice: 20,
        high: 25,
      },
      { amount: 3, currency: "EUR" },
    ),
  ],
  activities: [],
  eventCount: 2,
};

afterEach(cleanup);

describe("valuation UI", () => {
  it("should render every collection and insight currency as a separate total", () => {
    const common = {
      locale: "en" as const,
      snapshot: mixedSnapshot,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdjust: vi.fn(),
      onRemove: vi.fn(),
      onUpdate: vi.fn(),
    };
    const collection = render(CollectionPage, common);

    expect(
      screen.getAllByText(formatMoney("en", 10, "USD")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(formatMoney("en", 20, "EUR")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();

    collection.unmount();
    render(InsightsPage, { locale: "en", snapshot: mixedSnapshot });

    expect(screen.getByText(/Market estimate · USD/)).toBeInTheDocument();
    expect(screen.getByText(/Market estimate · EUR/)).toBeInTheDocument();
  });

  it("should show source, observation date, unavailable bounds, and unknown liquidity without a source URL", () => {
    render(PriceQuote, {
      locale: "en",
      quote: {
        ...normalQuote,
        low: null,
        marketPrice: null,
        high: null,
        sourceUrl: undefined,
      },
    });

    expect(screen.getByText("Source: TCGdex")).toBeInTheDocument();
    expect(screen.getByText(/^Observed /)).toBeInTheDocument();
    expect(screen.getByText("Unavailable–Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Liquidity unknown")).toBeInTheDocument();
  });

  it("should expose partial cost coverage instead of calculating a misleading net value", () => {
    const partialSnapshot: CollectionSnapshot = {
      holdings: [
        makeHolding("costed", normalQuote, { amount: 4, currency: "USD" }),
        {
          ...makeHolding(
            "missing-cost",
            { ...normalQuote, marketPrice: 20 },
            { amount: 0, currency: "USD" },
          ),
          unitCost: undefined,
        },
      ],
      activities: [],
      eventCount: 2,
    };
    const rendered = render(CollectionPage, {
      locale: "en",
      snapshot: partialSnapshot,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdjust: vi.fn(),
      onRemove: vi.fn(),
      onUpdate: vi.fn(),
    });
    expect(screen.getByText("Partial cost coverage")).toBeInTheDocument();
    expect(
      screen.getByText("Unavailable", { selector: ".value-grid b" }),
    ).toBeInTheDocument();

    rendered.unmount();
    render(InsightsPage, { locale: "en", snapshot: partialSnapshot });
    expect(screen.getByText("Partial cost coverage")).toBeInTheDocument();
  });

  it("should invalidate an incompatible quote after a finish change and allow acquisition cost entry", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(CollectionPage, {
      locale: "en",
      snapshot: { ...mixedSnapshot, holdings: [mixedSnapshot.holdings[0]] },
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdjust: vi.fn(),
      onRemove: vi.fn(),
      onUpdate,
    });

    await userEvent.selectOptions(screen.getByLabelText("Finish"), "reverse");
    expect(onUpdate).toHaveBeenCalledWith("usd", {
      finish: "reverse",
      quote: null,
    });

    const form = screen.getByRole("form", {
      name: "Save acquisition cost: Card usd",
    });
    const amount = within(form).getByLabelText("Unit acquisition cost");
    const currency = within(form).getByLabelText("Cost currency");
    await userEvent.clear(amount);
    await userEvent.type(amount, "6.25");
    await userEvent.clear(currency);
    await userEvent.type(currency, "cad");
    expect(amount).toBeValid();
    expect(currency).toBeValid();
    expect(form).toBeValid();
    await userEvent.click(
      within(form).getByRole("button", { name: "Save acquisition cost" }),
    );

    expect(onUpdate).toHaveBeenLastCalledWith("usd", {
      unitCost: { amount: 6.25, currency: "CAD" },
    });
  });

  it("should use the explicit valuation preference when assigning a new holding quote", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const usd = {
      ...normalQuote,
      condition: undefined,
      conditionIncluded: false,
    };
    const eur = {
      ...normalQuote,
      market: "cardmarket",
      currency: "EUR",
      marketPrice: 14,
      condition: undefined,
      conditionIncluded: false,
    };
    const holding = {
      ...makeHolding("preferred", usd, { amount: 2, currency: "USD" }),
      card: {
        ...makeHolding("preferred", usd, { amount: 2, currency: "USD" }).card,
        quotes: [usd, eur],
      },
    };
    render(CollectionPage, {
      locale: "fr",
      valuationPreference: { market: "cardmarket", currency: "EUR" },
      snapshot: { holdings: [holding], activities: [], eventCount: 1 },
      onAdjust: vi.fn(),
      onRemove: vi.fn(),
      onUpdate,
    });

    await userEvent.selectOptions(screen.getByLabelText("État"), "excellent");

    expect(onUpdate).toHaveBeenCalledWith("preferred", {
      condition: "excellent",
      quote: expect.objectContaining({ market: "cardmarket", currency: "EUR" }),
    });
  });
});

describe("scanner language choice", () => {
  it("should keep scan controls disabled until the printed card language is explicitly selected", async () => {
    const config: RuntimeConfig = {
      appName: "CardScope",
      recognition: {
        enabled: true,
        processing: "server",
        maxImageBytes: 2 * 1024 * 1024,
      },
      auth: { enabled: false, scope: "openid" },
      sync: { enabled: false, retentionDays: 1826 },
      valuation: { marketQuotesEnabled: false },
    };
    render(ScannerPage, {
      locale: "en",
      config,
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Use camera" })).toBeDisabled();
    expect(screen.getByLabelText("Choose photo")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: "English" }));

    expect(screen.getByRole("button", { name: "Use camera" })).toBeEnabled();
    expect(screen.getByLabelText("Choose photo")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });
});
