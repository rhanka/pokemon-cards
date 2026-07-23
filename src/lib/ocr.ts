import type { OcrLine, ParsedCardText } from "./types";

type TesseractLoggerMessage = {
  status: string;
  progress: number;
};

type TesseractWorker = Awaited<
  ReturnType<(typeof import("tesseract.js"))["createWorker"]>
>;

const OCR_ASSET_ROOT = "/ocr/v6";

let cachedWorker: { languages: string; worker: TesseractWorker } | null = null;
let workerPromise: Promise<TesseractWorker> | null = null;
let workerEpoch = 0;
let activeProgress: {
  owner: symbol;
  listener: (progress: OcrProgress) => void;
} | null = null;

export type OcrProgress = {
  stage: string;
  progress: number;
};

export type OcrRecognitionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_OCR_TIMEOUT_MS = 45_000;

const FRACTION_NUMBER =
  /\b([A-Z]{0,4}\s?\d{1,3}[A-Z]?)\s*[/／]\s*([A-Z]{0,4}\s?\d{1,3})\b/i;
const PROMO_NUMBER = /\b((?:SWSH|SVP|SM|XY|BW)?\s?\d{1,3}[A-Z]?)\b/i;
const CARD_NOISE =
  /^(basic|stage\s*[12]|trainer|supporter|item|stadium|energy|hp\s*\d+|pok[eé]mon|illus\.?|weakness|resistance|retreat|rule|ability)$/i;
const STAT_LINE =
  /(?:\bHP\s*\d+|[×x]\s*2|[-+]\s*\d+|\b\d{2,3}\s*$|©|illus\.?|weakness|resistance|retreat)/i;

