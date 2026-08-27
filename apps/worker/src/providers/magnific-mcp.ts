import { query } from "@anthropic-ai/claude-agent-sdk";

import type {
  GenerateImageRequest,
  GeneratedImage,
  ImageProvider,
} from "@seo/shared";

import { ClaudeStageError, runStage, type McpHttpServers } from "../claude.js";
import { config } from "../config.js";
import { log } from "../log.js";

/**
 * Magnific driven through its remote MCP server.
 *
 * Preferred over the REST adapter because the server is self-describing: tool
 * schemas come from Magnific rather than being guessed at, there is no API key
 * to manage, and generation runs on the account's existing credits.
 *
 * ## Authentication
 *
 * The server uses OAuth, not a key. Authenticate once with:
 *
 *     claude mcp add --transport http magnific https://mcp.magnific.com
 *
 * The Agent SDK stores the resulting token in its credential store under a key
 * derived from the server name and a hash of `{type, url, headers}`. Declaring
 * the server here with *exactly* that name and URL produces the same key, so
 * the worker reuses the session — which is why both are constants rather than
 * configurable. A trailing slash, a different name or an extra header would
 * change the hash and present as `needs-auth`.
 *
 * The token lives in the credential store rather than `settings.json`, so the
 * worker's `settingSources: []` isolation does not hide it.
 *
 * ## Why one query per image
 *
 * MCP tools are invoked by the model, not by our code. Rather than hand the
 * image stage a free-running agent, each image gets its own tightly-scoped
 * call: we fix the prompt, aspect ratio, resolution and style reference, and
 * the schema demands a URL back. The model only executes the tool call. That
 * keeps `produceImages()` — and its per-image rows, failure isolation and
 * regenerate-from-the-editor path — exactly as it was.
 */

/** Must match `claude mcp add --transport http magnific https://mcp.magnific.com`. */
export const MCP_SERVER_NAME = "magnific";
export const MCP_URL = "https://mcp.magnific.com";

export const MAGNIFIC_MCP_SERVERS: McpHttpServers = {
  [MCP_SERVER_NAME]: { type: "http", url: MCP_URL },
};

/** The command to run when the server reports it is not authenticated. */
export const MCP_ADD_COMMAND = `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL}`;

const generatedImageSchema = {
  type: "object",
  properties: {
    imageUrl: {
      type: "string",
      description: "Direct public URL of the generated image.",
    },
    taskId: {
      type: ["string", "null"],
      description: "Magnific task or creation id, if the tool returned one.",
    },
    modelUsed: { type: ["string", "null"] },
  },
  required: ["imageUrl"],
  additionalProperties: false,
} as const;

type GenerateResult = {
  imageUrl: string;
  taskId?: string | null;
  modelUsed?: string | null;
};

function buildInstruction(request: GenerateImageRequest): string {
  const lines = [
    "Generate one image with the Magnific MCP tools.",
    "",
    "## Specification",
    `Prompt: ${request.prompt}`,
    `Aspect ratio: ${request.aspectRatio}`,
    `Resolution: ${request.resolution}`,
  ];

  if (config.magnific.imageModel) {
    lines.push(`Model: ${config.magnific.imageModel}`);
  }

  if (request.styleReferenceUrl) {
    lines.push(
      "",
      "## Style reference",
      `Match the visual style of this image — its palette, lighting and treatment: ${request.styleReferenceUrl}`,
      "Pass it to the generation tool as a style reference if the tool accepts one; otherwise describe that style in the prompt.",
      "The subject must still be what the prompt describes. The reference governs how it looks, not what it shows.",
    );
  }

  if (request.structureReferenceUrl) {
    lines.push(
      "",
      "## Composition reference",
      `Echo the composition of: ${request.structureReferenceUrl}`,
    );
  }

  lines.push(
    "",
    "## Rules",
    "- Generate exactly one image. Do not produce variations.",
    "- Use the specification above verbatim. Do not improve or reinterpret the prompt.",
    "- Do not generate video, and do not upscale the result.",
    "- Wait for generation to finish, then return the direct public URL of the image.",
    "",
    "Return JSON only, matching the required schema.",
  );

  return lines.join("\n");
}

export class MagnificMcpProvider implements ImageProvider {
  readonly name = "magnific-mcp";

