import type { ImageFingerprint, RuntimeConfig, VisualMatch } from "./types";

type LocalVisionModule = {
  createCardMatcher(options: {
    modelUrl?: string;
    indexUrl?: string;
  }): Promise<{
    match(image: Blob, fingerprint: ImageFingerprint): Promise<VisualMatch[]>;
  }>;
};

export async function runOptionalLocalModel(
  image: Blob,
  fingerprint: ImageFingerprint,
  config: RuntimeConfig["vision"],
): Promise<VisualMatch[]> {
  if (!config.enabled || !config.moduleUrl) return [];
  try {
    const module = (await import(
      /* @vite-ignore */ config.moduleUrl
    )) as LocalVisionModule;
    const matcher = await module.createCardMatcher({
      modelUrl: config.modelUrl,
      indexUrl: config.indexUrl,
    });
    return (await matcher.match(image, fingerprint)).map((match) => ({
      ...match,
      provider: "local-model",
    }));
  } catch (error) {
    console.info(
      "Optional local vision model unavailable; OCR matching remains active.",
      error,
    );
    return [];
  }
}
