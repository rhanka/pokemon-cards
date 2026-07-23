import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const scanner = vi.hoisted(() => ({
  recognizeCardText: vi.fn(),
  searchCatalog: vi.fn(),
  prepareImageForRecognition: vi.fn(async (blob: Blob) => blob),
  fingerprintImage: vi.fn(async () => ({ hash: "fingerprint" })),
}));

vi.mock("../../src/lib/ocr", () => ({
  parseCardText: vi.fn(),
  recognizeCardText: scanner.recognizeCardText,
}));

vi.mock("../../src/lib/api", () => ({
  getCatalogCard: vi.fn(),
  searchCatalog: scanner.searchCatalog,
}));

vi.mock("../../src/lib/image-fingerprint", () => ({
  prepareImageForRecognition: scanner.prepareImageForRecognition,
  fingerprintImage: scanner.fingerprintImage,
  rerankWithReferenceImages: vi.fn(async () => []),
}));

import ScannerPage from "../../src/lib/components/ScannerPage.svelte";
import type { ParsedCardText, RuntimeConfig } from "../../src/lib/types";

const config: RuntimeConfig = {
  appName: "CardScope",
  auth: { enabled: false, scope: "openid" },
  vision: { enabled: false },
  sync: { enabled: false, retentionDays: 1826 },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scanner OCR cancellation", () => {
  it("should abort OCR and ignore a result that resolves after cancellation", async () => {
    let resolveRecognition: ((value: ParsedCardText) => void) | undefined;
    let recognitionSignal: AbortSignal | undefined;
    scanner.recognizeCardText.mockImplementation(
      (
        _blob: Blob,
        _languages: string,
        _progress: unknown,
        options: { signal: AbortSignal },
      ) => {
        recognitionSignal = options.signal;
        return new Promise<ParsedCardText>((resolve) => {
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

    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    await userEvent.upload(
      screen.getByLabelText("Choose photo"),
      new File(["image"], "card.jpg", { type: "image/jpeg" }),
    );
    expect(
      await screen.findByText("Reading the card locally"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(recognitionSignal?.aborted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Use camera" }),
    ).toBeInTheDocument();
    resolveRecognition?.({
      rawText: "Pikachu\n025/165",
      name: "Pikachu",
      number: "025",
      setTotal: "165",
      query: "Pikachu 025/165",
      confidence: 0.95,
      signals: ["card-name", "collector-number"],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(scanner.searchCatalog).not.toHaveBeenCalled();
    expect(screen.queryByText("Possible matches")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use camera" }),
    ).toBeInTheDocument();
  });
});
