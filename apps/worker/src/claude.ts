import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

import { config, assertClaudeCredentials } from "./config.js";
import { log } from "./log.js";

/**
 * Thin wrapper over the Agent SDK for one-shot, schema-validated stages.
 *
 * Each pipeline stage is its own `query()` call returning JSON that matches a
 * schema, rather than one long agentic run. Stages are individually
 * retryable, their outputs are inspectable in the database, and a bad draft
 * does not cost a fresh SERP crawl.
 */

/** Remote MCP servers are the only kind a stage may reach. */
export type McpHttpServers = Record<string, { type: "http"; url: string }>;

export type RunOptions = {
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  /** Built-in tools the stage may use. Omit for a pure reasoning stage. */
  tools?: string[];
  /**
   * MCP servers whose tools the stage may call, keyed by server name. Their
   * tools arrive as `mcp__<server>__<tool>` and are independent of `tools`,
   * which governs only the built-in set — so a stage can reach an MCP server
   * without also gaining Bash or WebSearch.
   */
  mcpServers?: McpHttpServers;
  model?: string;
  maxTurns?: number;
  /** Aborts the stage if it runs away. */
  timeoutMs?: number;
  label: string;
};

export class ClaudeStageError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ClaudeStageError";
  }
}

const RATE_LIMIT_PATTERN =
  /rate.?limit|429|overloaded|529|usage limit|quota|too many requests/i;

function isRateLimit(message: string): boolean {
  return RATE_LIMIT_PATTERN.test(message);
}

/** Web research stages need these; reasoning-only stages get no tools at all. */
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch"];

function buildEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Whichever credential is configured wins; leaving the other set would let
  // the SDK silently bill the wrong account.
  if (config.claude.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.claude.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (config.claude.apiKey) {
    env.ANTHROPIC_API_KEY = config.claude.apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return env;
}

/**
 * Runs one stage and returns its structured output.
 *
 * The SDK enforces the schema itself and retries the model on a mismatch, so
 * callers get typed data rather than a string to parse.
 */
export async function runStage<T>(
  prompt: string,
  options: RunOptions,
): Promise<T> {
  assertClaudeCredentials();

  const controller = new AbortController();
  const timeout = options.timeoutMs ?? 15 * 60_000;
  const timer = setTimeout(() => controller.abort(), timeout);

  const started = Date.now();
  log.debug(`stage:${options.label} starting`);

  const sdkOptions: Options = {
    abortController: controller,
    model: options.model ?? config.claude.model,
    // Without this the SDK inherits the machine's own CLAUDE.md, skills and
    // permissions, which would make behaviour differ per developer laptop.
    settingSources: [],
    systemPrompt: undefined,
    tools: options.tools ?? [],
    ...(options.tools?.length ? { allowedTools: options.tools } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    permissionMode: "bypassPermissions",
    // A stage with tools of any kind needs room to call them; the tight
    // default is only right for pure reasoning.
    maxTurns:
      options.maxTurns ??
      (options.tools?.length || options.mcpServers ? 40 : 4),
    outputFormat: { type: "json_schema", schema: options.schema },
    env: buildEnv(),
    // The worker runs from a scratch directory; no repository context is wanted.
    cwd: process.cwd(),
  };

  try {
    for await (const message of query({ prompt, options: sdkOptions })) {
      if (message.type !== "result") continue;

      if (message.subtype !== "success") {
        const detail =
          "errors" in message && message.errors.length > 0
            ? message.errors.join("; ")
            : message.subtype;
        throw new ClaudeStageError(
          `Stage ${options.label} failed: ${detail}`,
          isRateLimit(detail) || message.subtype === "error_during_execution",
        );
      }

      if (message.structured_output === undefined) {
        throw new ClaudeStageError(
          `Stage ${options.label} returned no structured output`,
          true,
        );
      }

      log.debug(
        `stage:${options.label} done in ${Math.round((Date.now() - started) / 1000)}s ` +
          `(${message.num_turns} turns)`,
      );
      return message.structured_output as T;
    }

    throw new ClaudeStageError(
      `Stage ${options.label} ended without a result message`,
      true,
    );
  } catch (error) {
    if (error instanceof ClaudeStageError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      throw new ClaudeStageError(
        `Stage ${options.label} timed out after ${Math.round(timeout / 1000)}s`,
        true,
      );
    }
    throw new ClaudeStageError(
      `Stage ${options.label} failed: ${message}`,
      isRateLimit(message),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retries a stage with exponential backoff.
 *
 * Subscription rate limits are the expected failure here, not the exception —
 * article generation is token-heavy and a batch will hit them. Backing off and
 * waiting is nearly always right; failing the job would lose an expensive
 * partially-complete pipeline.
 */
export async function runStageWithRetry<T>(
  prompt: string,
  options: RunOptions,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runStage<T>(prompt, options);
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ClaudeStageError ? error.retryable : false;

      if (!retryable || attempt === maxAttempts) break;

      const backoffMs = Math.min(60_000 * 2 ** (attempt - 1), 15 * 60_000);
      log.warn(
        `stage:${options.label} attempt ${attempt} failed, retrying in ` +
          `${Math.round(backoffMs / 1000)}s — ${(error as Error).message}`,
      );
      await sleep(backoffMs);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
