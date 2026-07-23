import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareImageForRecognition,
  rerankWithReferenceImages,
} from "../../src/lib/image-fingerprint";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image input safeguards", () => {
  it("should reject empty and unsupported image input before starting OCR work", async () => {
    await expect(
      prepareImageForRecognition(new Blob([], { type: "image/jpeg" })),
    ).rejects.toThrow("empty");
    await expect(
      prepareImageForRecognition(
        new Blob(["not-an-image"], { type: "text/plain" }),
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("should downscale an oversized pixel surface before handing it to OCR", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 4096, height: 2048, close }),
    );
    const canvas = document.createElement("canvas");
    const drawImage = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["resized"], { type: "image/jpeg" }));
    });
    vi.spyOn(document, "createElement").mockReturnValue(canvas);

    const result = await prepareImageForRecognition(
      new Blob(["source"], { type: "image/jpeg" }),
    );

    expect(canvas.width).toBe(2048);
    expect(canvas.height).toBe(1024);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(result.type).toBe("image/jpeg");
    expect(close).toHaveBeenCalledOnce();
  });

  it("should fail open when an optional remote reference image cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("cross-origin blocked")),
    );

    await expect(
      rerankWithReferenceImages(
        {
          perceptualHash: "0000000000000000",
          rgbHash: Array.from({ length: 48 }, () => 0),
        },
        [
          {
            id: "card-1",
            name: "Pikachu",
            images: { small: "https://images.example.test/card.jpg" },
          },
        ],
      ),
    ).resolves.toEqual([]);
  });
});
