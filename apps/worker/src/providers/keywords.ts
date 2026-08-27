import type { KeywordProvider } from "@seo/shared";

import { config } from "../config.js";
import { log } from "../log.js";
import { SearchAtlasProvider, TOOLS } from "./searchatlas.js";

/**
 * Builds the keyword provider from the environment.
 *
 * Split from the adapter for the same reason `images.ts` is split from
 * `magnific.ts`: reading the global config at import time makes a module
 * unimportable without APP_URL and a database, which puts the adapter out of
 * reach of tests and probes. Everything the adapter needs is injected.
 */
export function createKeywordProvider(): KeywordProvider | null {
  const { apiKey, token, mcpUrl } = config.searchAtlas;

  if (!apiKey && !token) {
    log.warn(
      "SEARCHATLAS_API_KEY is not set — keyword runs will have no volume or " +
        "difficulty data, and no content gap. Clustering still works.",
    );
    return null;
  }

  return new SearchAtlasProvider(
    { ...(apiKey ? { apiKey } : {}), ...(token ? { token } : {}) },
    mcpUrl,
  );
}

/** One line for the startup banner, matching the image provider's. */
export function describeKeywordProvider(): string {
  const { apiKey, token, mcpUrl } = config.searchAtlas;

  if (!apiKey && !token) {
    return "Keywords: none configured — no volume data, no content gap";
  }

  const overrides = Object.entries(TOOLS)
    .filter(([key]) => process.env[`SEARCHATLAS_TOOL_${key.toUpperCase()}`])
    .map(([key]) => key);

  return (
    `Keywords: SearchAtlas · ${new URL(mcpUrl).host}` +
    (overrides.length > 0 ? ` · custom tools: ${overrides.join(", ")}` : "")
  );
}
