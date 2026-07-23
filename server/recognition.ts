import { performance } from "node:perf_hooks";

import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";

import { parseCardText } from "../shared/card-text.js";
import type { OcrLine, RecognitionEvidence } from "../shared/types.js";

const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const ENGINE_VERSION = "tesseract.js-6.0.1-eng-fra-best-int";
// Leave five seconds for HTTP connection teardown before Kubernetes sends
// SIGKILL at terminationGracePeriodSeconds=20.
const SHUTDOWN_WAIT_MS = 15_000;

sharp.concurrency(1);
sharp.cache(false);

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

export interface RecognitionEngine {
  recognize(
    image: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<RecognitionEngineResult>;
  healthy?(): boolean;
  close(): Promise<void>;
}

export interface RecognitionEngineResult {
  evidence: RecognitionEvidence;
  visualMatches: Array<{
    cardId: string;
    similarity: number;
    provider: "server-model";
  }>;
  engine: "tesseract" | "onnx";
  modelVersion: string | null;
  durationMs: number;
  photoRetained: false;
}

export interface TesseractRecognitionOptions {
  dataPath: string;
  maxPixels: number;
  normalizedMaxEdge: number;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export class RecognitionBusyError extends Error {
  constructor() {
    super("The recognition worker is busy");
    this.name = "RecognitionBusyError";
  }
}

export class RecognitionTimeoutError extends Error {
  constructor() {
    super("Card recognition exceeded its processing deadline");
    this.name = "RecognitionTimeoutError";
  }
}

export class RecognitionImageError extends Error {
  constructor(
    readonly reason: "unsupported" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "RecognitionImageError";
  }
}

function hasJpegMagic(image: Uint8Array): boolean {
  return JPEG_MAGIC.every((value, index) => image[index] === value);
}

async function normalizeJpeg(
  image: Uint8Array,
  options: Pick<TesseractRecognitionOptions, "maxPixels" | "normalizedMaxEdge">,
): Promise<Buffer> {
  if (!hasJpegMagic(image)) {
    throw new RecognitionImageError(
      "unsupported",
      "Recognition accepts a re-encoded JPEG image only",
    );
  }

  try {
    const inspector = sharp(image, {
      failOn: "warning",
      limitInputPixels: options.maxPixels,
      sequentialRead: true,
    });
    inspector.timeout({ seconds: 5 });
    const metadata = await inspector.metadata();
    if (
      metadata.format !== "jpeg" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > options.maxPixels
    ) {
      throw new RecognitionImageError(
        "unsupported",
        "Image format or dimensions are not supported",
      );
    }

    return await sharp(image, {
      failOn: "warning",
      limitInputPixels: options.maxPixels,
      sequentialRead: true,
    })
      .timeout({ seconds: 5 })
      .rotate()
      .resize({
        width: options.normalizedMaxEdge,
        height: options.normalizedMaxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .grayscale()
      .normalise()
      .sharpen({ sigma: 0.8 })
      .jpeg({ quality: 88, chromaSubsampling: "4:4:4" })
      .toBuffer();
  } catch (error) {
    if (error instanceof RecognitionImageError) throw error;
    throw new RecognitionImageError(
      "invalid",
      "The JPEG could not be decoded safely",
    );
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Recognition was cancelled", "AbortError");
}

async function waitAtMost(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, milliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class TesseractRecognitionEngine implements RecognitionEngine {
  private worker: TesseractWorker | null = null;
  private workerPromise: Promise<TesseractWorker> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private recyclePromise: Promise<void> | null = null;
  private activeCompletion: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private workerEpoch = 0;
  private inFlight = false;
  private closed = false;

  constructor(private readonly options: TesseractRecognitionOptions) {}

  async recognize(
    image: Uint8Array,
    request: { signal?: AbortSignal } = {},
  ): Promise<RecognitionEngineResult> {
    if (this.closed) throw new Error("Recognition engine is closed");
    if (this.inFlight || this.recyclePromise) throw new RecognitionBusyError();
    if (request.signal?.aborted) throw abortError(request.signal);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.inFlight = true;
    let completeActive: () => void = () => undefined;
    const activeCompletion = new Promise<void>((resolve) => {
      completeActive = resolve;
    });
    this.activeCompletion = activeCompletion;
    const startedAt = performance.now();
    let normalized: Buffer | undefined;
    let processing: Promise<
      Awaited<ReturnType<TesseractWorker["recognize"]>>
    > | null = null;

    try {
      normalized = await normalizeJpeg(image, this.options);
      if (request.signal?.aborted) throw abortError(request.signal);
      if (this.shutdownController.signal.aborted)
        throw abortError(this.shutdownController.signal);
      const remainingMs =
        this.options.timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) throw new RecognitionTimeoutError();

      let timeout: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      let shutdownListener: (() => void) | undefined;
      let timedOut = false;
      processing = (async () => {
        const worker = await this.getWorker();
        if (request.signal?.aborted) throw abortError(request.signal);
        if (this.shutdownController.signal.aborted)
          throw abortError(this.shutdownController.signal);
        const result = await worker.recognize(
          normalized,
          {},
          { blocks: true, text: true },
        );
        await this.clearWorkerImage(worker);
        return result;
      })();
      const cancellation = new Promise<never>((_, reject) => {
        abortListener = () => reject(abortError(request.signal));
        if (request.signal?.aborted) {
          abortListener();
        } else {
          request.signal?.addEventListener("abort", abortListener, {
            once: true,
          });
        }
        shutdownListener = () =>
          reject(abortError(this.shutdownController.signal));
        if (this.shutdownController.signal.aborted) {
          shutdownListener();
        } else {
          this.shutdownController.signal.addEventListener(
            "abort",
            shutdownListener,
            { once: true },
          );
        }
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new RecognitionTimeoutError());
        }, remainingMs);
      });

      try {
        const result = await Promise.race([processing, cancellation]);
        const lines: OcrLine[] = (result.data.blocks ?? []).flatMap((block) =>
          block.paragraphs.flatMap((paragraph) =>
            paragraph.lines.map((line) => ({
              text: line.text,
              confidence: line.confidence,
            })),
          ),
        );
        const parsed = parseCardText(
          lines.length > 0 ? lines : result.data.text,
        );
        const evidence = {
          name: parsed.name,
          number: parsed.number,
          setTotal: parsed.setTotal,
          query: parsed.query,
          confidence: parsed.confidence,
          signals: parsed.signals,
        };
        this.armIdleTimer();
        return {
          evidence,
          visualMatches: [],
          engine: "tesseract",
          modelVersion: ENGINE_VERSION,
          durationMs: Math.round(performance.now() - startedAt),
          photoRetained: false,
        };
      } catch (error) {
        void processing.catch(() => undefined);
        void this.startRecycleWorker();
        if (timedOut) throw new RecognitionTimeoutError();
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abortListener)
          request.signal?.removeEventListener("abort", abortListener);
        if (shutdownListener)
          this.shutdownController.signal.removeEventListener(
            "abort",
            shutdownListener,
          );
      }
    } finally {
      // worker.recognize copies its payload into the worker before returning
      // the job promise. Tesseract termination does not reject pending jobs,
      // so waiting on `processing.finally` could retain this buffer forever.
      normalized?.fill(0);
      normalized = undefined;
      this.inFlight = false;
      if (this.activeCompletion === activeCompletion)
        this.activeCompletion = null;
      completeActive();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.shutdownController.abort(
      new DOMException("Recognition engine is shutting down", "AbortError"),
    );
    const activeCompletion = this.activeCompletion;
    const cleanup = Promise.all([
      activeCompletion ?? Promise.resolve(),
      this.startRecycleWorker(),
    ]);
    this.closePromise = waitAtMost(cleanup, SHUTDOWN_WAIT_MS);
    return this.closePromise;
  }

  healthy(): boolean {
    return !this.closed && this.recyclePromise === null;
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker;
    if (this.workerPromise) return this.workerPromise;
    const epoch = this.workerEpoch;
    const pending = (async () => {
      const worker = await createWorker(["eng", "fra"], undefined, {
        langPath: this.options.dataPath,
        cacheMethod: "none",
        gzip: true,
      });
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
      if (this.closed || epoch !== this.workerEpoch) {
        await worker.terminate();
        throw new RecognitionBusyError();
      }
      this.worker = worker;
      return worker;
    })();
    this.workerPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.workerPromise === pending) this.workerPromise = null;
    }
  }

  private armIdleTimer(): void {
    if (!this.worker) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.startRecycleWorker();
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private async clearWorkerImage(worker: TesseractWorker): Promise<void> {
    try {
      await worker.FS("unlink", ["/input"]);
      // Tesseract's API retains the current Pix even after the MEMFS file is
      // unlinked. Reinitializing calls api.End(), releasing that native image,
      // while keeping already-loaded language data in the worker.
      await worker.reinitialize("eng+fra");
      await worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
    } catch {
      // If the in-memory image cannot be cleared, terminate the worker before
      // returning any result rather than retaining a scan until idle expiry.
      await this.startRecycleWorker();
    }
  }

  private startRecycleWorker(): Promise<void> {
    if (this.recyclePromise) return this.recyclePromise;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const worker = this.worker;
    const pending = this.workerPromise;
    this.workerEpoch += 1;
    this.worker = null;
    this.workerPromise = null;
    const recycling = (async () => {
      if (worker) await worker.terminate().catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
    })().finally(() => {
      if (this.recyclePromise === recycling) this.recyclePromise = null;
    });
    this.recyclePromise = recycling;
    return recycling;
  }
}