  async generate(request: GenerateImageRequest): Promise<GeneratedImage> {
    const result = await runStage<GenerateResult>(buildInstruction(request), {
      schema: generatedImageSchema as unknown as Record<string, unknown>,
      label: "magnific-image",
      mcpServers: MAGNIFIC_MCP_SERVERS,
      // Enough turns for a call, a poll and a retry; not enough to wander.
      maxTurns: 14,
      timeoutMs: 8 * 60_000,
    });

    if (!result.imageUrl?.startsWith("http")) {
      throw new ClaudeStageError(
        `Magnific MCP returned no usable image URL (got ${JSON.stringify(result.imageUrl)}). ` +
          "If the tool returns image data rather than a link, this provider needs a " +
          "separate upload path.",
        false,
      );
    }

    return {
      taskId: result.taskId ?? "mcp",
      url: result.imageUrl,
    };
  }
}

/* ---------------------------------------------------------------- preflight */

export type McpHealth =
  | { status: "connected" }
  | { status: "needs-auth"; message: string }
  | { status: "failed"; message: string };

/** A health check must never be able to hold up the worker. */
const PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * Checks the MCP session at worker startup.
 *
 * Worth doing eagerly: without it an unauthenticated server surfaces as a
 * failure part-way through an article, after the SERP crawl and draft have
 * already been paid for. Here it costs one trivial call and names the exact
 * command to run.
 *
 * Hard-bounded, because `mcpServerStatus()` waits on the control-protocol
 * handshake and simply never settles when the CLI subprocess cannot start or
 * the server is unreachable. An unbounded check would leave the worker unable
 * to claim any job at all — far worse than not knowing the image transport is
 * healthy.
 */
export async function checkMagnificMcp(): Promise<McpHealth> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const session = query({
      prompt: "Reply with the single word: ok",
      options: {
        model: config.claude.fastModel,
        settingSources: [],
        tools: [],
        mcpServers: MAGNIFIC_MCP_SERVERS,
        permissionMode: "bypassPermissions",
        maxTurns: 1,
        abortController: controller,
      },
    });

    const timedOut = Symbol("timed-out");
    const statuses = await Promise.race([
      session.mcpServerStatus(),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), PREFLIGHT_TIMEOUT_MS);
      }),
    ]);

    // Stop the subprocess whichever way the race went; nothing further is read.
    controller.abort();

    if (statuses === timedOut) {
      return {
        status: "failed",
        message:
          `Could not reach Magnific MCP within ${PREFLIGHT_TIMEOUT_MS / 1000}s ` +
          `(${MCP_URL}). The network may be blocking it, or the Claude CLI may ` +
          "not have started.",
      };
    }

    const magnific = statuses.find((s) => s.name === MCP_SERVER_NAME);

    if (!magnific) {
      return {
        status: "failed",
        message: `The MCP server "${MCP_SERVER_NAME}" was not registered by the SDK.`,
      };
    }

    if (magnific.status === "connected") return { status: "connected" };

    if (magnific.status === "needs-auth") {
      return {
        status: "needs-auth",
        message:
          `Magnific MCP is not authenticated. Run:\n\n    ${MCP_ADD_COMMAND}\n\n` +
          "and complete the browser sign-in, then restart the worker. " +
          "The server name and URL must match exactly — that pairing is what " +
          "lets the worker reuse the session.",
      };
    }

    return {
      status: "failed",
      message: `Magnific MCP status: ${magnific.status}.`,
    };
  } catch (error) {
    controller.abort();
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Logs the preflight result. Never throws — a bad session is not fatal. */
export async function reportMagnificMcpHealth(): Promise<void> {
  const health = await checkMagnificMcp();

  if (health.status === "connected") {
    log.info(
      `Images: Magnific over MCP${config.magnific.imageModel ? ` · model ${config.magnific.imageModel}` : ""}`,
    );
    return;
  }

  // Articles still generate — they just fall back to the client's own photos,
  // so this is a warning rather than a refusal to start.
  log.warn(`Images: ${health.message}`);
  log.warn(
    "Until this is fixed, articles will only use images uploaded to the " +
      "Brand Vault. Set MAGNIFIC_TRANSPORT=rest with MAGNIFIC_API_KEY to use " +
      "the API-key adapter instead.",
  );
}
