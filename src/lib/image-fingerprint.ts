import type { CatalogCard, ImageFingerprint, VisualMatch } from "./types";

const SAMPLE_SIZE = 32;
const HASH_SIZE = 8;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_EDGE = 2048;
const REFERENCE_TIMEOUT_MS = 3_000;
const DECODE_TIMEOUT_MS = 5_000;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function decodeBitmap(source: Blob): Promise<ImageBitmap> {
  return withTimeout(
    createImageBitmap(source, { imageOrientation: "from-image" }),
    DECODE_TIMEOUT_MS,
    "Image decoding timed out",
  );
}

/** Validate and cap user-provided pixels before OCR or fingerprint work. */
export async function prepareImageForRecognition(source: Blob): Promise<Blob> {
  if (!source.size) throw new Error("Image is empty");
  if (source.size > MAX_INPUT_BYTES) throw new Error("Image is too large");
  if (source.type && !SUPPORTED_IMAGE_TYPES.has(source.type.toLowerCase())) {
    throw new Error("Unsupported image type");
  }

  const bitmap = await decodeBitmap(source);
  try {
    if (!bitmap.width || !bitmap.height)
      throw new Error("Image dimensions are invalid");
    const scale = Math.min(
      1,
      MAX_INPUT_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    // Small, already-compressed images can go directly to the workers.
    if (scale === 1 && source.size <= 4 * 1024 * 1024) return source;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const resized = await withTimeout(
      new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.88),
      ),
      DECODE_TIMEOUT_MS,
      "Image resizing timed out",
    );
    if (!resized) throw new Error("Image resizing failed");
    return resized;
  } finally {
    bitmap.close();
  }
}

async function drawImage(
  source: Blob | string,
  size: number,
): Promise<ImageData> {
  const bitmap =
    typeof source === "string"
      ? await loadRemoteBitmap(source)
      : await decodeBitmap(source);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  return context.getImageData(0, 0, size, size);
}

async function loadRemoteBitmap(url: string): Promise<ImageBitmap> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFERENCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      mode: "cors",
      credentials: "omit",
      cache: "force-cache",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Reference image failed: ${response.status}`);
    const blob = await response.blob();
    if (!blob.size || blob.size > 8 * 1024 * 1024)
      throw new Error("Reference image size is invalid");
    return await decodeBitmap(blob);
  } finally {
    clearTimeout(timer);
  }
}

function luminance(data: ImageData): number[] {
  const values: number[] = [];
  for (let index = 0; index < data.data.length; index += 4) {
    values.push(
      data.data[index] * 0.299 +
        data.data[index + 1] * 0.587 +
        data.data[index + 2] * 0.114,
    );
  }
  return values;
}

function dct(values: number[], size: number, x: number, y: number): number {
  let sum = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      sum +=
        values[row * size + column] *
        Math.cos(((2 * column + 1) * x * Math.PI) / (2 * size)) *
        Math.cos(((2 * row + 1) * y * Math.PI) / (2 * size));
    }
  }
  return sum;
}

function perceptualHash(data: ImageData): string {
  const values = luminance(data);
  const coefficients: number[] = [];
  for (let y = 0; y < HASH_SIZE; y += 1) {
    for (let x = 0; x < HASH_SIZE; x += 1)
      coefficients.push(dct(values, SAMPLE_SIZE, x, y));
  }
  const comparable = coefficients.slice(1);
  const sorted = [...comparable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const bits = coefficients
    .map((value, index) => (index === 0 || value >= median ? "1" : "0"))
    .join("");
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

function rgbHash(data: ImageData): number[] {
  const buckets = 4;
  const values: number[] = [];
  const cellSize = data.width / buckets;
  for (let y = 0; y < buckets; y += 1) {
    for (let x = 0; x < buckets; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      const minX = Math.floor(x * cellSize);
      const maxX = Math.floor((x + 1) * cellSize);
      const minY = Math.floor(y * cellSize);
      const maxY = Math.floor((y + 1) * cellSize);
      for (let row = minY; row < maxY; row += 1) {
        for (let column = minX; column < maxX; column += 1) {
          const index = (row * data.width + column) * 4;
          red += data.data[index];
          green += data.data[index + 1];
          blue += data.data[index + 2];
          count += 1;
        }
      }
      values.push(red / count / 255, green / count / 255, blue / count / 255);
    }
  }
  return values.map((value) => Number(value.toFixed(4)));
}

export async function fingerprintImage(
  source: Blob | string,
): Promise<ImageFingerprint> {
  const data = await drawImage(source, SAMPLE_SIZE);
  return { perceptualHash: perceptualHash(data), rgbHash: rgbHash(data) };
}

export function hammingSimilarity(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) return 0;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const xor =
      Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    distance += xor.toString(2).replaceAll("0", "").length;
  }
  return 1 - distance / (left.length * 4);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return Math.max(
    0,
    Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)),
  );
}

export async function rerankWithReferenceImages(
  source: ImageFingerprint,
  cards: CatalogCard[],
): Promise<VisualMatch[]> {
  const results = await Promise.all(
    cards.slice(0, 8).map(async (card): Promise<VisualMatch | null> => {
      try {
        const reference =
          card.reference?.perceptualHash && card.reference.rgbHash
            ? {
                perceptualHash: card.reference.perceptualHash,
                rgbHash: card.reference.rgbHash,
              }
            : card.images?.small
              ? await fingerprintImage(card.images.small)
              : null;
        if (!reference) return null;
        const similarity =
          hammingSimilarity(source.perceptualHash, reference.perceptualHash) *
            0.68 +
          cosineSimilarity(source.rgbHash, reference.rgbHash) * 0.32;
        return { cardId: card.id, similarity, provider: "reference-image" };
      } catch {
        // Cross-origin image access is an optional enhancement, never a scan blocker.
        return null;
      }
    }),
  );
  return results.filter((result): result is VisualMatch => result !== null);
}