function cleanLine(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[|_[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedCardNumber(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function likelyName(lines: OcrLine[]): OcrLine | undefined {
  return lines
    .filter(({ text, confidence }) => {
      const clean = cleanLine(text);
      if (confidence < 20 || clean.length < 3 || clean.length > 34)
        return false;
      if (CARD_NOISE.test(clean) || STAT_LINE.test(clean)) return false;
      if (FRACTION_NUMBER.test(clean)) return false;
      const letters = clean.match(/[\p{L}]/gu)?.length ?? 0;
      return letters / clean.length >= 0.55;
    })
    .sort((a, b) => {
      const aClean = cleanLine(a.text);
      const bClean = cleanLine(b.text);
      const aTitleBonus = /^(?:[\p{Lu}][\p{L}'’-]*\s*){1,4}$/u.test(aClean)
        ? 16
        : 0;
      const bTitleBonus = /^(?:[\p{Lu}][\p{L}'’-]*\s*){1,4}$/u.test(bClean)
        ? 16
        : 0;
      return b.confidence + bTitleBonus - (a.confidence + aTitleBonus);
    })[0];
}

export function parseCardText(input: string | OcrLine[]): ParsedCardText {
  const lines: OcrLine[] = Array.isArray(input)
    ? input
        .map((line) => ({ ...line, text: cleanLine(line.text) }))
        .filter((line) => line.text)
    : input
        .split(/\r?\n/)
        .map((text) => ({ text: cleanLine(text), confidence: 70 }))
        .filter((line) => line.text);
  const rawText = lines.map(({ text }) => text).join("\n");
  const numberLine = lines.find(({ text }) => FRACTION_NUMBER.test(text));
  const fraction = numberLine?.text.match(FRACTION_NUMBER);
  const fallbackNumberLine = lines
    .slice()
    .reverse()
    .find(
      ({ text }) =>
        PROMO_NUMBER.test(text) && /\d/.test(text) && text.length <= 16,
    );
  const fallbackNumber = fallbackNumberLine?.text.match(PROMO_NUMBER)?.[1];
  const nameLine = likelyName(lines);
  const number = fraction?.[1]
    ? normalizedCardNumber(fraction[1])
    : fallbackNumber
      ? normalizedCardNumber(fallbackNumber)
      : undefined;
  const setTotal = fraction?.[2]
    ? normalizedCardNumber(fraction[2])
    : undefined;
  const name = nameLine ? cleanLine(nameLine.text) : undefined;
  const signals: string[] = [];
  if (number) signals.push(fraction ? "collector-number" : "promo-number");
  if (setTotal) signals.push("set-total");
  if (name) signals.push("card-name");
  const nameConfidence = nameLine ? Math.min(1, nameLine.confidence / 100) : 0;
  const numberConfidence = numberLine
    ? Math.min(1, numberLine.confidence / 100)
    : fallbackNumberLine
      ? 0.45
      : 0;
  const confidence = Math.min(1, numberConfidence * 0.6 + nameConfidence * 0.4);
  const query = [name, number && setTotal ? `${number}/${setTotal}` : number]
    .filter(Boolean)
    .join(" ")
    .trim();

  return { rawText, name, number, setTotal, query, confidence, signals };
}

export async function recognizeCardText(
  image: Blob,
  languages: string,
  onProgress?: (progress: OcrProgress) => void,
  options: OcrRecognitionOptions = {},
): Promise<ParsedCardText> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "OCR timeout must be a positive number of milliseconds.",
    );
  }
  if (options.signal?.aborted) throw abortReason(options.signal);

  const progressOwner = Symbol("ocr-progress");
  if (onProgress)
    activeProgress = { owner: progressOwner, listener: onProgress };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let cancelled = false;

  try {
    const recognition = (async () => {
      const worker = await getWorker(languages);
      if (options.signal?.aborted) throw abortReason(options.signal);
      const result = await worker.recognize(image);
      if (options.signal?.aborted) throw abortReason(options.signal);
      return result;
    })();
    const cancellation = new Promise<never>((_, reject) => {
      abortListener = () => {
        cancelled = true;
        reject(abortReason(options.signal));
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      timeout = setTimeout(() => {
        cancelled = true;
        reject(
          new DOMException(
            `OCR recognition exceeded ${timeoutMs} ms.`,
            "TimeoutError",
          ),
        );
      }, timeoutMs);
    });
    const result = await Promise.race([recognition, cancellation]);
    const lines: OcrLine[] = (result.data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => ({
          text: line.text,
          confidence: line.confidence,
        })),
      ),
    );
    return parseCardText(lines.length > 0 ? lines : result.data.text);
  } catch (error) {
    const recycling = recycleWorker();
    if (cancelled) void recycling;
    else await recycling;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener)
      options.signal?.removeEventListener("abort", abortListener);
    if (activeProgress?.owner === progressOwner) activeProgress = null;
  }
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("OCR recognition was cancelled.", "AbortError");
}

async function getWorker(languages: string): Promise<TesseractWorker> {
  if (cachedWorker?.languages === languages) return cachedWorker.worker;
  if (workerPromise) return workerPromise;
  const epoch = workerEpoch;
  const pendingWorker = (async () => {
    const previousWorker = cachedWorker?.worker;
    cachedWorker = null;
    if (previousWorker) await previousWorker.terminate();
    const { createWorker, PSM } = await import("tesseract.js");
    const worker = await createWorker(languages, undefined, {
      workerPath: `${OCR_ASSET_ROOT}/worker.min.js`,
      corePath: `${OCR_ASSET_ROOT}/core`,
      langPath: `${OCR_ASSET_ROOT}/lang`,
      logger(message: TesseractLoggerMessage) {
        activeProgress?.listener({
          stage: message.status,
          progress: message.progress,
        });
      },
    });
    if (epoch !== workerEpoch) {
      await worker.terminate().catch(() => undefined);
      throw new DOMException("OCR worker was recycled.", "AbortError");
    }
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    });
    if (epoch !== workerEpoch) {
      await worker.terminate().catch(() => undefined);
      throw new DOMException("OCR worker was recycled.", "AbortError");
    }
    cachedWorker = { languages, worker };
    return worker;
  })();
  workerPromise = pendingWorker;
  try {
    return await pendingWorker;
  } finally {
    if (workerPromise === pendingWorker) workerPromise = null;
  }
}

async function recycleWorker(): Promise<void> {
  workerEpoch += 1;
  const worker = cachedWorker?.worker;
  cachedWorker = null;
  workerPromise = null;
  if (worker) await worker.terminate().catch(() => undefined);
}
