import type { ImageProvider } from "@seo/shared";

import { config } from "../config.js";
import { log } from "../log.js";
import { MagnificProvider } from "./magnific.js";
import { MagnificMcpProvider, MCP_ADD_COMMAND } from "./magnific-mcp.js";

export type ImageTransport = "mcp" | "rest" | "none";

/**
 * Decides which image transport to use.
 *
 * Split out from the factory so the precedence is testable without
 * manipulating the environment: MCP is the default because the server is
 * self-describing, needs no key, and exposes far more models than the REST
 * endpoint. REST is an explicit opt-out for the case MCP cannot cover — a
 * worker running somewhere a one-time browser OAuth flow is impractical.
 *
 * `none` is a supported outcome, not a failure: articles then use only the
 * images uploaded to the client's Brand Vault.
 */
export function selectImageTransport(input: {
  transport: string;
  hasApiKey: boolean;
}): ImageTransport {
  if (input.transport === "rest") {
    return input.hasApiKey ? "rest" : "none";
  }
  return "mcp";
}

export function createImageProvider(): ImageProvider | null {
  const transport = selectImageTransport({
    transport: config.magnific.transport,
    hasApiKey: Boolean(config.magnific.apiKey),
  });

  switch (transport) {
    case "rest":
      return new MagnificProvider(config.magnific.apiKey!);

    case "mcp":
      // Whether the session is actually authenticated is reported separately
      // by the startup preflight; constructing the provider does not prove it.
      log.debug(
        `Image provider: Magnific over MCP (authenticate with: ${MCP_ADD_COMMAND})`,
      );
      return new MagnificMcpProvider();

    case "none":
      log.warn(
        "MAGNIFIC_TRANSPORT=rest but MAGNIFIC_API_KEY is not set — articles " +
          "will only use uploaded brand assets.",
      );
      return null;
  }
}
