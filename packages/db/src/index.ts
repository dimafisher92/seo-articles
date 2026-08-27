import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };

/**
 * One driver everywhere.
 *
 * postgres-js talks to any Postgres — Neon, Supabase, a local container — and
 * unlike Neon's HTTP driver it supports interactive transactions, which the
 * job queue needs. `prepare: false` is required behind a PgBouncer-style
 * pooler (Neon's `-pooler` host, Supabase's port 6543), which is how this runs
 * on Vercel.
 */
export type Database = ReturnType<typeof drizzle<typeof schema>>;

let cached: Database | undefined;
let cachedClient: ReturnType<typeof postgres> | undefined;

export function createDb(url = process.env.DATABASE_URL): Database {
  if (!url) throw new Error("DATABASE_URL is not set");

  // Serverless invocations are short-lived and concurrent; a small ceiling per
  // instance keeps the pooler from being swamped. The worker is a single
  // long-lived process and does not need more either.
  const max = Number(process.env.DATABASE_POOL_MAX ?? 5);

  cachedClient = postgres(url, {
    max,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  return drizzle(cachedClient, { schema });
}

/** Process-wide singleton, so Next.js hot reloads do not leak connections. */
export function getDb(): Database {
  cached ??= createDb();
  return cached;
}

export async function closeDb(): Promise<void> {
  await cachedClient?.end({ timeout: 5 });
  cachedClient = undefined;
  cached = undefined;
}
