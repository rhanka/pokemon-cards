import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerRecognitionResult } from "../../shared/types";

const scanner = vi.hoisted(() => ({
  getCatalogCard: vi.fn(),
  recognizeCardImage: vi.fn(),
  searchCatalog: vi.fn(),
  prepareImageForRecognition: vi.fn(async (blob: Blob) => blob),
}));

vi.mock("../../src/lib/api", () => ({
  getCatalogCard: scanner.getCatalogCard,
  recognizeCardImage: scanner.recognizeCardImage,
  searchCatalog: scanner.searchCatalog,
}));

vi.mock("../../src/lib/image-upload", () => ({
  prepareImageForRecognition: scanner.prepareImageForRecognition,
}));

import ScannerPage from "../../src/lib/components/ScannerPage.svelte";
import type { RuntimeConfig } from "../../src/lib/types";

const config: RuntimeConfig = {
  appName: "CardScope",
  recognition: {
    enabled: true,
    processing: "server",
    maxImageBytes: 2 * 1024 * 1024,
  },
  auth: { enabled: false, scope: "openid" },
  sync: {
    enabled: false,
    retentionDays: 1826,
    maxBatchSize: 100,
    maxOperationBytes: 64 * 1024,
  },
  valuation: { marketQuotesEnabled: false },
};

afterEach(() => {
  cleanup();
  scanner.getCatalogCard.mockReset();
  scanner.recognizeCardImage.mockReset();
  scanner.searchCatalog.mockReset();
  scanner.prepareImageForRecognition.mockClear();
  vi.unstubAllGlobals();
});

describe("scanner server-recognition cancellation", () => {
  it("should offer manual catalogue search rather than a legacy scan when visual recognition is disabled", () => {
    render(ScannerPage, {
      locale: "en",
      config: { ...config, recognition: { ...config.recognition, enabled: false } },
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd: vi.fn(),
    });

    expect(screen.queryByRole("button", { name: "Use camera" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Choose photo")).not.toBeInTheDocument();
    expect(screen.getByText(/Visual recognition is being verified/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
  });

  it("should abort the upload and ignore a late recognition result", async () => {
    let resolveRecognition:
      ((value: ServerRecognitionResult) => void) | undefined;
    let recognitionSignal: AbortSignal | undefined;
    scanner.recognizeCardImage.mockImplementation(
      (_blob: Blob, _locale: string, signal: AbortSignal) => {
        recognitionSignal = signal;
        return new Promise<ServerRecognitionResult>((resolve) => {
          resolveRecognition = resolve;
        });
      },
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    render(ScannerPage, {
      locale: "en",
      config,
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd: vi.fn(),
    });

    await userEvent.upload(
      screen.getByLabelText("Choose photo"),
      new File(["image"], "card.jpg", { type: "image/jpeg" }),
    );
    expect(
      await screen.findByText("Comparing the card securely"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(recognitionSignal?.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Use camera" }),
    ).toBeInTheDocument();
    resolveRecognition?.({
      evidence: {
        name: "Pikachu",
        number: "025",
        setTotal: "165",
        query: "Pikachu 025/165",
        confidence: 0.95,
        signals: ["card-name", "collector-number"],
      },
      cards: [],
      visualMatches: [],
      engine: "tesseract",
      modelVersion: "test",
      durationMs: 1,
      photoRetained: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(scanner.searchCatalog).not.toHaveBeenCalled();
    expect(screen.queryByText("Possible matches")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use camera" }),
    ).toBeInTheDocument();
  });

  it("should search manually in both languages without a pre-scan picker", async () => {
    scanner.searchCatalog.mockResolvedValue([]);
    render(ScannerPage, {
      locale: "en",
      config,
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

  it("should show candidate languages and persist the selected candidate language", async () => {
    const english = {
      id: "pokemon-card:en:base1:58:pikachu",
      name: "Pikachu",
      number: "58",
      language: "en" as const,
      supertype: "Pokémon",
      subtypes: ["Basic"],
      rarity: "Common",
      set: {
        id: "base1",
        name: "Base Set",
        series: "Base",
        printedTotal: 102,
        total: 102,
      },
      images: { small: null, large: null },
      externalIds: { tcgdex: "base1-58" },
      sources: ["tcgdex" as const],
      quotes: [],
      updatedAt: "2026-07-22T12:00:00.000Z",
    };
    const french = {
      ...english,
      id: "pokemon-card:fr:base1:58:pikachu",
      language: "fr" as const,
      set: { ...english.set, name: "Set de Base" },
    };
    scanner.recognizeCardImage.mockResolvedValue({
      evidence: {
        name: "Pikachu",
        number: "58",
        setTotal: "102",
        query: "Pikachu 58/102",
        confidence: 0.95,
        signals: ["card-name", "collector-number"],
      },
      cards: [english, french],
      visualMatches: [],
      engine: "tesseract",
      modelVersion: "test",
      durationMs: 1,
      photoRetained: false,
    });
    scanner.getCatalogCard.mockResolvedValue({
      id: french.id,
      name: french.name,
      number: french.number,
      setId: french.set.id,
      setName: french.set.name,
      language: "fr",
      images: {},
      quotes: [],
    });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    render(ScannerPage, {
      locale: "en",
      config,
      online: true,
      valuationPreference: { market: "tcgplayer", currency: "USD" },
      onAdd,
    });

    await userEvent.upload(
      screen.getByLabelText("Choose photo"),
      new File(["image"], "card.jpg", { type: "image/jpeg" }),
    );
    const frenchCandidate = await screen.findByRole("button", {
      name: /Pikachu.*French/,
    });
    expect(
      screen.getByRole("button", { name: /Pikachu.*English/ }),
    ).toBeInTheDocument();

    await userEvent.click(frenchCandidate);
    expect(scanner.getCatalogCard).toHaveBeenCalledWith(
      french.id,
      "fr",
      "en",
      expect.any(Object),
    );
    await userEvent.click(screen.getByRole("radio", { name: "Normal" }));
    await userEvent.click(screen.getByRole("radio", { name: "Near mint" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Add to collection" }),
    );

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        card: expect.objectContaining({ id: french.id, language: "fr" }),
      }),
    );
  });
});
