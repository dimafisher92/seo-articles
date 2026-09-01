import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

import { sleep } from "@seo/shared";

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

export type RunOptions = {
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  /** Built-in tools the stage may use. Omit for a pure reasoning stage. */
  tools?: string[];
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

/** Text of the tool results in one user message, if it carries any. */
function lastToolResultText(message: unknown): string | undefined {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block !== "object" ||
      block === null ||
      (block as { type?: string }).type !== "tool_result"
    ) {
      continue;
    }

    const inner = (block as { content?: unknown }).content;
    if (typeof inner === "string") {
      parts.push(inner);
    } else if (Array.isArray(inner)) {
      for (const piece of inner) {
        const text = (piece as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }

  const joined = parts.join(" ").trim();
  return joined || undefined;
}

/** Enough of a rejection to act on, not a whole article echoed into a log. */
function truncateForLog(text: string, max = 600): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

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
    permissionMode: "bypassPermissions",
    maxTurns: options.maxTurns ?? (options.tools?.length ? 40 : 4),
    outputFormat: { type: "json_schema", schema: options.schema },
    env: buildEnv(),
    // The worker runs from a scratch directory; no repository context is wanted.
    cwd: process.cwd(),
  };

  /**
   * The last thing the run was told, kept for the error message.
   *
   * Under `outputFormat` the SDK hands the model a structured-output tool and
   * re-prompts it on a schema mismatch, up to five times. When those run out
   * all it reports is "Failed to provide valid structured output after 5
   * attempts" — the same sentence whether the JSON was truncated or a field was
   * the wrong shape. The rejection itself comes back as a tool result in the
   * stream, which this loop was discarding, so the one fact worth having was
   * being thrown away on every failure.
   */
  let lastToolResult: string | undefined;

  try {
    for await (const message of query({ prompt, options: sdkOptions })) {
      if (message.type === "user") {
        const text = lastToolResultText(message);
        if (text) lastToolResult = text;
        continue;
      }

      if (message.type !== "result") continue;

      if (message.subtype !== "success") {
        const errors =
          "errors" in message && message.errors.length > 0
            ? message.errors.join("; ")
            : "";
        // Which limit was hit is half the diagnosis, and the subtypes carry it.
        const detail = [message.subtype, errors].filter(Boolean).join(": ");
        const because = lastToolResult
          ? ` — last rejection: ${truncateForLog(lastToolResult)}`
          : "";

        throw new ClaudeStageError(
          `Stage ${options.label} failed: ${detail}${because}`,
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

export { sleep };
