import { afterEach, describe, expect, it, vi } from "vitest";

const tesseract = vi.hoisted(() => {
  const recognize = vi.fn(() => new Promise(() => undefined));
  const setParameters = vi.fn().mockResolvedValue({});
  const terminate = vi.fn().mockResolvedValue({});
  const worker = { recognize, setParameters, terminate };
  const createWorker = vi.fn().mockResolvedValue(worker);
  return { createWorker, recognize, setParameters, terminate };
});

vi.mock("tesseract.js", () => ({
  createWorker: tesseract.createWorker,
  PSM: { SINGLE_BLOCK: "6" },
}));

import { recognizeCardText } from "../../src/lib/ocr";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("OCR cancellation", () => {
  it("should abort active recognition and recycle its worker", async () => {
    const controller = new AbortController();
    const pending = recognizeCardText(new Blob(["card"]), "eng", undefined, {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(tesseract.recognize).toHaveBeenCalledOnce());

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(tesseract.terminate).toHaveBeenCalled());
  });

  it("should time out recognition and recycle its worker", async () => {
    vi.useFakeTimers();
    const pending = recognizeCardText(new Blob(["card"]), "eng", undefined, {
      timeoutMs: 25,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tesseract.recognize).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    await vi.advanceTimersByTimeAsync(0);
    expect(tesseract.terminate).toHaveBeenCalled();
  });
});
