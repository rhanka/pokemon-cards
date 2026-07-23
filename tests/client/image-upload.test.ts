import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareImageForRecognition } from "../../src/lib/image-upload";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("recognition image upload safeguards", () => {
  it("should reject empty and unsupported image input before upload", async () => {
    await expect(
      prepareImageForRecognition(new Blob([], { type: "image/jpeg" })),
    ).rejects.toThrow("empty");
    await expect(
      prepareImageForRecognition(
        new Blob(["not-an-image"], { type: "text/plain" }),
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("should center-crop, downscale, and re-encode before upload", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 4096, height: 2048, close }),
    );
    const canvas = document.createElement("canvas");
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage,
      fillRect,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["resized"], { type: "image/jpeg" }));
    });
    vi.spyOn(document, "createElement").mockReturnValue(canvas);

    const result = await prepareImageForRecognition(
      new Blob(["source"], { type: "image/jpeg" }),
    );

    expect(canvas.width).toBe(1145);
    expect(canvas.height).toBe(1600);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.closeTo(1314.91, 1),
      0,
      expect.closeTo(1466.18, 1),
      2048,
      0,
      0,
      1145,
      1600,
    );
    expect(fillRect).toHaveBeenCalledOnce();
    expect(result.type).toBe("image/jpeg");
    expect(close).toHaveBeenCalledOnce();
  });
});
