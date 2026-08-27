import { config as loadEnv } from "dotenv";

loadEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const config = {
  /** Base URL of the Vercel deployment this worker pulls jobs from. */
  appUrl: required("APP_URL").replace(/\/+$/, ""),
  workerSecret: required("WORKER_SECRET"),
  /** Identifies this worker in `jobs.claimed_by`. */
  workerId: optional("WORKER_ID") ?? `worker-${process.pid}`,

  databaseUrl: required("DATABASE_URL"),

  /** Seconds between polls when the queue is empty. */
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 5),
  /** Seconds between heartbeats while a job runs. */
  heartbeatSeconds: Number(process.env.HEARTBEAT_SECONDS ?? 60),
  /**
   * How long one job may run before it is given up on.
   *
   * The heartbeat is on a timer and cannot tell whether work is advancing, so
   * without a deadline a job wedged inside a provider call reports itself alive
   * forever: the reaper leaves it be and it can be neither waited out nor
   * cancelled. Generous, because a full article with images legitimately takes
   * a while.
   */
  jobTimeoutMinutes: Number(process.env.JOB_TIMEOUT_MINUTES ?? 30),

  searchAtlas: {
    apiKey: optional("SEARCHATLAS_API_KEY"),
    /** Only if the account issues a JWT; the API key is enough on its own. */
    token: optional("SEARCHATLAS_TOKEN"),
    /**
     * SearchAtlas's whole programmatic surface is this one self-describing
     * endpoint — there are no REST routes to configure. `pnpm searchatlas:probe`
     * lists everything the account can call.
     */
    mcpUrl: optional("SEARCHATLAS_MCP_URL") ?? "https://mcp.searchatlas.com/mcp",
  },

  magnific: {
    apiKey: optional("MAGNIFIC_API_KEY"),
    /**
     * Which generation model to use. Pinned rather than chosen per image so
     * cost stays predictable and a client's articles share one visual
     * language. See MODELS in providers/magnific.ts for the options.
     */
    imageModel: optional("MAGNIFIC_IMAGE_MODEL"),
    /**
     * Magnific is the rebranded Freepik platform; api.freepik.com works with
     * the same key. The auth header name follows from this value.
     */
    baseUrl: optional("MAGNIFIC_BASE_URL") ?? "https://api.magnific.com",
  },

  claude: {
    /**
     * Long-lived OAuth token from `claude setup-token`, which bills against the
     * existing Claude subscription rather than API credits. Set
     * ANTHROPIC_API_KEY instead to fall back to metered API billing during a
     * burst — the SDK picks up whichever is present.
     */
    oauthToken: optional("CLAUDE_CODE_OAUTH_TOKEN"),
    apiKey: optional("ANTHROPIC_API_KEY"),
    model: optional("CLAUDE_MODEL") ?? "claude-opus-5",
    /** Cheaper model for mechanical stages such as clustering. */
    fastModel: optional("CLAUDE_FAST_MODEL") ?? "claude-sonnet-5",
  },
} as const;

export function assertClaudeCredentials(): void {
  if (!config.claude.oauthToken && !config.claude.apiKey) {
    throw new Error(
      "No Claude credentials. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, " +
        "or set ANTHROPIC_API_KEY to bill the API directly.",
    );
  }
}
