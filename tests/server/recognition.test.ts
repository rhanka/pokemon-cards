import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const tesseract = vi.hoisted(() => {
  const recognize = vi.fn();
  const setParameters = vi.fn().mockResolvedValue(undefined);
  const FS = vi.fn().mockResolvedValue(undefined);
  const reinitialize = vi.fn().mockResolvedValue(undefined);
  const terminate = vi.fn().mockResolvedValue(undefined);
  const createWorker = vi.fn().mockResolvedValue({
    recognize,
    setParameters,
    FS,
    reinitialize,
    terminate,
  });
  return {
    createWorker,
    recognize,
    setParameters,
    FS,
    reinitialize,
    terminate,
  };
});

vi.mock("tesseract.js", () => ({
  createWorker: tesseract.createWorker,
  PSM: { SINGLE_BLOCK: "6" },
}));

import {
  RecognitionBusyError,
  RecognitionImageError,
  RecognitionTimeoutError,
  TesseractRecognitionEngine,
} from "../../server/recognition";

function engine(timeoutMs = 1_000) {
  return new TesseractRecognitionEngine({
    dataPath: "/tmp/cardscope-test-recognition-data",
    maxPixels: 4_000_000,
    normalizedMaxEdge: 1_600,
    timeoutMs,
    idleTimeoutMs: 10_000,
  });
}

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 600,
      height: 825,
      channels: 3,
      background: "#f5f0dc",
    },
  })
    .jpeg()
    .toBuffer();
}

afterEach(() => {
  vi.useRealTimers();
  tesseract.recognize.mockReset();
  tesseract.setParameters.mockReset().mockResolvedValue(undefined);
  tesseract.FS.mockReset().mockResolvedValue(undefined);
  tesseract.reinitialize.mockReset().mockResolvedValue(undefined);
  tesseract.terminate.mockReset().mockResolvedValue(undefined);
  tesseract.createWorker.mockReset().mockResolvedValue({
    recognize: tesseract.recognize,
    setParameters: tesseract.setParameters,
    FS: tesseract.FS,
    reinitialize: tesseract.reinitialize,
    terminate: tesseract.terminate,
  });
});

