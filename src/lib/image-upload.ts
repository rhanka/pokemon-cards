const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_UPLOAD_EDGE = 1_600;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const DECODE_TIMEOUT_MS = 5_000;
const CARD_ASPECT_RATIO = 63 / 88;
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
  return new Promise<ImageBitmap>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("Image decoding timed out"));
    }, DECODE_TIMEOUT_MS);
    void createImageBitmap(source, { imageOrientation: "from-image" }).then(
      (bitmap) => {
        if (settled) {
          bitmap.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(bitmap);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Decode locally, bound the surface and always re-encode to JPEG before
 * upload. Canvas encoding removes source EXIF/GPS metadata.
 */
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
    if (bitmap.width * bitmap.height > MAX_INPUT_PIXELS)
      throw new Error("Image dimensions are too large");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    const inputRatio = bitmap.width / bitmap.height;
    const cropWidth =
      inputRatio > CARD_ASPECT_RATIO
        ? bitmap.height * CARD_ASPECT_RATIO
        : bitmap.width;
    const cropHeight =
      inputRatio > CARD_ASPECT_RATIO
        ? bitmap.height
        : bitmap.width / CARD_ASPECT_RATIO;
    const cropX = (bitmap.width - cropWidth) / 2;
    const cropY = (bitmap.height - cropHeight) / 2;
    const longestEdge = Math.max(cropWidth, cropHeight);
    for (const edge of [MAX_UPLOAD_EDGE, 1_280, 1_024]) {
      const scale = Math.min(1, edge / longestEdge);
      canvas.width = Math.max(1, Math.round(cropWidth * scale));
      canvas.height = Math.max(1, Math.round(cropHeight * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        bitmap,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      for (const quality of [0.86, 0.74]) {
        const resized = await withTimeout(
          new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", quality),
          ),
          DECODE_TIMEOUT_MS,
          "Image resizing timed out",
        );
        if (!resized) throw new Error("Image resizing failed");
        if (resized.size <= MAX_UPLOAD_BYTES) return resized;
      }
    }
    throw new Error("Prepared image is too large");
  } finally {
    bitmap.close();
  }
}
