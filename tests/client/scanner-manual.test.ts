import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const scanner = vi.hoisted(() => ({
  getCatalogCard: vi.fn(),
  searchCatalog: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  getCatalogCard: scanner.getCatalogCard,
  searchCatalog: scanner.searchCatalog,
}));

import ScannerPage from "../../src/lib/components/ScannerPage.svelte";

afterEach(() => {
  cleanup();
  scanner.getCatalogCard.mockReset();
  scanner.searchCatalog.mockReset();
});

describe("scanner manual catalogue search", () => {
  it("should offer catalogue search while visual recognition is unavailable", () => {
    render(ScannerPage, {
      locale: "en",
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "Use camera" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose photo")).not.toBeInTheDocument();
    expect(screen.getByText(/Visual recognition is being verified/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });

  it("should search both catalogue languages without asking for printed language", async () => {
    scanner.searchCatalog.mockResolvedValue([]);
    render(ScannerPage, {
      locale: "en",
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd: vi.fn(),
    });

    await userEvent.type(
      screen.getByLabelText("Search by name or collector number"),
      "Pikachu 58/102",
    );
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(scanner.searchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Pikachu",
        number: "58",
        setTotal: "102",
      }),
      "auto",
      "en",
      expect.any(AbortSignal),
      { market: "tcgplayer", currency: "USD" },
    );
  });
});