describe("server recognition engine", () => {
  it("should reject non-JPEG bytes before starting Tesseract", async () => {
    const recognizer = engine();
    await expect(
      recognizer.recognize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    ).rejects.toBeInstanceOf(RecognitionImageError);
    expect(tesseract.createWorker).not.toHaveBeenCalled();
    await recognizer.close();
  });

  it("should return bounded evidence without raw OCR text", async () => {
    tesseract.recognize.mockResolvedValue({
      data: {
        text: [
          "Basic Pokémon",
          "Pikachu 40 HP D",
          "JA AS A",
          "Thunder Jolt Flip a coin. If tails,",
          "Pikachu does 10 damage to itself.",
          "S58/102",
        ].join("\n"),
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: "Basic Pokémon", confidence: 96 },
                  { text: "Pikachu 40 HP D", confidence: 35 },
                  { text: "JA AS A", confidence: 35 },
                  {
                    text: "Thunder Jolt Flip a coin. If tails,",
                    confidence: 92,
                  },
                  {
                    text: "Pikachu does 10 damage to itself.",
                    confidence: 96,
                  },
                  { text: "S58/102", confidence: 65 },
                ],
              },
            ],
          },
        ],
      },
    });
    const recognizer = engine();
    const result = await recognizer.recognize(await jpeg());

    expect(result).toMatchObject({
      evidence: {
        name: "Pikachu",
        number: "58",
        setTotal: "102",
        query: "Pikachu 58/102",
      },
      engine: "tesseract",
      photoRetained: false,
    });
    expect(result.evidence).not.toHaveProperty("rawText");
    expect(tesseract.setParameters).toHaveBeenCalledTimes(2);
    expect(tesseract.FS).toHaveBeenCalledWith("unlink", ["/input"]);
    expect(tesseract.reinitialize).toHaveBeenCalledWith("eng+fra");
    await recognizer.close();
  });

  it("should reject concurrent work and recycle a timed-out worker", async () => {
    tesseract.recognize.mockImplementation(() => new Promise(() => undefined));
    const recognizer = engine(250);
    const image = await jpeg();
    const first = recognizer.recognize(image);
    const firstRejection = expect(first).rejects.toBeInstanceOf(
      RecognitionTimeoutError,
    );

    await expect(recognizer.recognize(image)).rejects.toBeInstanceOf(
      RecognitionBusyError,
    );
    await vi.waitFor(() => expect(tesseract.recognize).toHaveBeenCalledOnce());
    await firstRejection;
    expect(tesseract.terminate).toHaveBeenCalled();
    await recognizer.close();
  });

  it("should reject an active scan and finish shutdown before the pod grace period", async () => {
    const image = await jpeg();
    vi.useFakeTimers();
    let recognitionStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      recognitionStarted = resolve;
    });
    tesseract.recognize.mockImplementationOnce(() => {
      recognitionStarted();
      return new Promise(() => undefined);
    });
    tesseract.terminate.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const recognizer = engine(30_000);
    const scan = recognizer.recognize(image);
    await started;

    const shutdown = recognizer.close();
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });

    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(shutdownFinished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toBeUndefined();
    expect(shutdownFinished).toBe(true);
  });

  it("should reject a scan and bound close when worker bootstrap never settles", async () => {
    const image = await jpeg();
    vi.useFakeTimers();
    let bootstrapStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      bootstrapStarted = resolve;
    });
    tesseract.createWorker.mockImplementationOnce(() => {
      bootstrapStarted();
      return new Promise(() => undefined);
    });
    const recognizer = engine(30_000);
    const scan = recognizer.recognize(image);
    await started;

    const shutdown = recognizer.close();
    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("should cancel the idle recycle timer while a new scan is active", async () => {
    const image = await jpeg();
    tesseract.recognize.mockResolvedValueOnce({
      data: { text: "Pikachu\n58/102", blocks: [] },
    });
    let finishSecond: ((value: unknown) => void) | undefined;
    tesseract.recognize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
    const recognizer = new TesseractRecognitionEngine({
      dataPath: "/tmp/cardscope-test-recognition-data",
      maxPixels: 4_000_000,
      normalizedMaxEdge: 1_600,
      timeoutMs: 1_000,
      idleTimeoutMs: 25,
    });
    await recognizer.recognize(image);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = recognizer.recognize(image);
    await vi.waitFor(() => expect(finishSecond).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tesseract.terminate).not.toHaveBeenCalled();
    finishSecond?.({
      data: { text: "Raichu\n14/102", blocks: [] },
    });
    await second;
    await recognizer.close();
  });

  it("should apply the request deadline while the OCR worker starts", async () => {
    let finishStartup:
      | ((worker: {
          recognize: typeof tesseract.recognize;
          setParameters: typeof tesseract.setParameters;
          FS: typeof tesseract.FS;
          reinitialize: typeof tesseract.reinitialize;
          terminate: typeof tesseract.terminate;
        }) => void)
      | undefined;
    tesseract.createWorker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStartup = resolve;
        }),
    );
    const recognizer = engine(150);
    const scan = recognizer.recognize(await jpeg());
    await expect(scan).rejects.toBeInstanceOf(RecognitionTimeoutError);
    expect(recognizer.healthy()).toBe(false);
    await expect(recognizer.recognize(await jpeg())).rejects.toBeInstanceOf(
      RecognitionBusyError,
    );
    finishStartup?.({
      recognize: tesseract.recognize,
      setParameters: tesseract.setParameters,
      FS: tesseract.FS,
      reinitialize: tesseract.reinitialize,
      terminate: tesseract.terminate,
    });
    await vi.waitFor(() => expect(tesseract.terminate).toHaveBeenCalled());
    await vi.waitFor(() => expect(recognizer.healthy()).toBe(true));
    await recognizer.close();
  });
});
