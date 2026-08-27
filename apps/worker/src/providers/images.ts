import type { ImageProvider } from "@seo/shared";

import { config } from "../config.js";
import { log } from "../log.js";
import { MagnificProvider, resolveModel } from "./magnific.js";

/**
 * Builds the image provider, or returns null when no key is configured.
 *
 * Null is a supported outcome rather than a failure: articles then use only the
 * photos uploaded to the client's Brand Vault, which is a reasonable way to
 * work and keeps a missing key from blocking the whole pipeline.
 */
export function createImageProvider(): ImageProvider | null {
  if (!config.magnific.apiKey) {
    log.warn(
      "MAGNIFIC_API_KEY is not set — articles will only use uploaded brand assets.",
    );
    return null;
  }
  return new MagnificProvider(
    config.magnific.apiKey,
    config.magnific.baseUrl,
    config.magnific.imageModel,
  );
}

/** One line for the startup banner, so the model in use is never a guess. */
export function describeImageProvider(): string {
  if (!config.magnific.apiKey) {
    return "Images: none configured — brand assets only";
  }
  try {
    const model = resolveModel(config.magnific.imageModel);
    return `Images: Magnific · ${model.label} (${model.costNote})`;
  } catch (error) {
    return `Images: ${error instanceof Error ? error.message : String(error)}`;
  }
}
