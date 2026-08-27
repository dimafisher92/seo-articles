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

  searchAtlas: {
    apiKey: optional("SEARCHATLAS_API_KEY"),
    baseUrl: optional("SEARCHATLAS_BASE_URL") ?? "https://api.searchatlas.com",
  },

  magnific: {
    apiKey: optional("MAGNIFIC_API_KEY"),
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
