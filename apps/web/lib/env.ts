/**
 * Environment access with a single failure point.
 *
 * Deliberately not validated eagerly at import time: the Vercel build runs
 * without most runtime secrets, and a top-level throw would break `next build`.
 * Each accessor fails when the feature that needs it is actually used.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env.local or the Vercel project settings.`,
    );
  }
  return value;
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  /** Shared secret the local worker presents on /api/worker/*. */
  get workerSecret(): string {
    return required("WORKER_SECRET");
  },
  get blobToken(): string {
    return required("BLOB_READ_WRITE_TOKEN");
  },
  get notionToken(): string {
    return required("NOTION_TOKEN");
  },
  get notionClientsDbId(): string {
    return required("NOTION_CLIENTS_DATABASE_ID");
  },
  /**
   * Protects `/api/cron/reap`. Optional: stale-job recovery runs on the claim
   * endpoint, so that route is a manual convenience. Unset means nobody can
   * call it, which is the right default for a secret that guards a mutation.
   */
  get cronSecret(): string | null {
    return process.env.CRON_SECRET || null;
  },
  /**
   * Comma-separated email domains allowed to sign in. Empty means any Google
   * account can — fine for a solo install, risky for a shared deployment.
   */
  get allowedEmailDomains(): string[] {
    return (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  },
  get allowedEmails(): string[] {
    return (process.env.ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Disables auth entirely — local development only. */
  get authDisabled(): boolean {
    return process.env.AUTH_DISABLED === "true";
  },
} as const;

export function isConfigured(name: string): boolean {
  return Boolean(process.env[name]);
}
