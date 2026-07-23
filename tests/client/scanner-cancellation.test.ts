import { cleanup, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerRecognitionResult } from "../../shared/types";

const scanner = vi.hoisted(() => ({
  recognizeCardImage: vi.fn(),
  searchCatalog: vi.fn(),
  prepareImageForRecognition: vi.fn(async (blob: Blob) => blob),
}));

vi.mock("../../src/lib/api", () => ({
  getCatalogCard: vi.fn(),
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
  sync: { enabled: false, retentionDays: 1826 },
  valuation: { marketQuotesEnabled: false },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scanner server-recognition cancellation", () => {
  it("should abort the upload and ignore a late recognition result", async () => {
    let resolveRecognition:
      ((value: ServerRecognitionResult) => void) | undefined;
    let recognitionSignal: AbortSignal | undefined;
    scanner.recognizeCardImage.mockImplementation(
      (_blob: Blob, _language: string, signal: AbortSignal) => {
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

    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    await userEvent.upload(
      screen.getByLabelText("Choose photo"),
      new File(["image"], "card.jpg", { type: "image/jpeg" }),
    );
    expect(
      await screen.findByText("Reading the card securely"),
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
});
